import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const agents = {
  http: new http.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 32 }),
  https: new https.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 32 })
};

export interface LongFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

function abortError() {
  const e: any = new Error('The operation was aborted');
  e.name = 'AbortError';
  e.code = 'ABORT_ERR';
  return e;
}

/**
 * fetch() replacement built on node:http(s) for streaming model responses.
 *
 * Node's built-in fetch (undici) gives up on a response after 300 s without new bytes
 * (headersTimeout / bodyTimeout) and reports it as "terminated". Slow local models routinely
 * go quiet for longer than that (prompt processing on a CPU, a large file being generated
 * inside one tool call), and so do long-thinking remote models. This variant has no idle
 * timeouts at all: only the AbortSignal (Stop button) ends a request.
 */
export function longFetch(url: string, init: LongFetchInit = {}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) return reject(abortError());
    let u: URL;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const body = init.body !== undefined ? Buffer.from(init.body, 'utf8') : undefined;
    const headers: Record<string, string> = { ...(init.headers || {}) };
    if (body) headers['Content-Length'] = String(body.length);
    const method = (init.method || (body ? 'POST' : 'GET')).toUpperCase();
    let settled = false;
    const onAbort = () => req.destroy(abortError());
    const cleanup = () => init.signal?.removeEventListener('abort', onAbort);
    const req = lib.request(u, { method, headers, agent: isHttps ? agents.https : agents.http }, (res) => {
      settled = true;
      res.once('close', cleanup);
      res.on('error', () => {
        /* reported through the web stream; never crash the main process */
      });
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        try {
          if (Array.isArray(v)) for (const x of v) h.append(k, x);
          else if (v !== undefined) h.set(k, String(v));
        } catch {
          /* header with characters Headers() rejects — not needed */
        }
      }
      let status = res.statusCode || 502;
      if (status < 200 || status > 599) status = 502;
      const noBody = status === 204 || status === 205 || status === 304 || method === 'HEAD';
      if (noBody) res.resume();
      try {
        resolve(new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage || '', headers: h }));
      } catch (e) {
        res.destroy();
        reject(e);
      }
    });
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => {
      if (settled) return; // errors after the response started surface through the body stream
      settled = true;
      cleanup();
      reject(init.signal?.aborted ? abortError() : e);
    });
    req.end(body);
  });
}

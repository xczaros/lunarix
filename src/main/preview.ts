import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { onFsChange } from './fsService';
import { isSubPath, toPosix } from './util';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json'
};

const RELOAD_SNIPPET = `<script>(function(){try{var es=new EventSource('/__lunarix_reload');es.onmessage=function(){location.reload()};}catch(e){}})();</script>`;

interface PreviewServer {
  server: http.Server;
  port: number;
  clients: Set<http.ServerResponse>;
}
const servers = new Map<string, PreviewServer>();
let hooked = false;

function hook() {
  if (hooked) return;
  hooked = true;
  onFsChange((root) => {
    for (const [r, s] of servers) {
      if (isSubPath(r, root) || isSubPath(root, r)) {
        for (const c of s.clients) {
          try {
            c.write('data: reload\n\n');
          } catch {
            /* closed */
          }
        }
      }
    }
  });
}

async function serve(root: string, req: http.IncomingMessage, res: http.ServerResponse, s: PreviewServer) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/__lunarix_reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    s.clients.add(res);
    req.on('close', () => s.clients.delete(res));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  let target = path.resolve(root, '.' + rel);
  if (!isSubPath(root, target)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    let st = await fsp.stat(target);
    if (st.isDirectory()) {
      const idx = path.join(target, 'index.html');
      if (fs.existsSync(idx)) {
        if (!rel.endsWith('/')) {
          res.writeHead(302, { Location: rel + '/' }).end();
          return;
        }
        target = idx;
        st = await fsp.stat(target);
      } else {
        const entries = await fsp.readdir(target, { withFileTypes: true });
        const items = entries
          .map((e) => `<li><a href="${encodeURI(toPosix(path.posix.join(rel, e.name)))}${e.isDirectory() ? '/' : ''}">${e.name}${e.isDirectory() ? '/' : ''}</a></li>`)
          .join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>${rel}</title><style>body{font:14px system-ui;background:#0b0b0b;color:#ddd;padding:24px}a{color:#fff}</style><h3>${rel}</h3><ul>${items}</ul>${RELOAD_SNIPPET}`);
        return;
      }
    }
    const ext = path.extname(target).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    if (ext === '.html' || ext === '.htm') {
      let html = await fsp.readFile(target, 'utf8');
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, RELOAD_SNIPPET + '</body>') : html + RELOAD_SNIPPET;
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;background:#0b0b0b;color:#999;padding:24px">404 — ${rel}</body>${RELOAD_SNIPPET}`);
  }
}

async function ensureServer(root: string): Promise<PreviewServer> {
  hook();
  const key = path.resolve(root);
  const existing = servers.get(key);
  if (existing) return existing;
  const s: PreviewServer = { server: null as any, port: 0, clients: new Set() };
  s.server = http.createServer((req, res) => {
    serve(key, req, res, s).catch(() => {
      try {
        res.writeHead(500).end();
      } catch {
        /* ignore */
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    s.server.once('error', reject);
    s.server.listen(0, '127.0.0.1', () => resolve());
  });
  s.port = (s.server.address() as AddressInfo).port;
  servers.set(key, s);
  return s;
}

export async function previewUrl(root: string, file?: string): Promise<string> {
  const s = await ensureServer(root);
  let rel = '';
  if (file) {
    const abs = path.resolve(root, file);
    if (isSubPath(root, abs)) rel = toPosix(path.relative(root, abs));
  }
  return `http://127.0.0.1:${s.port}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export function stopPreviewServers() {
  for (const s of servers.values()) {
    for (const c of s.clients) {
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
    s.server.close();
  }
  servers.clear();
}

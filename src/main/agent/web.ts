import { UA } from '../download';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®' };

export function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isNaN(code) ? m : String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Very small HTML → readable text/markdown converter. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim());
  let s = html;
  s = s.replace(/<(script|style|noscript|svg|iframe|template|canvas)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(s);
  if (main && main[2].length > 600) s = main[2];
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n\n${'#'.repeat(Number(n))} ${t}\n\n`);
  s = s.replace(/<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
    const txt = t.replace(/<[^>]+>/g, '').trim();
    return txt && !href.startsWith('javascript') ? `[${txt}](${href})` : txt;
  });
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<(pre)[^>]*>([\s\S]*?)<\/pre>/gi, (_m, _t, c) => `\n\`\`\`\n${c.replace(/<[^>]+>/g, '')}\n\`\`\`\n`);
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => `\`${c.replace(/<[^>]+>/g, '')}\``);
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|tr|table|ul|ol|header|footer|nav|blockquote|h\d)>/gi, '\n');
  s = s.replace(/<t[dh][^>]*>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: s };
}

export async function webFetch(url: string, signal?: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8', 'Accept-Language': 'pl,en;q=0.8' }, signal: ctrl.signal, redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    const header = `URL: ${res.url}\nStatus: ${res.status}\nContent-Type: ${type}\n`;
    if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body)) {
      const { title, text } = htmlToText(body);
      return `${header}Title: ${title}\n\n${text.slice(0, 40000)}${text.length > 40000 ? '\n…[truncated]' : ''}`;
    }
    return `${header}\n${body.slice(0, 40000)}${body.length > 40000 ? '\n…[truncated]' : ''}`;
  } finally {
    clearTimeout(t);
  }
}

export async function webSearch(query: string, signal?: AbortSignal): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
      signal: ctrl.signal
    });
    const html = await res.text();
    const results: { title: string; url: string; snippet: string }[] = [];
    const blockRe = /<div class="result[^"]*results_links[^"]*"[\s\S]*?(?=<div class="result[^"]*results_links|<\/body>)/g;
    const blocks = html.match(blockRe) || [];
    for (const b of blocks) {
      const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
      if (!a) continue;
      let href = decodeEntities(a[1]);
      const uddg = /[?&]uddg=([^&]+)/.exec(href);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (href.startsWith('//')) href = 'https:' + href;
      if (/duckduckgo\.com\/y\.js|ad_domain/.test(href)) continue;
      const sn = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b) || /<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/.exec(b);
      results.push({
        title: decodeEntities(a[2].replace(/<[^>]+>/g, '')).trim(),
        url: href,
        snippet: sn ? decodeEntities(sn[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : ''
      });
      if (results.length >= 8) break;
    }
    if (!results.length) return `No results found for "${query}".`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
  } finally {
    clearTimeout(t);
  }
}

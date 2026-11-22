import { Marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code(token: any) {
      const text: string = token.text ?? '';
      const lang = String(token.lang || '')
        .trim()
        .split(/\s+/)[0]
        .toLowerCase();
      let html: string;
      try {
        if (text.length > 30000) html = esc(text);
        else if (lang && hljs.getLanguage(lang)) html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
        else html = text.length < 4000 ? hljs.highlightAuto(text).value : esc(text);
      } catch {
        html = esc(text);
      }
      return `<pre><div class="code-head"><span class="lang">${esc(lang || 'text')}</span><button class="icon-btn sm" data-copy="1" title="Copy">${COPY_ICON}</button></div><code class="hljs">${html}</code></pre>`;
    },
    link(token: any) {
      const href = String(token.href || '');
      const title = token.title ? ` title="${esc(token.title)}"` : '';
      const inner = this.parser.parseInline(token.tokens || []);
      return `<a href="${esc(href)}" data-href="${esc(href)}"${title}>${inner}</a>`;
    }
  }
});

DOMPurify.addHook('afterSanitizeAttributes', (node: any) => {
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (!/^(data:image\/|app:)/i.test(src)) {
      node.setAttribute('data-blocked-src', src);
      node.removeAttribute('src');
      node.setAttribute('alt', '[image blocked]');
    }
  }
});

const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  if (!src) return '';
  const hit = cache.get(src);
  if (hit) return hit;
  let html: string;
  try {
    html = marked.parse(src, { async: false }) as string;
  } catch {
    html = `<p>${esc(src)}</p>`;
  }
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-copy', 'data-href', 'target'],
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'textarea', 'select', 'object', 'embed', 'link', 'meta', 'base', 'script'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style']
  }) as unknown as string;
  if (cache.size > 400) cache.clear();
  cache.set(src, clean);
  return clean;
}

export function highlightCode(code: string, lang?: string): string {
  try {
    if (code.length > 60000) return esc(code);
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    return esc(code);
  } catch {
    return esc(code);
  }
}

export function langFromPath(p: string): string {
  const ext = (p.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', php: 'php', cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'cpp', c: 'c',
    java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', swift: 'swift', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', scss: 'scss', less: 'less', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml',
    sh: 'bash', bash: 'bash', ps1: 'powershell', bat: 'dos', cmd: 'dos', sql: 'sql', lua: 'lua', dart: 'dart', ini: 'ini', toml: 'ini', dockerfile: 'dockerfile', r: 'r'
  };
  return map[ext] || '';
}

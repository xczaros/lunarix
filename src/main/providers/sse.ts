/** Minimal, robust Server-Sent Events reader for fetch() response bodies. */
export async function* readSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let event: string | undefined;
  let dataLines: string[] = [];
  let finished = false;
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 2 : 1));
        if (line === '') {
          if (dataLines.length) {
            yield { event, data: dataLines.join('\n') };
          }
          event = undefined;
          dataLines = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') dataLines.push(value);
        else if (field === 'event') event = value;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      for (const line of buf.split(/\r?\n/)) if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) yield { event, data: dataLines.join('\n') };
  } finally {
    // stopped early (error, abort, consumer broke out): close the connection instead of leaving it half-read
    if (!finished) reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** Splits streamed text into visible text and <think>...</think> reasoning. */
export class ThinkSplitter {
  private inThink = false;
  private pending = '';
  constructor(private onText: (s: string) => void, private onThink: (s: string) => void, startInThink = false) {
    this.inThink = startInThink;
  }
  push(chunk: string) {
    this.pending += chunk;
    for (;;) {
      if (this.inThink) {
        const end = this.pending.indexOf('</think>');
        if (end >= 0) {
          if (end > 0) this.onThink(this.pending.slice(0, end));
          this.pending = this.pending.slice(end + 8);
          this.inThink = false;
          continue;
        }
        const keep = partialSuffix(this.pending, '</think>');
        const emit = this.pending.slice(0, this.pending.length - keep);
        if (emit) this.onThink(emit);
        this.pending = this.pending.slice(this.pending.length - keep);
        return;
      } else {
        const start = this.pending.indexOf('<think>');
        if (start >= 0) {
          if (start > 0) this.onText(this.pending.slice(0, start));
          this.pending = this.pending.slice(start + 7);
          this.inThink = true;
          continue;
        }
        const keep = partialSuffix(this.pending, '<think>');
        const emit = this.pending.slice(0, this.pending.length - keep);
        if (emit) this.onText(emit);
        this.pending = this.pending.slice(this.pending.length - keep);
        return;
      }
    }
  }
  flush() {
    if (this.pending) {
      if (this.inThink) this.onThink(this.pending);
      else this.onText(this.pending);
    }
    this.pending = '';
  }
}

function partialSuffix(s: string, tag: string) {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

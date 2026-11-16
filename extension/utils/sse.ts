/**
 * Minimal Server-Sent Events reader for fetch() response bodies (EventSource cannot send an
 * Authorization header). Implements the parts of the SSE format the API uses: `data:` lines
 * (possibly several per event, possibly split across network chunks), `event:` names, blank-line
 * dispatch, and `:` comments (keep-alive pings).
 */

export interface SseHandlers {
  onEvent: (data: string, event: string) => void;
  onComment?: (text: string) => void;
}

export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';

  constructor(private readonly handlers: SseHandlers) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.handlers.onEvent(this.data.join('\n'), this.event || 'message');
      this.data = [];
      this.event = '';
      return;
    }
    if (line.startsWith(':')) {
      this.handlers.onComment?.(line.slice(1).trim());
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    // `id` and `retry` are not used by the API.
  }
}

/** Reads `body` until it ends or `signal` aborts. Resolves on a clean end of stream. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  handlers: SseHandlers,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(handlers);
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

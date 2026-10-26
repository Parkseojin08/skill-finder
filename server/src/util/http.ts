export const USER_AGENT = 'skill-finder/0.1 (+local)';

export type TextResult = { status: number; text: string | null; truncated: boolean; etag: string | null };

/** GET with a timeout and a byte cap; `text` is null on non-2xx. */
export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {},
): Promise<TextResult> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...opts.headers },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    redirect: 'follow',
  });
  const etag = res.headers.get('etag');
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, text: null, truncated: false, etag };
  }
  const max = opts.maxBytes ?? 2 * 1024 * 1024;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      truncated = true;
      chunks.push(value.subarray(0, value.byteLength - (size - max)));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return { status: res.status, text: Buffer.concat(chunks).toString('utf8'), truncated, etag };
}

/** Heuristic binary check: NUL bytes or a high share of replacement characters. */
export function looksBinary(text: string): boolean {
  if (text.includes('\u0000')) return true;
  const sample = text.slice(0, 4096);
  const bad = (sample.match(/�/g) ?? []).length;
  return sample.length > 0 && bad / sample.length > 0.02;
}

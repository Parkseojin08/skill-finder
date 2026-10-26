export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Token bucket refilled continuously; `take()` waits until a token is available. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private readonly capacity: number;
  private readonly perMs: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(perMinute: number) {
    this.capacity = perMinute;
    this.tokens = perMinute;
    this.perMs = perMinute / 60_000;
  }

  private refill() {
    const t = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.perMs);
    this.last = t;
  }

  /** Milliseconds until a token would be available (0 = now). */
  waitTime(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.perMs);
  }

  take(): Promise<void> {
    const next = this.queue.then(async () => {
      let wait = this.waitTime();
      while (wait > 0) {
        await sleep(wait);
        wait = this.waitTime();
      }
      this.tokens -= 1;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

/** At most `limit` holders at once across all callers (e.g. raw GitHub downloads from many lookups). */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Runs `fn` over items with bounded concurrency; results keep input order. Errors are returned, not thrown. */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown } | undefined>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown } | undefined> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (shouldStop?.()) return;
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'timeout'): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

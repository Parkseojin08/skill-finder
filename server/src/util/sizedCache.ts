/**
 * A cache of promises bounded by the total size of what they hold (tree entries), not by their count: one giant
 * repo tree weighs as much as hundreds of small ones, and a count cap let a popular-repo collection keep 157MB of
 * trees until the app quit (perf debate 1-3). The least recently used entry goes first and every entry expires
 * after `ttlMs`. A rejected promise is dropped. The newest entry stays even when it alone is over the limit,
 * until the next one arrives.
 */
export class SizedCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; size: number; at: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly sizeOf: (value: T) => number;
  private readonly now: () => number;
  private total = 0;

  constructor(opts: { maxSize: number; ttlMs: number; sizeOf: (value: T) => number; now?: () => number }) {
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
    this.sizeOf = opts.sizeOf;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): Promise<T> | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) {
      this.remove(key);
      return undefined;
    }
    // most recently used last
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  set(key: string, value: Promise<T>): void {
    this.remove(key);
    const e = { value, size: 0, at: this.now() };
    this.entries.set(key, e);
    value.then(
      (v) => {
        if (this.entries.get(key) !== e) return; // replaced or dropped meanwhile
        e.size = this.sizeOf(v);
        this.total += e.size;
        this.evict(key);
      },
      () => {
        if (this.entries.get(key) === e) this.entries.delete(key);
      },
    );
  }

  /** Entries held and their total size (for tests and diagnostics). */
  stats(): { count: number; size: number } {
    return { count: this.entries.size, size: this.total };
  }

  private remove(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.total -= e.size;
    this.entries.delete(key);
  }

  private evict(keep: string): void {
    const now = this.now();
    for (const [k, e] of this.entries) {
      if (k !== keep && now - e.at > this.ttlMs) this.remove(k);
    }
    for (const [k, e] of this.entries) {
      if (this.total <= this.maxSize) break;
      // a pending entry weighs nothing yet: dropping it would free nothing
      if (k !== keep && e.size > 0) this.remove(k);
    }
  }
}

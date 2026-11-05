import { randomUUID } from 'node:crypto';

export type JobStatus = 'running' | 'paused' | 'done' | 'error' | 'cancelled';

export type Job = {
  id: string;
  kind: 'sync' | 'collect';
  label: string;
  status: JobStatus;
  done: number;
  total: number;
  errors: string[];
  /** Items that cannot be processed as listed (e.g. a deleted repo); not failures of this app. */
  skipped: string[];
  startedAt: string;
  finishedAt: string | null;
};

export type JobControl = {
  /** Resolves immediately, or once the job is resumed; throws if cancelled. */
  checkpoint(): Promise<void>;
  readonly cancelled: boolean;
  setTotal(n: number): void;
  addTotal(n: number): void;
  tick(error?: string): void;
  skip(note: string): void;
};

class CancelledError extends Error {}

/** A job starting or ending, for whoever records runs (the scheduler writes them to task_runs, feature review F22). */
export type JobEvent = { phase: 'start' | 'finish'; job: Job; error?: unknown };

type Entry = { job: Job; paused: boolean; cancelled: boolean; waiters: Array<() => void>; done: Promise<void> };

export class Jobs {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(e: JobEvent) => void>();

  /** Called on every job's start (synchronously, inside start()) and end; returns a function that stops it. */
  observe(listener: (e: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: JobEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.warn('[jobs]', String((err as Error).message ?? err).slice(0, 200));
      }
    }
  }

  /** Resolves with the job once it has ended (also when it already has, while it is still kept). */
  async wait(id: string): Promise<Job | undefined> {
    const e = this.entries.get(id);
    if (!e) return undefined;
    await e.done;
    return e.job;
  }

  start(kind: Job['kind'], label: string, fn: (ctl: JobControl) => Promise<void>): Job {
    const job: Job = {
      id: randomUUID(),
      kind,
      label,
      status: 'running',
      done: 0,
      total: 0,
      errors: [],
      skipped: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    const entry: Entry = { job, paused: false, cancelled: false, waiters: [], done: Promise.resolve() };
    this.entries.set(job.id, entry);
    this.emit({ phase: 'start', job });
    const ctl: JobControl = {
      checkpoint: async () => {
        while (entry.paused && !entry.cancelled) await new Promise<void>((r) => entry.waiters.push(r));
        if (entry.cancelled) throw new CancelledError('cancelled');
      },
      get cancelled() {
        return entry.cancelled;
      },
      setTotal: (n) => {
        job.total = n;
      },
      addTotal: (n) => {
        job.total += n;
      },
      tick: (error) => {
        job.done++;
        if (error && job.errors.length < 200) job.errors.push(error);
      },
      skip: (note) => {
        job.done++;
        if (job.skipped.length < 200) job.skipped.push(note);
      },
    };
    let failure: unknown;
    let started: Promise<void>;
    try {
      started = fn(ctl); // synchronously, as before: its first steps run inside start()
    } catch (err) {
      started = Promise.reject(err);
    }
    entry.done = started
      .then(() => {
        job.status = entry.cancelled ? 'cancelled' : 'done';
      })
      .catch((err) => {
        if (err instanceof CancelledError || entry.cancelled) job.status = 'cancelled';
        else {
          job.status = 'error';
          job.errors.push(String((err as Error).message ?? err));
          failure = err;
        }
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this.emit({ phase: 'finish', job, error: failure });
        this.prune();
      });
    return job;
  }

  get(id: string): Job | undefined {
    return this.entries.get(id)?.job;
  }

  list(): Job[] {
    return [...this.entries.values()].map((e) => e.job).reverse();
  }

  active(kind: Job['kind'], label: string): Job | undefined {
    return this.list().find((j) => j.kind === kind && j.label === label && (j.status === 'running' || j.status === 'paused'));
  }

  pause(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.job.status !== 'running') return false;
    e.paused = true;
    e.job.status = 'paused';
    return true;
  }

  resume(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.job.status !== 'paused') return false;
    e.paused = false;
    e.job.status = 'running';
    for (const w of e.waiters.splice(0)) w();
    return true;
  }

  cancel(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || (e.job.status !== 'running' && e.job.status !== 'paused')) return false;
    e.cancelled = true;
    for (const w of e.waiters.splice(0)) w();
    return true;
  }

  private prune() {
    const finished = [...this.entries.values()].filter((e) => e.job.finishedAt);
    for (const e of finished.slice(0, Math.max(0, finished.length - 20))) this.entries.delete(e.job.id);
  }
}

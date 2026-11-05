// One scheduler for every background task (feature review B2). Tasks register once (registerTask); every 5 minutes
// the ones that are due run, each run is written to task_runs (kept 30 days) and its outcome to task_state. A task
// that fails waits 5 min → 15 min → 1 h → 6 h before the next try (never longer than its own period), whatever
// broke: a cut-short JSON answer and a dropped connection are tried again like any other error (P5).
//
// Network errors in a row (ENOTFOUND, ECONNREFUSED, ...) mean the PC is offline: network tasks wait, a cheap probe
// asks every minute whether the network is back, and once it is, the tasks that failed or fell due meanwhile run at
// once (P10: a start without network used to leave the marketplace sync for 24 hours).
//
// The sync and collect jobs (jobs.ts, the ones with progress on screen) stay as they are; their runs are written to
// task_runs too, as part of the task that started them or as runs of their own.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppContext } from './context.ts';
import type { Job, JobEvent } from './jobs.ts';
import { searchActivity } from './search/activity.ts';
import { maskSecrets } from './util/log.ts';

export type TaskTrigger = 'startup' | 'schedule' | 'manual';
export type TaskRunStatus = 'running' | 'ok' | 'failed' | 'skipped';
export type TaskRunInfo = { trigger: TaskTrigger; /** aborted when the task's time limit runs out */ signal: AbortSignal };
/** `skipped`: nothing to do this time (no token, a run already under way); `note`: a short line kept with the run. */
export type TaskOutcome = { counts?: Record<string, number>; skipped?: boolean; note?: string } | void;

export type TaskDef = {
  /** `a-z`, digits and `-`: the name in task_state, task_runs and `POST /api/tasks/:kind/run`. */
  kind: string;
  /** What the status view calls it (Korean, translated on screen); the kind when left out. */
  label?: string;
  /** How long after a run that went well the next one is due. */
  everyMs: number;
  run: (ctx: AppContext, info: TaskRunInfo) => Promise<TaskOutcome>;
  /** Needs the internet: waits while offline, and its network errors count towards going offline. */
  network?: boolean;
  /** Also runs once each time the app starts, due or not (as the old startup calls did). */
  startup?: boolean;
  /** Runs only when nothing else does: no search, no job, no other task. */
  idle?: boolean;
  /** A run taking longer is written as failed and its signal aborted. */
  timeoutMs?: number;
  /** Whether it applies on this PC now (checked every time); a task that does not is neither run nor shown. */
  enabled?: (ctx: AppContext) => boolean;
  /** Only on request ("지금 실행"), never on a schedule. */
  manualOnly?: boolean;
  /** Can be started from the status view (default true). */
  manual?: boolean;
};

export const SCHEDULER_TICK_MS = 5 * 60 * 1000;
export const BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000] as const;
export const TASK_RUNS_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** How often, while offline, a probe asks whether the network is back. */
export const OFFLINE_PROBE_MS = 60 * 1000;
/** Network errors in a row (from tasks or anything else that reports them) before the app counts as offline. */
export const OFFLINE_AFTER = 2;

const KIND_RE = /^[a-z][a-z0-9-]{1,40}$/;

// ---- the network: one state for the whole process (the PC is offline, not one app context)

// Errors that say no connection could be made. A connection dropped midway (ECONNRESET), a cut-short answer or a
// slow GitHub (our own time limit) is tried again, but does not make the app offline.
const NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

type ErrLike = { name?: string; message?: string; code?: string; cause?: unknown; errors?: unknown[] };

/** Whether `err` says the network could not be reached (not an answer GitHub gave, such as 403 or 502). */
export function isNetworkError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 4) return false;
  const e = err as ErrLike;
  if (NET_CODES.has(e.code ?? '')) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isNetworkError(x, depth + 1))) return true; // AggregateError
  if (e.cause && isNetworkError(e.cause, depth + 1)) return true;
  // fetch's own error carries the reason in `cause`; one without a cause says no more than that it failed
  return e.name === 'TypeError' && /fetch failed/i.test(e.message ?? '') && !e.cause;
}

type NetworkState = { offline: boolean; since: string | null; lastError: string | null };
/** Errors further apart than this are not "in a row". */
const STREAK_WINDOW_MS = 10 * 60 * 1000;
const net = { offline: false, since: null as string | null, streak: 0, lastErrorAt: 0, lastError: null as string | null };
const netListeners = new Set<(offline: boolean) => void>();

const shortError = (err: unknown) => maskSecrets(String((err as Error)?.message ?? err)).slice(0, 300);

function setOffline(offline: boolean): void {
  if (net.offline === offline) return;
  net.offline = offline;
  net.since = offline ? new Date().toISOString() : null;
  console.warn(offline ? `[네트워크] 연결이 끊긴 것으로 보고 네트워크 작업을 미룹니다 (${net.lastError ?? ''})` : '[네트워크] 다시 연결되었습니다');
  for (const l of netListeners) {
    try {
      l(offline);
    } catch {
      // a listener's failure does not change the state
    }
  }
}

/**
 * A request failed: counted when it is a network error (returns whether it was). Searches may report theirs too, so
 * the app notices sooner. {@link OFFLINE_AFTER} within 10 minutes and the app is offline. (A task that went well
 * does not count as reaching the network: some swallow their network errors, so only a probe or an explicit
 * {@link noteNetworkOk} brings the app back online.)
 */
export function noteNetworkError(err: unknown, now = Date.now()): boolean {
  if (!isNetworkError(err)) return false;
  if (now - net.lastErrorAt > STREAK_WINDOW_MS) net.streak = 0;
  net.streak++;
  net.lastErrorAt = now;
  net.lastError = shortError(err);
  if (net.streak >= OFFLINE_AFTER) setOffline(true);
  return true;
}

/** A request got an answer: the streak starts over and an offline app is back online. */
export function noteNetworkOk(): void {
  net.streak = 0;
  net.lastErrorAt = 0;
  setOffline(false);
}

/** A network error whose probe also failed: offline at once, without waiting for a second error. */
function confirmOffline(): void {
  setOffline(true);
}

/** For the search (skip skills.sh and GitHub, show "오프라인 · 로컬 색인만") and the status view. */
export function isOffline(): boolean {
  return net.offline;
}

export function networkState(): NetworkState {
  return { offline: net.offline, since: net.since, lastError: net.lastError };
}

/** Called with true on going offline and false on coming back; returns a function that stops it. */
export function onNetworkChange(listener: (offline: boolean) => void): () => void {
  netListeners.add(listener);
  return () => netListeners.delete(listener);
}

/** Tests: start from a connected network. */
export function resetNetworkState(): void {
  net.offline = false;
  net.since = null;
  net.streak = 0;
  net.lastErrorAt = 0;
  net.lastError = null;
}

/** Any answer from github.com, even an error page, means the network is there. No API quota is used. */
export async function probeNetwork(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl('https://github.com/', { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ---- the registry: tasks registered once, run by every scheduler made after (or before) that

const registry = new Map<string, TaskDef>();

/**
 * Adds a background task (or replaces the one of the same kind). Example, for a bundle's `run<Name>(ctx)`:
 * `registerTask({ kind: 'repo-heads', label: '저장소 변경 확인', everyMs: 6 * HOUR_MS, network: true, run: runRepoHeads })`.
 * A task registered after the app started still runs at the next tick (5 minutes), but not as a startup run.
 */
export function registerTask(def: TaskDef): void {
  if (!KIND_RE.test(def.kind)) throw new Error(`작업 이름 형식이 올바르지 않습니다: ${def.kind}`);
  if (!(def.everyMs > 0)) throw new Error(`작업 주기가 올바르지 않습니다: ${def.kind}`);
  registry.set(def.kind, def);
}

export function unregisterTask(kind: string): void {
  registry.delete(kind);
}

export function registeredTasks(): TaskDef[] {
  return [...registry.values()];
}

// ---- runs

export type TaskStateRow = { kind: string; last_success_at: string | null; next_due_at: string | null; fail_count: number };
export type TaskRunRow = {
  id: number;
  kind: string;
  trigger: TaskTrigger;
  started_at: string;
  finished_at: string | null;
  status: TaskRunStatus;
  counts_json: string | null;
  error: string | null;
};

/** What a job is called in task_runs: `sync` (every marketplace), `sync:<name>`, `popular`, `collect:<name>`. */
export function jobRunKind(job: Pick<Job, 'kind' | 'label'>): string {
  if (job.kind === 'sync') return job.label === '*' ? 'sync' : `sync:${job.label}`;
  return job.label === 'popular-repos' ? 'popular' : `collect:${job.label}`;
}

/** The task a job starts inside of: its first job is that run's job (one row), later ones get rows of their own. */
type Scope = { kind: string; trigger: TaskTrigger; claimJob: boolean };
const scopes = new AsyncLocalStorage<Scope>();

type Running = { runId: number; kind: string; trigger: TaskTrigger; startedAt: string; jobId: string | null; settled: Promise<void> };

export type TaskView = {
  kind: string;
  label: string;
  everyMs: number;
  network: boolean;
  idle: boolean;
  manualOnly: boolean;
  manual: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  failCount: number;
};

export type RunningView = { kind: string; label: string; trigger: TaskTrigger; startedAt: string; job: Job | null };

export type SchedulerOptions = {
  /** In place of the registry (tests). */
  tasks?: TaskDef[];
  now?: () => number;
  probe?: () => Promise<boolean>;
  tickMs?: number;
  probeMs?: number;
};

const iso = (ms: number) => new Date(ms).toISOString();

export class Scheduler {
  private readonly ctx: AppContext;
  private readonly opts: SchedulerOptions;
  private readonly running = new Map<string, Running>();
  /** Jobs that are some task run's own job (no row of their own) → that run's kind. */
  private readonly ownedJobs = new Map<string, string>();
  /** Jobs with a row of their own → the row. */
  private readonly jobRuns = new Map<string, number>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private stopNet: (() => void) | null = null;
  private readonly stopJobs: () => void;
  private started = false;

  constructor(ctx: AppContext, opts: SchedulerOptions = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.stopJobs = ctx.jobs.observe((e) => this.onJob(e));
    // runs a previous process left open (it was closed or ended mid-run)
    ctx.store.db
      .prepare(`UPDATE task_runs SET status = 'failed', finished_at = started_at, error = ? WHERE status = 'running'`)
      .run('앱이 끝나 마치지 못함');
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The tasks that apply now. */
  tasks(): TaskDef[] {
    return (this.opts.tasks ?? registeredTasks()).filter((t) => {
      try {
        return t.enabled ? t.enabled(this.ctx) : true;
      } catch {
        return false;
      }
    });
  }

  task(kind: string): TaskDef | undefined {
    return this.tasks().find((t) => t.kind === kind);
  }

  /** Startup runs, then a tick every 5 minutes. Timers do not keep the process alive. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopNet = onNetworkChange((offline) => (offline ? this.startProbe() : this.onOnline()));
    if (net.offline) this.startProbe();
    for (const t of this.tasks()) if (t.startup && !t.manualOnly) void this.launch(t, 'startup');
    void this.tick();
    const timer = setInterval(() => void this.tick(), this.opts.tickMs ?? SCHEDULER_TICK_MS);
    timer.unref?.();
    this.timers.push(timer);
  }

  /** No more ticks or probes (jobs started by hand are still written to task_runs). */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopProbe();
    this.stopNet?.();
    this.stopNet = null;
    this.started = false;
  }

  /** stop(), and jobs are no longer written either (tests that make several schedulers for one context). */
  dispose(): void {
    this.stop();
    this.stopJobs();
  }

  /** Nothing else going on: no search, no running job, no other task. */
  isIdle(except?: string): boolean {
    if (searchActivity.busy()) return false;
    if (this.ctx.jobs.list().some((j) => j.status === 'running')) return false;
    return ![...this.running.keys()].some((k) => k !== except);
  }

  isDue(t: TaskDef, now = this.now()): boolean {
    if (t.manualOnly) return false;
    const due = this.state(t.kind)?.next_due_at;
    return !due || Date.parse(due) <= now;
  }

  /** Starts every task that is due and may run now; resolves when they have ended (tests await it). */
  async tick(): Promise<void> {
    const now = this.now();
    const runs: Array<Promise<unknown>> = [];
    for (const t of this.tasks()) {
      if (this.running.has(t.kind) || !this.isDue(t, now)) continue;
      if (t.network && net.offline) continue;
      if (t.idle && !this.isIdle(t.kind)) continue;
      runs.push(this.launch(t, 'schedule'));
    }
    await Promise.all(runs);
  }

  /**
   * "지금 실행": `null` for a kind that is not a task here (or not one to start by hand), 'running' while it already
   * runs. The run goes on in the background; `done` resolves when it has ended.
   */
  runNow(kind: string): { runId: number; done: Promise<TaskRunStatus> } | 'running' | null {
    const t = this.task(kind);
    if (!t || t.manual === false) return null;
    if (this.running.has(kind)) return 'running';
    const done = this.launch(t, 'manual');
    return { runId: this.running.get(kind)!.runId, done };
  }

  /** After a network error: one probe; no answer either and the app is offline (a second error is not waited for). */
  private async checkNetwork(): Promise<void> {
    const probe = this.opts.probe ?? (() => probeNetwork());
    if (!(await probe().catch(() => false))) confirmOffline();
  }

  private startProbe(): void {
    if (this.probeTimer || !this.started) return;
    const probe = this.opts.probe ?? (() => probeNetwork());
    let busy = false;
    this.probeTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if (await probe()) noteNetworkOk();
      } finally {
        busy = false;
      }
    }, this.opts.probeMs ?? OFFLINE_PROBE_MS);
    this.probeTimer.unref?.();
  }

  private stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /** Back online: network tasks that failed or fell due while offline run now, not at their backed-off time. */
  private onOnline(): void {
    this.stopProbe();
    if (!this.started) return;
    const now = this.now();
    for (const t of this.tasks()) {
      if (!t.network || t.manualOnly || this.running.has(t.kind)) continue;
      if ((this.state(t.kind)?.fail_count ?? 0) > 0 || this.isDue(t, now)) void this.launch(t, 'schedule');
    }
  }

  /** Runs one task and writes the run; resolves with its status (never rejects). */
  launch(t: TaskDef, trigger: TaskTrigger): Promise<TaskRunStatus> {
    const db = this.ctx.store.db;
    const startedMs = this.now();
    const runId = Number(
      db.prepare(`INSERT INTO task_runs (kind, trigger, started_at, status) VALUES (?, ?, ?, 'running')`).run(t.kind, trigger, iso(startedMs))
        .lastInsertRowid,
    );
    const abort = new AbortController();
    const scope: Scope = { kind: t.kind, trigger, claimJob: true };
    // inside the scope, so a job the task starts is known as its own (onJob)
    const raw = scopes.run(scope, () => Promise.resolve().then(() => t.run(this.ctx, { trigger, signal: abort.signal })));
    const settled = raw.then(
      () => {},
      () => {},
    );
    const entry: Running = { runId, kind: t.kind, trigger, startedAt: iso(startedMs), jobId: null, settled };
    this.running.set(t.kind, entry);
    // the task keeps its place until it has really ended, even after its time limit was written down
    void settled.then(() => {
      if (this.running.get(t.kind) === entry) this.running.delete(t.kind);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const limited = t.timeoutMs
      ? Promise.race([
          raw,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new Error(`시간 제한 ${Math.max(1, Math.round(t.timeoutMs! / 1000))}초를 넘겨 멈췄습니다`));
            }, t.timeoutMs);
            timer.unref?.();
          }),
        ])
      : raw;

    return limited.then(
      (out) => {
        clearTimeout(timer);
        const status: TaskRunStatus = out && out.skipped ? 'skipped' : 'ok';
        this.finish(runId, status, out?.counts ?? null, out?.note ?? null);
        const end = this.now();
        const prev = this.state(t.kind);
        this.writeState(t.kind, {
          last_success_at: status === 'ok' ? iso(end) : (prev?.last_success_at ?? null),
          next_due_at: iso(end + t.everyMs),
          fail_count: 0,
        });
        return status;
      },
      (err: unknown) => {
        clearTimeout(timer);
        const message = shortError(err);
        this.finish(runId, 'failed', null, message);
        const end = this.now();
        const prev = this.state(t.kind);
        const fails = (prev?.fail_count ?? 0) + 1;
        const wait = Math.min(BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1]!, Math.max(t.everyMs, BACKOFF_MS[0]));
        this.writeState(t.kind, { last_success_at: prev?.last_success_at ?? null, next_due_at: iso(end + wait), fail_count: fails });
        console.warn(`[작업] ${t.kind} 실패 (${fails}번째, ${Math.round(wait / 60_000)}분 뒤 다시): ${message}`);
        if (t.network && noteNetworkError(err, end) && !net.offline) return this.checkNetwork().then(() => 'failed' as const);
        return 'failed' as const;
      },
    );
  }

  private finish(runId: number, status: TaskRunStatus, counts: Record<string, number> | null, error: string | null): void {
    this.ctx.store.db
      .prepare('UPDATE task_runs SET finished_at = ?, status = ?, counts_json = ?, error = ? WHERE id = ?')
      .run(iso(this.now()), status, counts ? JSON.stringify(counts) : null, error ? maskSecrets(error).slice(0, 300) : null, runId);
  }

  private writeState(kind: string, s: Omit<TaskStateRow, 'kind'>): void {
    this.ctx.store.db
      .prepare(
        `INSERT INTO task_state (kind, last_success_at, next_due_at, fail_count) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind) DO UPDATE SET last_success_at = excluded.last_success_at, next_due_at = excluded.next_due_at,
           fail_count = excluded.fail_count`,
      )
      .run(kind, s.last_success_at, s.next_due_at, s.fail_count);
  }

  state(kind: string): TaskStateRow | undefined {
    const row = this.ctx.store.db.prepare('SELECT * FROM task_state WHERE kind = ?').get(kind) as TaskStateRow | undefined;
    return row ? { ...row } : undefined;
  }

  /** Jobs (sync, collect) into task_runs: a task's own job is that task's row; any other gets a row of its own. */
  private onJob(e: JobEvent): void {
    const { job } = e;
    const db = this.ctx.store.db;
    if (e.phase === 'start') {
      const scope = scopes.getStore();
      if (scope?.claimJob) {
        scope.claimJob = false;
        this.ownedJobs.set(job.id, scope.kind);
        const r = this.running.get(scope.kind);
        if (r) r.jobId = job.id;
        return;
      }
      const id = db
        .prepare(`INSERT INTO task_runs (kind, trigger, started_at, status) VALUES (?, ?, ?, 'running')`)
        .run(jobRunKind(job), scope?.trigger ?? 'manual', job.startedAt).lastInsertRowid;
      this.jobRuns.set(job.id, Number(id));
      return;
    }
    if (this.ownedJobs.delete(job.id)) return;
    const runId = this.jobRuns.get(job.id);
    if (runId == null) return;
    this.jobRuns.delete(job.id);
    const status: TaskRunStatus = job.status === 'done' ? 'ok' : job.status === 'cancelled' ? 'skipped' : 'failed';
    const error = job.status === 'cancelled' ? '중단됨' : job.status === 'error' ? (job.errors.at(-1) ?? null) : null;
    db.prepare('UPDATE task_runs SET finished_at = ?, status = ?, counts_json = ?, error = ? WHERE id = ?').run(
      job.finishedAt ?? iso(this.now()),
      status,
      JSON.stringify({ done: job.done, total: job.total, errors: job.errors.length, skipped: job.skipped.length }),
      error ? maskSecrets(error).slice(0, 300) : null,
      runId,
    );
  }

  /** Each task that applies, with when it last went well and is next due. */
  view(): TaskView[] {
    const states = new Map(
      (this.ctx.store.db.prepare('SELECT * FROM task_state').all() as TaskStateRow[]).map((r) => [r.kind, r] as const),
    );
    return this.tasks().map((t) => {
      const s = states.get(t.kind);
      return {
        kind: t.kind,
        label: t.label ?? t.kind,
        everyMs: t.everyMs,
        network: !!t.network,
        idle: !!t.idle,
        manualOnly: !!t.manualOnly,
        manual: t.manual !== false,
        running: this.running.has(t.kind),
        lastSuccessAt: s?.last_success_at ?? null,
        nextDueAt: t.manualOnly ? null : (s?.next_due_at ?? null),
        failCount: s?.fail_count ?? 0,
      };
    });
  }

  /** What runs now: tasks (with their own job's progress) and jobs that are no task's own. */
  runningView(): RunningView[] {
    const labels = new Map(this.tasks().map((t) => [t.kind, t.label ?? t.kind] as const));
    const out: RunningView[] = [...this.running.values()].map((r) => ({
      kind: r.kind,
      label: labels.get(r.kind) ?? r.kind,
      trigger: r.trigger,
      startedAt: r.startedAt,
      job: r.jobId ? (this.ctx.jobs.get(r.jobId) ?? null) : null,
    }));
    const owned = new Set([...this.running.values()].map((r) => r.jobId));
    for (const j of this.ctx.jobs.list()) {
      if (owned.has(j.id) || (j.status !== 'running' && j.status !== 'paused')) continue;
      out.push({ kind: jobRunKind(j), label: jobRunKind(j), trigger: 'manual', startedAt: j.startedAt, job: j });
    }
    return out;
  }

  recentRuns(limit = 30, opts: { failedOnly?: boolean; sinceIso?: string } = {}): TaskRunRow[] {
    const where = [opts.failedOnly ? `status = 'failed'` : null, opts.sinceIso ? 'started_at >= ?' : null].filter(Boolean);
    const sql = `SELECT * FROM task_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const args: Array<string | number> = opts.sinceIso ? [opts.sinceIso, limit] : [limit];
    return (this.ctx.store.db.prepare(sql).all(...args) as TaskRunRow[]).map((r) => ({ ...r }));
  }

  /** Runs that started over 30 days ago. */
  pruneRuns(now = this.now()): number {
    return Number(this.ctx.store.db.prepare('DELETE FROM task_runs WHERE started_at < ?').run(iso(now - TASK_RUNS_KEEP_MS)).changes);
  }
}

const schedulers = new WeakMap<AppContext, Scheduler>();

/** The scheduler of this app context, made on first use (not started: index.ts starts the server's). */
export function schedulerFor(ctx: AppContext, opts?: SchedulerOptions): Scheduler {
  let s = schedulers.get(ctx);
  if (!s) {
    s = new Scheduler(ctx, opts);
    schedulers.set(ctx, s);
  }
  return s;
}

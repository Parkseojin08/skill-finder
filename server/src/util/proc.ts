import { spawn, type ChildProcess } from 'node:child_process';
import { sanitizeText } from './sanitize.ts';

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  shell?: boolean;
  /** Return stdout/stderr untouched (e.g. NUL-separated `git ls-tree -z` output). */
  raw?: boolean;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
};

export type RunResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };

/** Set only by the measurement tool (server/scripts/bench) to record or replay child processes (git). */
type ProcHook = (file: string, args: string[], opts: RunOptions, real: typeof spawnRun) => Promise<RunResult>;

/** Runs a process without a shell (unless explicitly requested), collecting sanitized output. */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const hook = (globalThis as { __skillFinderProcHook?: ProcHook }).__skillFinderProcHook;
  return hook ? hook(file, args, opts, spawnRun) : spawnRun(file, args, opts);
}

/**
 * Outside Windows each child runs as the leader of a process group of its own (spawn's `detached`), so that the
 * group, which holds whatever it started, can be ended as one (first CI run, 2026-11-12: on Linux and macOS a
 * timed-out process's own children kept running). On Windows `detached` would open a console window instead, and
 * taskkill /T walks the tree there.
 */
const OWN_GROUP = process.platform !== 'win32';
/** How long a group asked to end (SIGTERM) has before it is made to (SIGKILL). */
const KILL_GRACE_MS = 2000;

/**
 * The groups of the children still running. A group of its own no longer gets the terminal's signals with the app
 * (Ctrl+C, a closed terminal window), so the app ends them: endChildren() from its signal handlers lets them stop
 * on their own first (git removes a half-made clone on SIGTERM), and whatever is left when the process exits, by
 * any path, gets SIGKILL here.
 */
const liveGroups = new Set<number>();
let exitHook = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHook) return;
  exitHook = true;
  process.on('exit', () => {
    for (const g of liveGroups) signalGroup(g, 'SIGKILL');
  });
}

/**
 * Asks every running child's group to end (SIGTERM) and waits until they have, or `graceMs` has passed. For the app's
 * shutdown, before process.exit; nothing to do on Windows, where children are not in groups of their own.
 */
export async function endChildren(graceMs = 1000): Promise<void> {
  for (const g of liveGroups) if (!signalGroup(g, 'SIGTERM')) liveGroups.delete(g);
  for (const end = Date.now() + graceMs; liveGroups.size && Date.now() < end; ) {
    await new Promise((done) => setTimeout(done, 50));
    // signal 0 only asks whether any process of the group is left
    for (const g of liveGroups) if (!signalGroup(g, 0)) liveGroups.delete(g);
  }
}

/** A signal to a whole process group; false when there is no such group any more. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // ESRCH: every process of the group has ended
    return false;
  }
}

/**
 * Ends a process and the ones it started (node → skills CLI → git). child.kill() ends only the first, which left git
 * clones running after a timeout: on Windows (project review F2), and on Linux and macOS (CI, 2026-11-12).
 */
export function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
    return;
  }
  const pid = child.pid;
  if (!OWN_GROUP || !pid) {
    child.kill();
    return;
  }
  if (!signalGroup(pid, 'SIGTERM')) {
    // the group is gone already: nothing to remember (its id may be given to someone else)
    liveGroups.delete(pid);
    child.kill();
  }
  setTimeout(() => {
    // what did not stop on SIGTERM is stopped. The group id stays taken while any process of the group is alive, so
    // this reaches the same group, or no one (ESRCH, ignored).
    if (liveGroups.delete(pid)) signalGroup(pid, 'SIGKILL');
    // A process that left the group (a daemon) may hold the output pipes open, and run() would wait for it however
    // long it lives: stop reading, so that it ends.
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, KILL_GRACE_MS).unref();
}

function spawnRun(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: OWN_GROUP,
    });
    if (OWN_GROUP && child.pid) trackGroup(child.pid);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const partial = { stdout: '', stderr: '' };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : null;

    // decoded per stream, not per chunk: a multi-byte character (a Korean folder name in `git ls-tree`) split
    // across two chunks would otherwise turn into replacement characters
    const onData = (stream: 'stdout' | 'stderr') => (text: string) => {
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (!opts.onLine) return;
      const lines = (partial[stream] + text).split(/\r?\n/);
      partial[stream] = lines.pop() ?? '';
      for (const line of lines) {
        const clean = sanitizeText(line).trimEnd();
        if (clean) opts.onLine(clean, stream);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (child.pid) liveGroups.delete(child.pid);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // A child that ended on its own may have left processes of its group running (a daemon it started on purpose
      // would have left the group). Those were the app's to end only on a timeout or when the app exits; a group
      // whose leader is gone is forgotten here, so a later exit does not signal a group id that may be reused.
      if (child.pid && !timedOut) liveGroups.delete(child.pid);
      if (opts.onLine) {
        for (const stream of ['stdout', 'stderr'] as const) {
          const clean = sanitizeText(partial[stream]).trimEnd();
          if (clean) opts.onLine(clean, stream);
        }
      }
      const clean = opts.raw ? (s: string) => s : sanitizeText;
      resolve({ exitCode: code ?? -1, stdout: clean(stdout), stderr: clean(stderr), timedOut });
    });
  });
}

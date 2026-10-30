import { spawn } from 'node:child_process';
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

function spawnRun(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const partial = { stdout: '', stderr: '' };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
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
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
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

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { run, type RunOptions, type RunResult } from '../util/proc.ts';

export type ClaudeBinary = { file: string; shell: boolean };

const isWin = process.platform === 'win32';

function isFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!isWin) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds the `claude` executable. On Windows a native `.exe` wins; a `.cmd` shim needs a shell. */
export function findClaudeBinary(): ClaudeBinary | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const home = homedir();
  if (isWin) {
    const exeDirs = [...dirs, join(home, '.local', 'bin'), join(home, '.claude', 'local')];
    for (const d of exeDirs) {
      const p = join(d, 'claude.exe');
      if (isFile(p)) return { file: p, shell: false };
    }
    const cmdDirs = [...dirs, join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm')];
    for (const d of cmdDirs) {
      const p = join(d, 'claude.cmd');
      if (isFile(p)) return { file: p, shell: true };
    }
    return null;
  }
  for (const d of [...dirs, join(home, '.local', 'bin'), join(home, '.claude', 'local')]) {
    const p = join(d, 'claude');
    if (isFile(p)) return { file: p, shell: false };
  }
  return null;
}

let cached: ClaudeBinary | null | undefined;
export function claudeBinary(): ClaudeBinary | null {
  if (cached === undefined) cached = findClaudeBinary();
  return cached;
}

/** Args are validated by callers; with a `.cmd` shim each one is double-quoted for cmd.exe. */
function quoteForCmd(arg: string): string {
  if (/["%^&|<>!\r\n]/.test(arg)) throw new Error(`unsafe argument for shell: ${arg}`);
  return `"${arg}"`;
}

export async function runClaude(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const bin = claudeBinary();
  if (!bin) throw new Error('claude 실행 파일을 찾을 수 없습니다');
  if (bin.shell) return run(quoteForCmd(bin.file), args.map(quoteForCmd), { ...opts, shell: true });
  return run(bin.file, args, opts);
}

/** Display form of a command line (for previews and logs). */
export function formatCommand(file: string, args: string[]): string {
  return [file, ...args].map((a) => (/^[A-Za-z0-9._@/:=-]+$/.test(a) ? a : `"${a}"`)).join(' ');
}

let versionPromise: Promise<string | null> | null = null;
export function claudeVersion(): Promise<string | null> {
  versionPromise ??= runClaude(['--version'], { timeoutMs: 15_000 })
    .then((r) => (r.exitCode === 0 ? r.stdout.trim().split(/\s+/)[0] || null : null))
    .catch(() => null);
  return versionPromise;
}

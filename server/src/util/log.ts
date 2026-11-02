// A log file next to the index (project review F2): what the console shows, with secrets masked, so a problem can
// be looked at after the window is closed. Kept on this PC only; rotated at 1MB, three old files kept.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;

let file: string | null = null;
let extraSecrets: string[] = [];
let patched = false;

/** GitHub tokens of every kind, bearer headers, and values of known secret names; the home folder becomes `~`. */
export function maskSecrets(text: string): string {
  let out = text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[가림]')
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [가림]')
    .replace(/\b(GITHUB_TOKEN|DATABASE_URL|API_KEY|SECRET)\s*[=:]\s*\S+/gi, '$1=[가림]');
  for (const s of extraSecrets) if (s) out = out.split(s).join('[가림]');
  const home = homedir();
  return home ? out.split(home).join('~') : out;
}

function rotate(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_BYTES) return;
    rmSync(`${path}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    renameSync(path, `${path}.1`);
  } catch {
    // another process holds the file, or it vanished: keep writing to it
  }
}

function write(level: string, args: unknown[]): void {
  if (!file) return;
  try {
    rotate(file);
    appendFileSync(file, `${new Date().toISOString()} ${level} ${maskSecrets(format(...args))}\n`);
  } catch {
    // a full disk or a locked file must never stop the app
  }
}

/**
 * Copies console.log/warn/error into `<dataDir>/logs/server.log`. `secrets`: values to mask besides the token
 * patterns (the configured GitHub token). The console itself still shows everything as before.
 */
export function startLogFile(dataDir: string, secrets: Array<string | null | undefined> = []): string {
  const dir = join(dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'server.log');
  extraSecrets = secrets.filter((s): s is string => !!s && s.length >= 8);
  // a second call (tests) only moves the file; the console is wrapped once
  if (patched) return file;
  patched = true;
  for (const [name, level] of [
    ['log', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
  ] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      write(level, args);
    };
  }
  return file;
}

/** A newly set token is masked from then on. */
export function addSecret(value: string | null | undefined): void {
  if (value && value.length >= 8 && !extraSecrets.includes(value)) extraSecrets.push(value);
}

/** The last `lines` lines of the current log file (already masked when written). */
export function logTail(lines: number): string {
  if (!file || !existsSync(file)) return '';
  try {
    const text = readFileSync(file, 'utf8');
    return text.split('\n').slice(-lines - 1).join('\n').trim();
  } catch {
    return '';
  }
}

export function logFilePath(): string | null {
  return file;
}

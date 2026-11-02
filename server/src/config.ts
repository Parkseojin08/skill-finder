import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SERVER_DIR = join(ROOT_DIR, 'server');
export const WEB_DIST_DIR = join(ROOT_DIR, 'web', 'dist');
/** The release launcher keeps the token outside the app folder (UI debate D-6); from the environment only. */
export const ENV_PATH = process.env.SKILL_FINDER_ENV_PATH ? resolve(process.env.SKILL_FINDER_ENV_PATH) : join(ROOT_DIR, '.env');
export const SKILLS_CLI_VERSION = '1.7.4';
export const SKILLS_CLI_PATH = join(ROOT_DIR, 'node_modules', 'skills', 'bin', 'cli.mjs');
export const DEV_VITE_PORT = 5173;

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

const fileEnv = existsSync(ENV_PATH) ? parseEnvFile(readFileSync(ENV_PATH, 'utf8')) : {};
const env = (key: string): string | undefined => process.env[key] ?? fileEnv[key];

export type AppConfig = {
  port: number;
  dev: boolean;
  dataDir: string;
  githubToken: string | null;
};

export const config: AppConfig = {
  port: Number(env('PORT') ?? 4317) || 4317,
  dev: process.argv.includes('--dev') || env('SKILL_FINDER_DEV') === '1',
  dataDir: resolve(env('SKILL_FINDER_DATA_DIR') ?? join(ROOT_DIR, 'data')),
  githubToken: env('GITHUB_TOKEN')?.trim() || null,
};

export function ensureDataDirs(): void {
  mkdirSync(join(config.dataDir, 'tmp', 'git'), { recursive: true });
}

/**
 * Writes GITHUB_TOKEN into .env (creating it if needed) and updates the in-memory config. Written to a temporary
 * file first and renamed over .env, so a crash or a full disk mid-write cannot leave a cut-off .env.
 */
export function saveGithubToken(token: string | null): void {
  const value = token?.trim() || '';
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  let found = false;
  const next = lines.map((line) => {
    if (/^\s*(?:export\s+)?GITHUB_TOKEN\s*=/.test(line)) {
      found = true;
      return `GITHUB_TOKEN=${value}`;
    }
    return line;
  });
  if (!found) next.push(`GITHUB_TOKEN=${value}`);
  const tmp = `${ENV_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, next.join('\n').replace(/\n*$/, '\n'), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, ENV_PATH);
  config.githubToken = value || null;
}

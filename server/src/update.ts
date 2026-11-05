// Whether a newer Skill Finder is on the download page, to say so on screen. Only for the installed app (the
// launcher sets SKILL_FINDER_UPDATES=1); installing it is the launcher's job, at the next start. A version counts
// only when meta.json is signed with the update key (release.ts), and its change notes only when they are too.
import type { KeyLike } from 'node:crypto';
import { releaseMessage, signedNotes, verifyText } from './release.ts';

const DEFAULT_BASE = 'https://seojin-skill-finder.pages.dev/download/';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let latest: { version: string; notes: string[] } | null = null;

const parse = (v: string) => v.split('.').map((n) => Number(n) || 0);
/** a > b for "1.2.3" versions. */
export function newerVersion(a: string, b: string): boolean {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * The newest signed version the download page offers (meta.json); kept quietly as it was when the page cannot be
 * read or the signature does not match. `publicKey`: tests sign with their own key.
 */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch, publicKey?: KeyLike): Promise<string | null> {
  try {
    return await fetchUpdate(fetchImpl, publicKey);
  } catch {
    // offline: try again later
    return latest?.version ?? null;
  }
}

/** checkForUpdate, but a page that could not be reached throws (the scheduler tries again sooner). */
async function fetchUpdate(fetchImpl: typeof fetch = fetch, publicKey?: KeyLike): Promise<string | null> {
  if (process.env.SKILL_FINDER_UPDATES !== '1') return null;
  let base = process.env.SKILL_FINDER_UPDATE_URL || DEFAULT_BASE;
  if (!base.endsWith('/')) base += '/';
  {
    // a page that answers with an error is "no news", as before; only no answer at all throws
    const res = await fetchImpl(`${base}meta.json`, { signal: AbortSignal.timeout(5000) });
    const meta = res.ok ? ((await res.json()) as Record<string, unknown>) : {};
    const { version, bytes, sha256 } = meta;
    if (
      typeof version === 'string' &&
      /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version) &&
      typeof bytes === 'number' &&
      typeof sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(sha256) &&
      verifyText(releaseMessage({ version, bytes, sha256 }), meta.signature, publicKey) &&
      // an older signed release served again does not hide the newer one already seen
      (!latest || !newerVersion(latest.version, version))
    ) {
      latest = { version, notes: signedNotes(meta, version, publicKey) };
    }
  }
  return latest?.version ?? null;
}

/** How often the scheduler's "새 버전 확인" runs (tasks.ts registers it; installed app only). */
export const UPDATE_CHECK_EVERY_MS = CHECK_EVERY_MS;

/** Scheduler task "새 버전 확인": as checkForUpdate, but failing when the download page cannot be reached. */
export async function runUpdateCheck(): Promise<{ counts?: Record<string, number>; skipped?: boolean; note?: string }> {
  if (process.env.SKILL_FINDER_UPDATES !== '1') return { skipped: true, note: '설치판이 아님' };
  const version = await fetchUpdate();
  return { counts: { newer: version ? 1 : 0 }, note: version ? `다운로드 페이지 최신 ${version}` : undefined };
}

/** `{ version, notes }` when the download page has a newer signed version than `current`. */
export function updateInfo(current: string | null): { version: string; notes: string[] } | null {
  return latest && current && newerVersion(latest.version, current) ? { ...latest } : null;
}

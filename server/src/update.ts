// Whether a newer Skill Finder is on the download page, to say so on screen. Only for the installed app (the
// launcher sets SKILL_FINDER_UPDATES=1); installing it is the launcher's job, at the next start.
const DEFAULT_BASE = 'https://skill-finder.a01075011775.workers.dev/download/';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let latest: string | null = null;

const parse = (v: string) => v.split('.').map((n) => Number(n) || 0);
/** a > b for "1.2.3" versions. */
export function newerVersion(a: string, b: string): boolean {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The newest version the download page offers (meta.json); kept quietly as it was when the page cannot be read. */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (process.env.SKILL_FINDER_UPDATES !== '1') return null;
  let base = process.env.SKILL_FINDER_UPDATE_URL || DEFAULT_BASE;
  if (!base.endsWith('/')) base += '/';
  try {
    const res = await fetchImpl(`${base}meta.json`, { signal: AbortSignal.timeout(5000) });
    const v = res.ok ? ((await res.json()) as { version?: unknown }).version : null;
    if (typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(v)) latest = v;
  } catch {
    // offline: try again later
  }
  return latest;
}

export function startUpdateChecks(): void {
  if (process.env.SKILL_FINDER_UPDATES !== '1') return;
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS).unref();
}

/** `{ version }` when the download page has a newer version than `current`. */
export function updateInfo(current: string | null): { version: string } | null {
  return latest && current && newerVersion(latest, current) ? { version: latest } : null;
}

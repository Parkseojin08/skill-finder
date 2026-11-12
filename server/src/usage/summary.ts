// What the 설치됨 table shows of skill_usage (feature review F11): per skill, the last day it was used and the uses
// in the last 30 days, everywhere and in the folder listed. A use counts for a folder when Claude Code ran in it or
// in a folder inside it (cwd).
import type { Store } from '../db/store.ts';
import { pathKey, pathWithin } from '../install/installed.ts';
import { localDay } from './parse.ts';

export type UsageEntry = {
  skill: string;
  /** '' for a skill of its own, else the plugin's name (the part before "@marketplace"). */
  plugin: string;
  lastUsed: string;
  count30: number;
  /** In the folder asked for (and folders inside it); null without one. */
  lastUsedHere: string | null;
  count30Here: number | null;
  /** The one folder all of the last 30 days' uses were in, when there was one (to say "only used in this project"). */
  onlyProject: string | null;
};

export type UsageSummary = {
  enabled: boolean;
  /** When the transcripts were last read; null before the first run. */
  scannedAt: string | null;
  files: number;
  skills: UsageEntry[];
};

export const USAGE_WINDOW_DAYS = 30;

/** The first day of the last `days` days, today included (local days, as stored). */
export function windowStart(now: Date, days = USAGE_WINDOW_DAYS): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 12);
  return localDay(d.toISOString())!;
}

const inFolder = (cwd: string, folder: string): boolean => !!cwd && pathWithin(cwd, folder);

export function usageSummary(store: Store, enabled: boolean, projectPath: string | null, now = new Date()): UsageSummary {
  const meta = store.db.prepare('SELECT COUNT(*) AS n, MAX(scanned_at) AS at FROM usage_scan_files').get() as { n: number; at: string | null };
  const from = windowStart(now);
  const rows = store.db
    .prepare(
      `SELECT skill, plugin, project_path, MAX(day) AS last,
              SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS recent
         FROM skill_usage GROUP BY skill, plugin, project_path`,
    )
    .all(from) as Array<{ skill: string; plugin: string; project_path: string; last: string; recent: number }>;
  // per skill, the folders its recent uses were in (by pathKey; '' for a use without one)
  const by = new Map<string, UsageEntry & { recentProjects: Map<string, string> }>();
  for (const r of rows) {
    const k = `${r.plugin}\u0000${r.skill}`;
    let e = by.get(k);
    if (!e) {
      e = { skill: r.skill, plugin: r.plugin, lastUsed: r.last, count30: 0, lastUsedHere: null, count30Here: projectPath ? 0 : null, onlyProject: null, recentProjects: new Map() };
      by.set(k, e);
    }
    if (r.last > e.lastUsed) e.lastUsed = r.last;
    e.count30 += r.recent;
    if (r.recent > 0) e.recentProjects.set(r.project_path ? pathKey(r.project_path) : '', r.project_path);
    if (projectPath && inFolder(r.project_path, projectPath)) {
      if (!e.lastUsedHere || r.last > e.lastUsedHere) e.lastUsedHere = r.last;
      e.count30Here = (e.count30Here ?? 0) + r.recent;
    }
  }
  const skills: UsageEntry[] = [...by.values()].map(({ recentProjects, ...e }) => {
    const [only] = [...recentProjects.values()];
    return { ...e, onlyProject: recentProjects.size === 1 && only ? only : null };
  });
  skills.sort((a, b) => (a.lastUsed < b.lastUsed ? 1 : a.lastUsed > b.lastUsed ? -1 : a.skill.localeCompare(b.skill)));
  return { enabled, scannedAt: meta.at, files: meta.n, skills };
}

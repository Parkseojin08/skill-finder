// Changes to installed and favorite skills (feature review F7): what the repo watch (B3), a risk re-check and the
// repo metadata refresh noticed, kept in the notices table (migration 12). Only ids the user installed or starred are
// compared; the table's UNIQUE(skill_id, kind, to_value) keeps the same change from being written twice.
import type { SQLInputValue } from 'node:sqlite';
import type { RepoRow, Store } from '../db/store.ts';

export type NoticeKind = 'risk_up' | 'new_commit' | 'archived' | 'gone' | 'moved';
/** Why an id is compared: installed (found on disk by the last watch run, or logged by the app), or starred. */
export type WatchReason = 'installed' | 'favorite';

export type NoticeRow = {
  id: number;
  skill_id: string;
  kind: NoticeKind;
  from_value: string | null;
  to_value: string | null;
  detail_json: string | null;
  created_at: string;
  seen_at: string | null;
};

/** A notice as the API sends it. `skillIds`: the skills it is about (a repo or plugin notice names several). */
export type Notice = {
  id: number;
  skillId: string;
  kind: NoticeKind;
  from: string | null;
  to: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  seenAt: string | null;
  skillIds: string[];
  watch: WatchReason[];
};

/** Prefixes of notices about something other than one skill: a repository, an installed plugin. */
export const REPO_NOTICE = 'repo:';
export const PLUGIN_NOTICE = 'plugin:';

const now = () => new Date().toISOString();

function parseObject(text: string | null): Record<string, unknown> {
  try {
    const v = text ? JSON.parse(text) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function toNotice(r: NoticeRow): Notice {
  const detail = parseObject(r.detail_json);
  const ids = strings(detail.skillIds);
  return {
    id: r.id,
    skillId: r.skill_id,
    kind: r.kind,
    from: r.from_value,
    to: r.to_value,
    detail,
    createdAt: r.created_at,
    seenAt: r.seen_at,
    skillIds: ids.length ? ids : [r.skill_id],
    watch: strings(detail.watch).filter((w): w is WatchReason => w === 'installed' || w === 'favorite'),
  };
}

/** Writes a notice unless the same one (skill, kind, to) is there; true when it was new. */
export function addNotice(
  store: Store,
  n: { skillId: string; kind: NoticeKind; from?: string | null; to?: string | null; detail?: Record<string, unknown> },
  at = now(),
): boolean {
  const r = store.db
    .prepare('INSERT OR IGNORE INTO notices (skill_id, kind, from_value, to_value, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(n.skillId, n.kind, n.from ?? null, n.to ?? null, n.detail ? JSON.stringify(n.detail) : null, at);
  return Number(r.changes) > 0;
}

export function listNotices(store: Store, opts: { unseenOnly?: boolean; limit?: number } = {}): Notice[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000));
  const rows = store.db
    .prepare(`SELECT * FROM notices ${opts.unseenOnly ? 'WHERE seen_at IS NULL' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(limit) as NoticeRow[];
  return rows.map(toNotice);
}

/** Unseen notices, in all and by why the skill is watched (the menu's "설치됨 N" badge counts the installed ones). */
export function noticeCounts(store: Store): { unseen: number; installed: number; favorite: number } {
  const rows = store.db.prepare('SELECT detail_json FROM notices WHERE seen_at IS NULL').all() as Array<{ detail_json: string | null }>;
  let installed = 0;
  let favorite = 0;
  for (const r of rows) {
    const watch = strings(parseObject(r.detail_json).watch);
    if (watch.includes('installed')) installed++;
    if (watch.includes('favorite')) favorite++;
  }
  return { unseen: rows.length, installed, favorite };
}

/** Marks these notices (all unseen ones without ids) as seen; returns how many changed. */
export function markNoticesSeen(store: Store, ids?: number[], at = now()): number {
  if (ids && ids.length === 0) return 0;
  const r = ids
    ? store.db.prepare('UPDATE notices SET seen_at = ? WHERE seen_at IS NULL AND id IN (SELECT value FROM json_each(?))').run(at, JSON.stringify(ids))
    : store.db.prepare('UPDATE notices SET seen_at = ? WHERE seen_at IS NULL').run(at);
  return Number(r.changes);
}

/** Whether an earlier new-commit notice saw this SKILL.md (hash) as the version before (installed.ts drift, F6). */
export function wasPreviousVersion(store: Store, skillId: string, mdSha: string): boolean {
  return !!store.db
    .prepare("SELECT 1 FROM notices WHERE skill_id = ? AND kind = 'new_commit' AND json_extract(detail_json, '$.fromMd') = ? LIMIT 1")
    .get(skillId, mdSha);
}

// ── what is watched ──

/** Setting: the skills and plugins the last watch run found installed on disk (scanning is too slow for every call). */
const INSTALLED_KEY = 'watch.installed';
type InstalledMemo = { at: string; skillIds: string[]; pluginIds: string[] };

export function rememberInstalled(store: Store, skillIds: string[], pluginIds: string[], at = now()): void {
  store.setSetting(INSTALLED_KEY, { at, skillIds: [...new Set(skillIds)].sort(), pluginIds: [...new Set(pluginIds)].sort() } satisfies InstalledMemo);
}

function installedMemo(store: Store): InstalledMemo | null {
  const v = store.getSetting<InstalledMemo>(INSTALLED_KEY);
  return v && Array.isArray(v.skillIds) && Array.isArray(v.pluginIds) ? v : null;
}

/** Ids installed through the app (its install log), for before the first watch run has looked at the disk. */
function loggedInstalls(store: Store): { skillIds: string[]; pluginIds: string[] } {
  const rows = store.db
    .prepare("SELECT DISTINCT skill_id, plugin_id FROM install_log WHERE exit_code = 0 AND method NOT LIKE 'uninstall-%'")
    .all() as Array<{ skill_id: string | null; plugin_id: string | null }>;
  return { skillIds: rows.flatMap((r) => (r.skill_id ? [r.skill_id] : [])), pluginIds: rows.flatMap((r) => (r.plugin_id ? [r.plugin_id] : [])) };
}

/** Installed and favorite skill ids, each with why it is watched; a plugin's skills count as installed with it. */
export function watchedSkills(store: Store): Map<string, Set<WatchReason>> {
  const out = new Map<string, Set<WatchReason>>();
  const add = (id: string, why: WatchReason) => {
    const s = out.get(id) ?? new Set<WatchReason>();
    s.add(why);
    out.set(id, s);
  };
  const installed = installedMemo(store) ?? loggedInstalls(store);
  for (const id of installed.skillIds) add(id, 'installed');
  for (const pid of installed.pluginIds) for (const s of store.listSkillsByPlugin(pid)) add(s.id, 'installed');
  for (const f of store.listFavorites()) if (!f.skill_id.startsWith(REPO_NOTICE)) add(f.skill_id, 'favorite');
  return out;
}

export function watchedPluginIds(store: Store): string[] {
  return (installedMemo(store) ?? loggedInstalls(store)).pluginIds;
}

export type WatchedRepo = { repo: string; skillIds: string[]; why: Set<WatchReason> };

/** The repositories of the watched skills, and the starred repositories (`repo:` favorites), by lower-case name. */
export function watchedRepos(store: Store, skills = watchedSkills(store)): Map<string, WatchedRepo> {
  const out = new Map<string, WatchedRepo>();
  const add = (repo: string, why: Iterable<WatchReason>, skillId?: string) => {
    const key = repo.toLowerCase();
    const r = out.get(key) ?? { repo, skillIds: [], why: new Set<WatchReason>() };
    for (const w of why) r.why.add(w);
    if (skillId && !r.skillIds.includes(skillId)) r.skillIds.push(skillId);
    out.set(key, r);
  };
  for (const [id, why] of skills) {
    const repo = store.getSkill(id)?.repo;
    if (repo) add(repo, why, id);
  }
  for (const f of store.listFavorites()) if (f.skill_id.startsWith(REPO_NOTICE)) add(f.skill_name, ['favorite']);
  return out;
}

// ── repository changes seen by the metadata refresh (github.ts) ──

/** The default branch's commit (B3), stored by the metadata refresh and the watch. */
export function setRepoHeadSha(store: Store, fullName: string, sha: string | null): void {
  store.db.prepare('UPDATE repos SET head_sha = ? WHERE full_name = ? COLLATE NOCASE').run(sha, fullName);
}

export function repoHeadSha(store: Store, fullName: string): string | null {
  const r = store.db.prepare('SELECT head_sha FROM repos WHERE full_name = ? COLLATE NOCASE').get(fullName) as { head_sha: string | null } | undefined;
  return r?.head_sha ?? null;
}

/**
 * A watched repository was archived, moved (renamed or transferred) or is gone: one notice for the repository
 * (`repo:<name>`), naming the watched skills in it. Repos nobody watches are passed over. Returns notices written.
 */
export function noteRepoChange(
  store: Store,
  watched: Map<string, WatchedRepo>,
  repo: string,
  prev: Pick<RepoRow, 'archived' | 'moved_to'> | undefined,
  next: { archived?: number | null; movedTo?: string | null; gone?: boolean },
): number {
  const w = watched.get(repo.toLowerCase());
  if (!w) return 0;
  const base = { repo: w.repo, skillIds: w.skillIds.length ? w.skillIds : [`${REPO_NOTICE}${repo.toLowerCase()}`], watch: [...w.why].sort() };
  const skillId = `${REPO_NOTICE}${repo.toLowerCase()}`;
  let n = 0;
  if (prev && prev.archived === 0 && next.archived === 1) n += Number(addNotice(store, { skillId, kind: 'archived', from: '0', to: '1', detail: base }));
  if (next.movedTo && next.movedTo !== (prev?.moved_to ?? null)) n += Number(addNotice(store, { skillId, kind: 'moved', from: repo, to: next.movedTo, detail: base }));
  if (next.gone) n += Number(addNotice(store, { skillId, kind: 'gone', detail: base }));
  return n;
}

// ── changes to the watched skills' index rows ──

/** Setting: what each watched skill's index row was when last compared (the snapshot the next pass compares to). */
const SNAPSHOT_KEY = 'watch.snapshot';
type Snap = { ref: string | null; md: string | null; risk: string | null; flags: string[]; gone?: boolean };
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function parseFlags(json: string | null): string[] {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Compares the watched skills' index rows with how they were at the last pass and writes what changed: a new
 * SKILL.md (new_commit), a higher risk level (risk_up; also after a risk-rules re-check, which re-reads the same
 * commit), a row gone from the index (gone). A skill seen for the first time is only remembered. `vanished`: skills
 * the watch found missing from their repo's new commit (their row stays while installed).
 */
export function noticeWatchedChanges(store: Store, opts: { vanished?: Set<string>; skills?: Map<string, Set<WatchReason>> } = {}): { notices: number; watched: number } {
  const skills = opts.skills ?? watchedSkills(store);
  const prevAll = store.getSetting<Record<string, Snap>>(SNAPSHOT_KEY) ?? {};
  const next: Record<string, Snap> = {};
  let notices = 0;
  for (const [id, why] of skills) {
    const watch = [...why].sort();
    const row = store.getSkill(id);
    const prev = prevAll[id];
    if (!row || opts.vanished?.has(id)) {
      if (prev && !prev.gone) notices += Number(addNotice(store, { skillId: id, kind: 'gone', from: prev.ref, detail: { name: row?.name ?? null, repo: row?.repo ?? null, watch } }));
      next[id] = { ...(prev ?? { ref: row?.ref ?? null, md: row?.skill_md_sha256 ?? null, risk: row?.risk_level ?? null, flags: [] }), gone: true };
      continue;
    }
    const cur: Snap = { ref: row.ref, md: row.skill_md_sha256, risk: row.risk_level, flags: parseFlags(row.risk_json) };
    next[id] = cur;
    if (!prev || prev.gone) continue;
    const common = { name: row.name, repo: row.repo, watch };
    if (prev.md && cur.md && prev.md !== cur.md) {
      notices += Number(
        addNotice(store, {
          skillId: id,
          kind: 'new_commit',
          from: prev.ref,
          to: cur.ref ?? cur.md,
          detail: { ...common, fromMd: prev.md, toMd: cur.md, riskFrom: prev.risk, riskTo: cur.risk, commitAt: row.last_commit_at },
        }),
      );
    }
    if ((RISK_RANK[cur.risk ?? ''] ?? 0) > (RISK_RANK[prev.risk ?? ''] ?? 0)) {
      notices += Number(
        addNotice(store, {
          skillId: id,
          kind: 'risk_up',
          from: prev.risk,
          // the level with the version it was found in: the same rise is written once, a later one again
          to: `${cur.risk}@${(cur.ref ?? cur.md ?? '').slice(0, 12)}`,
          detail: { ...common, riskFrom: prev.risk, riskTo: cur.risk, flagsAdded: cur.flags.filter((f) => !prev.flags.includes(f)), ref: cur.ref },
        }),
      );
    }
  }
  store.setSetting(SNAPSHOT_KEY, next);
  return { notices, watched: skills.size };
}

// ── the install history beside the notices (F7 timeline) ──

export type InstallLogEntry = {
  id: number;
  at: string;
  method: string;
  scope: string;
  projectPath: string | null;
  skillId: string | null;
  pluginId: string | null;
  ok: boolean;
  ref: string | null;
  skillMdSha256: string | null;
  riskLevel: string | null;
  /** What was seen when installing (filled by the install route since migration 12; null before). */
  flags: unknown;
  scanSummary: unknown;
  acks: unknown;
  pinned: boolean | null;
};

const parseAny = (text: string | null): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

export function listInstallHistory(store: Store, limit: number): InstallLogEntry[] {
  const rows = store.db
    .prepare(
      `SELECT id, created_at, method, scope, project_path, skill_id, plugin_id, exit_code, ref, skill_md_sha256, risk_level,
         flags_json, scan_summary_json, acks_json, pinned FROM install_log ORDER BY id DESC LIMIT ?`,
    )
    .all(limit as SQLInputValue) as Array<Record<string, string | number | null>>;
  return rows.map((r) => ({
    id: Number(r.id),
    at: String(r.created_at),
    method: String(r.method ?? ''),
    scope: String(r.scope ?? ''),
    projectPath: (r.project_path as string | null) ?? null,
    skillId: (r.skill_id as string | null) ?? null,
    pluginId: (r.plugin_id as string | null) ?? null,
    ok: r.exit_code === 0,
    ref: (r.ref as string | null) ?? null,
    skillMdSha256: (r.skill_md_sha256 as string | null) ?? null,
    riskLevel: (r.risk_level as string | null) ?? null,
    flags: parseAny(r.flags_json as string | null),
    scanSummary: parseAny(r.scan_summary_json as string | null),
    acks: parseAny(r.acks_json as string | null),
    pinned: r.pinned == null ? null : r.pinned === 1,
  }));
}

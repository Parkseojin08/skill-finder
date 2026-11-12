// Every project the app knows of (feature review F13): the folders it installed into (install_log) and those Claude
// Code lists in `~/.claude.json` projects — known paths only, never a disk search — each with what it loads, its
// standard (F12), its changed copies (F6) and its skill use (F11). Read only; kept for a minute.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { readAgentConfig } from '../agentConfig/read.ts';
import { CLAUDE_CODE } from '../install/agents.ts';
import { pathKey, pathWithin, scanInstalledSkills, scanPluginSkills, type InstalledSkill, type PluginSkill } from '../install/installed.ts';
import type { Store } from '../db/store.ts';
import { getSettings } from '../settings.ts';
import { projectStandard, type StandardStatus } from './standard.ts';

/** At most this many projects (newest installs first, then Claude Code's list). */
export const MAX_PROJECTS = 60;
const CACHE_MS = 60_000;
const USAGE_DAYS = 30;

export type ProjectSummary = {
  path: string;
  name: string;
  /** Where the app heard of it. */
  from: Array<'install' | 'claude'>;
  /** The project's own skills (every agent's folder) and all Claude Code loads here (personal ones included). */
  skills: { project: number; loaded: number };
  /** Plugins installed for this project, and those on here (personal ones included). */
  plugins: { project: number; enabled: number };
  /** Claude Code MCP servers that run here: this project's (.mcp.json, ~/.claude.json's entry, plugins) and all. */
  mcp: { project: number; total: number };
  /** Context every request takes here (estimate): the names and descriptions of the skills Claude Code loads. */
  perTurnTokens: number;
  standard: { hasStandard: boolean; ok: boolean; counts: Record<StandardStatus, number> } | null;
  /** The project's skill copies that differ from the index's: a newer original, or edited here (F6). */
  changed: number;
  /** F11: null when no use is recorded at all (usage reading off, or nothing read yet). */
  usage: { unused30d: number; lastUsed: string | null } | null;
  /** A part that could not be read (shown as "-", the rest still counts). */
  errors: string[];
};

export type ProjectsResponse = { projects: ProjectSummary[]; usageOn: boolean; truncated: boolean; at: string };

/** How many of ~/.claude.json's project paths are checked for existence (the list shows MAX_PROJECTS). */
const CLAUDE_PROJECTS_MAX = 500;

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Claude Code's project list: the keys of `projects` in ~/.claude.json (read whole, as agentConfig does, up to 8MB). */
export function claudeJsonProjects(home: string): string[] {
  try {
    const file = `${home}/.claude.json`;
    if (statSync(file).size > 8 * 1024 * 1024) return [];
    const v = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as { projects?: unknown };
    return v.projects && typeof v.projects === 'object' && !Array.isArray(v.projects) ? Object.keys(v.projects) : [];
  } catch {
    return [];
  }
}

/** The known folders, newest app install first; only existing absolute directories, one per folder (pathKey). */
export function knownProjects(store: Store, home: string): Array<{ path: string; from: Array<'install' | 'claude'> }> {
  const rows = store.db
    .prepare(
      `SELECT project_path, MAX(id) AS last FROM install_log
        WHERE project_path IS NOT NULL AND project_path != '' AND method NOT LIKE 'uninstall-%'
        GROUP BY project_path ORDER BY last DESC LIMIT 500`,
    )
    .all() as Array<{ project_path: string }>;
  const out = new Map<string, { path: string; from: Array<'install' | 'claude'> }>();
  const add = (raw: string, from: 'install' | 'claude') => {
    if (typeof raw !== 'string' || !raw || raw.length > 1000 || /[\0\r\n]/.test(raw)) return;
    // Claude Code writes C:/Users/…: shown the Windows way, as the folder box takes it
    const path = process.platform === 'win32' ? raw.replace(/\//g, '\\') : raw;
    if (!isAbsolute(path)) return;
    const key = pathKey(path);
    const hit = out.get(key);
    if (hit) {
      if (!hit.from.includes(from)) hit.from.push(from);
      return;
    }
    // the home folder itself is the personal scope, not a project
    if (key === pathKey(home) || !isDir(path)) return;
    out.set(key, { path, from: [from] });
  };
  for (const r of rows) add(r.project_path, 'install');
  // each new path costs a stat: no more than CLAUDE_PROJECTS_MAX of Claude Code's are looked at
  for (const p of claudeJsonProjects(home).slice(0, CLAUDE_PROJECTS_MAX)) add(p, 'claude');
  return [...out.values()];
}

type UsageRow = { project: string; skill: string; last: string; recent: number };

/**
 * F11's table (skill_usage, filled by the usage scan, which stores local days and lower-case names): per folder and
 * skill, the last day used and the uses since `since`. Null when usage reading is off (as GET /api/usage answers:
 * counts kept from when it was on are not shown, review 2026-11-10), or when no transcript was ever read and nothing
 * is recorded.
 */
function usageRows(store: Store, since: string): UsageRow[] | null {
  try {
    if (!getSettings(store).usageScan) return null;
    const scanned = store.db.prepare('SELECT 1 AS x FROM usage_scan_files LIMIT 1').get();
    const any = store.db.prepare('SELECT 1 AS x FROM skill_usage LIMIT 1').get();
    if (!scanned && !any) return null;
    const rows = store.db
      .prepare(
        `SELECT project_path, skill, MAX(day) AS last, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS recent
           FROM skill_usage WHERE count > 0 GROUP BY project_path, skill`,
      )
      .all(since) as Array<{ project_path: string | null; skill: string; last: string; recent: number }>;
    return rows.map((r) => ({ project: r.project_path ?? '', skill: String(r.skill).toLowerCase(), last: String(r.last), recent: Number(r.recent) }));
  } catch {
    return null; // an older database without the tables
  }
}

/** A use counts for a folder when Claude Code ran in it or in a folder inside it (as the usage summary counts). */
const inFolder = (cwd: string, folder: string) => !!cwd && pathWithin(cwd, folder);

/** The first local day of the last `days` days, today included (YYYY-MM-DD, as the usage scan stores days). */
export function usageWindowStart(now: number, days = USAGE_DAYS): string {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1), 12);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`;
}

const forClaude = (s: InstalledSkill | PluginSkill) => s.agents.some((a) => a.id === CLAUDE_CODE);

export type ListOptions = { home?: string; now?: number };

let cache: { key: string; at: number; value: Promise<ProjectsResponse> } | null = null;
let building: { key: string; value: Promise<ProjectsResponse> } | null = null;

export function forgetProjects(): void {
  cache = null;
  building = null;
}

/** The list, kept for a minute (the 설치됨 screen asks when "모든 프로젝트" opens). `fresh`: read again now. */
export function listProjects(store: Store, opts: ListOptions = {}, fresh = false): Promise<ProjectsResponse> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  if (!fresh && cache && cache.key === home && now - cache.at < CACHE_MS) return cache.value;
  // one read at a time: a second "새로 읽기" joins the one in flight (each hashes every project's skill folders)
  if (building && building.key === home) return building.value;
  const value = buildProjects(store, home, now);
  cache = { key: home, at: now, value };
  const mine = { key: home, value };
  building = mine;
  const release = () => {
    if (building === mine) building = null;
  };
  value.then(release, () => {
    release();
    if (cache?.value === value) cache = null;
  });
  return value;
}

async function buildProjects(store: Store, home: string, now: number): Promise<ProjectsResponse> {
  const all = knownProjects(store, home);
  const known = all.slice(0, MAX_PROJECTS);
  // personal skills load in every project: read once
  const userSkills = await scanInstalledSkills(store, 'user', null, undefined, { home });
  const userPerTurn = userSkills.filter(forClaude).reduce((n, s) => n + s.tokens.perTurn, 0);
  const pluginSkillCache = new Map<string, Promise<PluginSkill[]>>();
  const pluginSkillsOf = (p: { id: string; scope: string; installPath: string | null; enabled: boolean }) => {
    const key = p.installPath ?? `?${p.id}`;
    if (!pluginSkillCache.has(key)) pluginSkillCache.set(key, scanPluginSkills(store, { ...p, enabled: true }).catch(() => []));
    return pluginSkillCache.get(key)!;
  };
  const usage = usageRows(store, usageWindowStart(now));

  const projects: ProjectSummary[] = [];
  for (const { path, from } of known) {
    const errors: string[] = [];
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    let projectSkills: InstalledSkill[] = [];
    try {
      projectSkills = await scanInstalledSkills(store, 'project', path, undefined, { home });
    } catch {
      errors.push('skills');
    }
    let plugins: Array<{ id: string; scope: string; enabled: boolean; installPath: string | null }> = [];
    let mcpProject = 0;
    let mcpTotal = 0;
    try {
      const cfg = await readAgentConfig({ home, projectPath: path });
      plugins = cfg.plugins;
      for (const r of cfg.run) {
        if (r.kind !== 'mcp' || r.source.agent !== 'claude' || r.state !== 'on') continue;
        mcpTotal++;
        // .mcp.json (project), ~/.claude.json's entry for this folder (local), or a plugin installed for it
        const own = r.source.scope === 'project' || r.source.scope === 'local' || (r.source.scope === 'plugin' && plugins.some((p) => p.id === r.source.plugin && p.scope !== 'user'));
        if (own) mcpProject++;
      }
    } catch {
      errors.push('config');
    }
    const enabled = plugins.filter((p) => p.enabled);
    const pluginRows = (await Promise.all(enabled.map(pluginSkillsOf))).flat();
    const ownPluginRows: PluginSkill[] = [];
    for (const p of enabled.filter((x) => x.scope !== 'user')) ownPluginRows.push(...(await pluginSkillsOf(p)));
    const loadedProject = projectSkills.filter(forClaude);
    const seen = new Set<string>();
    const pluginLoaded = pluginRows.filter((s) => !seen.has(s.path) && seen.add(s.path));
    const perTurnTokens = userPerTurn + loadedProject.reduce((n, s) => n + s.tokens.perTurn, 0) + pluginLoaded.reduce((n, s) => n + s.tokens.perTurn, 0);

    let standard: ProjectSummary['standard'] = null;
    try {
      const st = await projectStandard(path, { home });
      standard = { hasStandard: st.hasStandard, ok: st.ok, counts: st.counts };
    } catch {
      errors.push('standard');
    }

    let use: ProjectSummary['usage'] = null;
    if (usage) {
      const here = usage.filter((r) => inFolder(r.project, path));
      const used = new Set(here.filter((r) => r.recent > 0).map((r) => r.skill));
      // the project's own: its skills and its plugins' (personal ones would repeat on every row)
      const names = new Set([...loadedProject, ...ownPluginRows].map((s) => s.name.toLowerCase()));
      const unused30d = [...names].filter((n) => !used.has(n)).length;
      const lastUsed = here.reduce<string | null>((m, r) => (m == null || r.last > m ? r.last : m), null);
      use = { unused30d, lastUsed };
    }

    projects.push({
      path,
      name,
      from,
      skills: { project: projectSkills.length, loaded: userSkills.filter(forClaude).length + loadedProject.length + pluginLoaded.length },
      plugins: { project: plugins.filter((p) => p.scope !== 'user').length, enabled: enabled.length },
      mcp: { project: mcpProject, total: mcpTotal },
      perTurnTokens,
      standard,
      changed: projectSkills.filter((s) => s.drift.change === 'upstream' || s.drift.change === 'local').length,
      usage: use,
      errors,
    });
  }
  return { projects, usageOn: !!usage, truncated: all.length > known.length, at: new Date(now).toISOString() };
}

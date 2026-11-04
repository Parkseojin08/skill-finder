// What is installed on this PC and how it matches the index (UI debate stage 3: shown only, nothing is run).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, posix, resolve, sep } from 'node:path';
import { extractSkillMeta } from '../analyze/frontmatter.ts';
import { riskLevel, skillRiskFlags, type RiskFlag, type RiskLevel } from '../analyze/risk.ts';
import { runClaude } from '../claude/cli.ts';
import { SKILLS_CLI_VERSION } from '../config.ts';
import type { Store } from '../db/store.ts';
import { truncate } from '../util/sanitize.ts';
import { skillTokens } from '../util/tokens.ts';
import { parseJsonArray } from './run.ts';

/** `same`: the installed SKILL.md is the indexed one; `changed`: the index holds different text (newer or edited). */
export type Change = 'same' | 'changed' | 'unknown';

export type InstalledSkill = {
  scope: 'user' | 'project';
  path: string;
  folder: string;
  name: string;
  description: string;
  removeCommand: string;
  /** The indexed skill it came from; null when it cannot be told (installed some other way, or not indexed). */
  skillId: string | null;
  /** The current risk rules run on the installed files themselves. */
  risk: { level: RiskLevel; flags: RiskFlag[] };
  /** Its level when the app installed it, if the app did. */
  installedRisk: RiskLevel | null;
  change: Change;
  /** Context it takes (estimate): with every request, and when used. */
  tokens: { perTurn: number; onUse: number | null };
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** As the indexer hashes SKILL.md (indexer.ts buildSkillRow): line endings would otherwise make every copy differ. */
const mdHash = (raw: string) => sha256(raw.replace(/\r\n/g, '\n'));

/** Paths relative to the skill folder, for the "scripts" signal; at most 500, no dependency folders. */
async function listFiles(dir: string, prefix = '', out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= 500) break;
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) await listFiles(join(dir, e.name), rel, out);
    else out.push(rel);
  }
  return out;
}

type LockEntry = { source?: unknown; sourceType?: unknown; skillPath?: unknown };
/** skills CLI lock files: `skills-lock.json` in a project, `~/.agents/.skill-lock.json` for the user. */
function readLock(file: string): Map<string, string> {
  const byFolder = new Map<string, string>();
  try {
    const skills = (JSON.parse(readFileSync(file, 'utf8')) as { skills?: Record<string, LockEntry> }).skills ?? {};
    for (const [folder, e] of Object.entries(skills)) {
      if (typeof e.source !== 'string' || typeof e.skillPath !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(e.source)) continue;
      if (e.sourceType !== undefined && e.sourceType !== 'github') continue; // gitlab etc. are not gh: rows
      const dir = posix.dirname(e.skillPath.replace(/\\/g, '/'));
      // index ids keep the repo part in lower case (indexer.ts), so an exact lookup finds "ECC" as "ecc"
      byFolder.set(folder.toLowerCase(), `gh:${e.source.toLowerCase()}:${dir === '.' ? '' : dir}`);
    }
  } catch {
    // no lock file, or not one we can read
  }
  return byFolder;
}

/** The folder the skills CLI installs a skill into (its `sanitizeName`, the same in skills@1.7.4 and 1.7.6). */
export function skillFolderName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '').slice(0, 255) || 'unnamed-skill';
}

/**
 * Installed skill folders of one scope, each matched to the index by, in order: the skills CLI lock file
 * (source + path), the app's own install log (same name), or an identical SKILL.md (hash). `onlyFolder` limits
 * the scan to that folder.
 */
export async function scanInstalledSkills(store: Store, scope: 'user' | 'project', projectPath: string | null, onlyFolder?: string): Promise<InstalledSkill[]> {
  const root = scope === 'user' ? homedir() : projectPath!;
  const dir = join(root, '.claude', 'skills');
  const lock = readLock(scope === 'user' ? join(homedir(), '.agents', '.skill-lock.json') : join(root, 'skills-lock.json'));
  const logged = new Map<string, { id: string; risk: string | null }>();
  for (const l of store.listInstalledSkillLog()) {
    if (l.scope !== scope || (scope === 'project' && l.project_path?.toLowerCase() !== root.toLowerCase())) continue;
    const name = store.getSkill(l.skill_id)?.name.toLowerCase();
    if (name && !logged.has(name)) logged.set(name, { id: l.skill_id, risk: l.risk_level });
  }
  let entries: string[] = [];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: InstalledSkill[] = [];
  for (const folder of entries.sort()) {
    if (onlyFolder && folder.toLowerCase() !== onlyFolder.toLowerCase()) continue;
    const path = join(dir, folder);
    const hit = await inspectSkill(store, path, folder, (name) => {
      const log = logged.get(name.toLowerCase()) ?? logged.get(folder.toLowerCase());
      const fromLock = lock.get(folder.toLowerCase());
      const id = (fromLock && store.getSkill(fromLock)?.id) || (log && store.getSkill(log.id) ? log.id : null);
      return { id: id || null, installedRisk: log && log.id === id ? (log.risk as RiskLevel | null) : null };
    });
    if (!hit) continue; // not a skill folder
    out.push({
      ...hit,
      scope,
      removeCommand: `npx skills@${SKILLS_CLI_VERSION} remove ${/\s/.test(folder) ? `"${folder}"` : folder} -a claude-code -y${scope === 'user' ? ' -g' : ''}`,
    });
  }
  return out;
}

/**
 * One skill folder as installed: its SKILL.md, the current risk rules run on its files, and its index row — the one
 * `known` names (lock file, install log, plugin), else an indexed copy of the same SKILL.md. Null without a SKILL.md.
 */
async function inspectSkill(
  store: Store,
  path: string,
  folder: string,
  known: (name: string) => { id: string | null; installedRisk: RiskLevel | null },
): Promise<Omit<InstalledSkill, 'scope' | 'removeCommand'> | null> {
  let raw: string;
  try {
    raw = await readFile(join(path, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const meta = extractSkillMeta(raw, folder);
  const hash = mdHash(raw);
  const { id, installedRisk } = known(meta.name);
  const skillId = id ?? store.findSkillIdByMdSha(hash);
  const indexed = skillId ? store.getSkill(skillId) : undefined;
  const flags = skillRiskFlags({ files: await listFiles(path), allowedTools: meta.allowedTools, body: meta.body, hasHooks: meta.hasHooks, raw });
  return {
    path,
    folder,
    name: meta.name,
    description: truncate(meta.description, 200),
    skillId,
    risk: { level: riskLevel(flags), flags },
    installedRisk: id && id === skillId ? installedRisk : null,
    change: !indexed?.skill_md_sha256 ? 'unknown' : indexed.skill_md_sha256 === hash ? 'same' : 'changed',
    tokens: skillTokens(meta.name, meta.description, raw),
  };
}

/** A skill a plugin brought in: removed with the plugin, and loaded only while the plugin is on. */
export type PluginSkill = Omit<InstalledSkill, 'removeCommand'> & { plugin: { id: string; scope: string; enabled: boolean | null } };

/**
 * The skills inside an installed plugin, read from its install folder (user report 2026-11-04: the 설치됨 screen
 * listed a plugin's skills only when the index knew them, folded away, so a project's skills looked incomplete).
 * Claude Code reads the plugin's `skills/` folder plus the `skills` path(s) of `.claude-plugin/plugin.json`; each
 * path is a skill folder or a folder of them, and must stay inside the install folder.
 */
export async function scanPluginSkills(store: Store, plugin: { id: string; scope: string; installPath: unknown; enabled: boolean | null }): Promise<PluginSkill[]> {
  if (typeof plugin.installPath !== 'string' || !plugin.installPath) return [];
  const root = resolve(plugin.installPath);
  let declared: unknown;
  try {
    declared = (JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { skills?: unknown }).skills;
  } catch {
    // no manifest: the default folder only
  }
  const paths = ['skills', ...(typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared.filter((p): p is string => typeof p === 'string') : [])];
  const candidates: string[] = [];
  for (const p of paths) {
    const dir = resolve(root, p);
    if (existsSync(join(dir, 'SKILL.md'))) {
      candidates.push(dir);
      continue;
    }
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory() || e.isSymbolicLink()) candidates.push(join(dir, e.name));
    } catch {
      // no such folder
    }
  }
  // a path or a link leading out of the plugin is not read: compared by where it really is
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return [];
  const dirs = new Set<string>();
  for (const dir of candidates) {
    const real = await realpath(dir).catch(() => null);
    if (real && (real === realRoot || real.startsWith(realRoot + sep))) dirs.add(dir);
  }
  const indexedByName = new Map(pluginSkills(store, plugin.id).map((s) => [s.name.toLowerCase(), s.id]));
  const out: PluginSkill[] = [];
  for (const path of [...dirs].sort()) {
    const folder = basename(path);
    const hit = await inspectSkill(store, path, folder, (name) => ({ id: indexedByName.get(name.toLowerCase()) ?? indexedByName.get(folder.toLowerCase()) ?? null, installedRisk: null }));
    if (hit) out.push({ ...hit, scope: plugin.scope === 'project' || plugin.scope === 'local' ? 'project' : 'user', plugin: { id: plugin.id, scope: plugin.scope, enabled: plugin.enabled } });
  }
  return out;
}

/** A folder the skills CLI would overwrite (it installs with `-y`, D-5): who it is, as far as the app can tell. */
export type ExistingSkill = {
  path: string;
  name: string;
  /** true: this indexed skill again (a reinstall); false: another one; null: cannot tell (no SKILL.md, or not indexed). */
  same: boolean | null;
  change: Change;
};

export async function existingSkillFolder(store: Store, skillId: string, skillName: string, scope: 'user' | 'project', projectPath: string | null): Promise<ExistingSkill | null> {
  const folder = skillFolderName(skillName);
  const path = join(scope === 'user' ? homedir() : projectPath!, '.claude', 'skills', folder);
  if (!existsSync(path)) return null;
  const [hit] = await scanInstalledSkills(store, scope, projectPath, folder);
  if (!hit) return { path, name: folder, same: null, change: 'unknown' };
  const same = hit.skillId == null ? null : hit.skillId === skillId;
  return { path: hit.path, name: hit.name, same, change: same ? hit.change : 'unknown' };
}

export type InstalledPlugin = {
  id: string;
  version: unknown;
  scope: string;
  projectPath: string | null;
  installPath: unknown;
  /** Claude Code's own `enabled` (for the folder it ran in). */
  enabled: unknown;
};

/** `claude plugin list --json`, kept for a minute per folder; installs and uninstalls drop it (forgetPlugins). */
const pluginCache = new Map<string, { at: number; value: Promise<{ plugins: InstalledPlugin[]; error: string | null }> }>();
const PLUGIN_CACHE_MS = 60_000;

export function forgetPlugins(): void {
  pluginCache.clear();
}

/** `fresh`: ask Claude Code now (the installed page, where a change made in a terminal must show at once). */
export function listInstalledPlugins(cwd: string = homedir(), fresh = false): Promise<{ plugins: InstalledPlugin[]; error: string | null }> {
  const hit = pluginCache.get(cwd);
  if (!fresh && hit && Date.now() - hit.at < PLUGIN_CACHE_MS) return hit.value;
  const value = runClaude(['plugin', 'list', '--json'], { cwd, timeoutMs: 60_000 })
    .then((list) => ({
      plugins: (parseJsonArray(list.stdout) ?? []).map((p) => {
        const o = p as Record<string, unknown>;
        return {
          id: String(o.id ?? ''),
          version: o.version ?? null,
          scope: typeof o.scope === 'string' ? o.scope : 'user',
          projectPath: typeof o.projectPath === 'string' ? o.projectPath : null,
          installPath: o.installPath ?? null,
          enabled: o.enabled ?? null,
        };
      }),
      error: list.exitCode !== 0 ? 'claude plugin list 실패' : null,
    }))
    .catch((err: unknown) => ({ plugins: [], error: String((err as Error).message ?? err) }));
  pluginCache.set(cwd, { at: Date.now(), value });
  // a failure is not kept: the next call asks again
  void value.then((v) => v.error && pluginCache.delete(cwd));
  return value;
}

/** The commit Claude Code installed each plugin from (`~/.claude/plugins/installed_plugins.json`), by id and scope. */
export function installedPluginCommits(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const file = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const plugins = (JSON.parse(readFileSync(file, 'utf8')) as { plugins?: Record<string, Array<Record<string, unknown>>> }).plugins ?? {};
    for (const [id, installs] of Object.entries(plugins)) {
      for (const i of Array.isArray(installs) ? installs : []) {
        if (typeof i.gitCommitSha === 'string') out.set(pluginCommitKey(id, String(i.scope), typeof i.projectPath === 'string' ? i.projectPath : null), i.gitCommitSha);
      }
    }
  } catch {
    // Claude Code keeps this file; without it the commit is unknown
  }
  return out;
}

/** Windows paths compared as Claude Code writes them: backslashes, no trailing one, any case. */
export const pathKey = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
export const pluginCommitKey = (id: string, scope: string, projectPath: string | null) => `${id}|${scope}|${scope === 'user' ? '' : pathKey(projectPath ?? '')}`;

/** How a plugin install compares with the index: its skills' top risk and whether it came from the indexed commit. */
/** The indexed skills a plugin install brought in (its own, or those whose install plan names it), for the 설치됨 screen. */
export function pluginSkills(store: Store, id: string): Array<{ id: string; name: string; riskLevel: RiskLevel }> {
  const at = id.lastIndexOf('@');
  const rows = store.getPlugin(id) ? store.listSkillsByPlugin(id) : at > 0 ? store.listSkillsByInstallPlugin(id.slice(at + 1), id.slice(0, at)) : [];
  return rows.map((s) => ({ id: s.id, name: s.name, riskLevel: (s.risk_level ?? 'low') as RiskLevel }));
}

export function pluginIndexInfo(store: Store, id: string, commit: string | undefined): { indexed: boolean; topRisk: RiskLevel | null; change: Change } {
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
  const top = (skills: Array<{ risk_level: string | null }>) => skills.reduce<RiskLevel>((t, s) => (rank[s.risk_level as RiskLevel] > rank[t] ? (s.risk_level as RiskLevel) : t), 'low');
  const plugin = store.getPlugin(id);
  if (!plugin) {
    // installed from a repo's own marketplace: known through the skills whose install plan points at it
    const at = id.lastIndexOf('@');
    const skills = at > 0 ? store.listSkillsByInstallPlugin(id.slice(at + 1), id.slice(0, at)) : [];
    return skills.length ? { indexed: true, topRisk: top(skills), change: 'unknown' } : { indexed: false, topRisk: null, change: 'unknown' };
  }
  const topRisk = top(store.listSkillsByPlugin(id));
  const indexedAt = plugin.skills_indexed_sha;
  return { indexed: true, topRisk, change: !commit || !indexedAt ? 'unknown' : commit === indexedAt ? 'same' : 'changed' };
}

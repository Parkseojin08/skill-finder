// What is installed on this PC and how it matches the index (UI debate stage 3: shown only, nothing is run).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, posix, resolve, sep } from 'node:path';
import { extractSkillMeta } from '../analyze/frontmatter.ts';
import { riskLevel, skillRiskFlags, type RiskFlag, type RiskLevel } from '../analyze/risk.ts';
import { runClaude } from '../claude/cli.ts';
import { SKILLS_CLI_VERSION } from '../config.ts';
import type { Store } from '../db/store.ts';
import { looksBinary } from '../util/http.ts';
import { FOLD_CASE, pathKey, sameName } from '../util/paths.ts';
import { truncate } from '../util/sanitize.ts';
import { isTextPath, MAX_FILE_BYTES } from '../util/textFiles.ts';
import { skillTokens } from '../util/tokens.ts';
import { wasPreviousVersion } from '../watch/notices.ts';
import { agentFolders, agentRef, CLAUDE_CODE, type AgentRef } from './agents.ts';
import { parseJsonArray } from './run.ts';
import { SCAN_MAX_FILES, textFileFlags } from './scan.ts';

/** `same`: the installed SKILL.md is the indexed one; `changed`: the index holds different text (newer or edited). */
export type Change = 'same' | 'changed' | 'unknown';

/**
 * Which side changed (feature review F6), from three SKILL.md hashes: the installed copy now, the one installed (the
 * app's install log, or a version an earlier new-commit notice saw replaced), and the index's (kept current by the
 * repo watch, B3). `latest`: the installed copy is the indexed one. `upstream`: the copy is as installed and the
 * original has a newer version. `local`: the copy differs from what was installed (edited here). `unknown`: not
 * indexed, or no record of what was installed while it differs (`differs`).
 */
export type DriftKind = 'latest' | 'upstream' | 'local' | 'unknown';
export type Drift = {
  change: DriftKind;
  /** upstream: when the indexed version was committed (the repo's last push as the index knows it). */
  newCommitAt: string | null;
  /** upstream: the level installed (or of the copy) and the indexed version's level. */
  riskFrom: RiskLevel | null;
  riskTo: RiskLevel | null;
  /** The indexed commit (what "차이 보기" compares with). */
  indexedRef: string | null;
  /** local: the original moved on as well (a reinstall would bring the new version and drop the edits). */
  upstreamToo: boolean;
  /** unknown: an indexed copy exists and differs, but which side changed cannot be told. */
  differs: boolean;
};

export type InstalledSkill = {
  scope: 'user' | 'project';
  path: string;
  folder: string;
  name: string;
  description: string;
  removeCommand: string;
  /** The indexed skill it came from; null when it cannot be told (installed some other way, or not indexed). */
  skillId: string | null;
  /** The current risk rules run on the installed files themselves: SKILL.md, and the text files beside it. */
  risk: { level: RiskLevel; flags: RiskFlag[] };
  /** Text files other than SKILL.md with a signal (scripts first, at most SCAN_MAX_FILES read). */
  fileFindings: Array<{ path: string; flags: RiskFlag[] }>;
  /** Its level when the app installed it, if the app did. */
  installedRisk: RiskLevel | null;
  change: Change;
  /** F6: which side changed and how (kept beside `change`, which the install preview and the page still read). */
  drift: Drift;
  /** Context it takes (estimate): with every request, and when used. */
  tokens: { perTurn: number; onUse: number | null };
  /** The agents that read this folder: one row for a folder several share (F9 stage 1). */
  agents: AgentRef[];
  /**
   * A skill folder right under one of agents.ts's folders, where the app removes from (D#0763, widened in stage 2 to
   * those folders: uninstall.ts agentSkillsRoot); plugin skills go with their plugin.
   */
  removable: boolean;
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

/** As scan.ts orders a folder's files before an install: scripts first, then the rest in path order. */
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|ps1|psm1|bat|cmd)$/i;

/** Text rules per local file, kept while its size and modification time stay the same (the page asks often). */
const fileFlagCache = new Map<string, { size: number; mtimeMs: number; flags: RiskFlag[] }>();
const FILE_CACHE_MAX = 5000;

/**
 * The text rules of the install check (scan.ts textFileFlags) run on a local skill folder's other text files
 * (feature review P8): skills installed some other way were judged on SKILL.md alone. At most SCAN_MAX_FILES files of
 * up to MAX_FILE_BYTES each, read from disk only; binary-looking, larger and unreadable files are passed over.
 */
async function localFileFindings(dir: string, files: string[]): Promise<Array<{ path: string; flags: RiskFlag[] }>> {
  const text = files
    .filter((f) => f !== 'SKILL.md' && isTextPath(f))
    .sort((a, b) => Number(SCRIPT_EXT.test(b)) - Number(SCRIPT_EXT.test(a)) || a.localeCompare(b))
    .slice(0, SCAN_MAX_FILES);
  const out: Array<{ path: string; flags: RiskFlag[] }> = [];
  for (const rel of text) {
    const full = join(dir, ...rel.split('/'));
    let flags: RiskFlag[];
    try {
      const st = await stat(full);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const hit = fileFlagCache.get(full);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) flags = hit.flags;
      else {
        const body = await readFile(full, 'utf8');
        flags = looksBinary(body) ? [] : textFileFlags(body);
        if (fileFlagCache.size >= FILE_CACHE_MAX) fileFlagCache.clear();
        fileFlagCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, flags });
      }
    } catch {
      continue; // gone or unreadable: not checked
    }
    if (flags.length) out.push({ path: rel, flags });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * One skill of a skills CLI lock file, as skills@1.7.6 writes it (`projectLockEntry`): the project lock keeps `ref`
 * (the branch or tag asked for, often none) and `computedHash` (computeSkillFolderHash of the skill folder); the
 * user lock keeps `skillFolderHash` instead. Unknown or mistyped fields are left out.
 */
export type LockEntry = { name: string; source: string | null; sourceType: string | null; sourceUrl: string | null; skillPath: string | null; ref: string | null; computedHash: string | null };

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** The entries of a lock file; null when there is no file or it cannot be read (not JSON, no `skills` object). */
export function readLockEntries(file: string): LockEntry[] | null {
  let skills: unknown;
  try {
    skills = (JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as { skills?: unknown }).skills;
  } catch {
    return null;
  }
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return null;
  return Object.entries(skills as Record<string, Record<string, unknown> | null>).map(([name, e]) => ({
    name,
    source: str(e?.source),
    sourceType: str(e?.sourceType),
    sourceUrl: str(e?.sourceUrl),
    skillPath: str(e?.skillPath),
    ref: str(e?.ref),
    computedHash: str(e?.computedHash),
  }));
}

/** The index id a lock entry names: GitHub sources only (gitlab etc. are not gh: rows). */
export function lockSkillId(e: Pick<LockEntry, 'source' | 'sourceType' | 'skillPath'>): string | null {
  if (!e.source || !e.skillPath || !/^[^/\s]+\/[^/\s]+$/.test(e.source)) return null;
  if (e.sourceType !== null && e.sourceType !== 'github') return null;
  const dir = posix.dirname(e.skillPath.replace(/\\/g, '/'));
  // index ids keep the repo part in lower case (indexer.ts), so an exact lookup finds "ECC" as "ecc"
  return `gh:${e.source.toLowerCase()}:${dir === '.' ? '' : dir}`;
}

/** skills CLI lock files: `skills-lock.json` in a project, `~/.agents/.skill-lock.json` for the user. */
function readLock(file: string): Map<string, string> {
  const byFolder = new Map<string, string>();
  for (const e of readLockEntries(file) ?? []) {
    const id = lockSkillId(e);
    if (id) byFolder.set(lockFolderKey(e.name), id);
  }
  return byFolder;
}

/**
 * A lock entry's folder, as found by folder name (lock.get(lockFolderKey(folder))). Where case tells folders apart,
 * the folder the skills CLI made (skillFolderName), so that a folder of another case written by hand is not taken for
 * it; elsewhere any case, as before.
 */
const lockFolderKey = (name: string) => (FOLD_CASE ? name.toLowerCase() : skillFolderName(name));

/** The folder the skills CLI installs a skill into (its `sanitizeName`, the same in skills@1.7.4 and 1.7.6). */
export function skillFolderName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '').slice(0, 255) || 'unnamed-skill';
}

export type ScanOptions = {
  /** `all` (default): every agent folder of agents.ts; `claude`: Claude Code's only (what an install overwrites). */
  agents?: 'all' | 'claude';
  /** The home folder (tests); the user's own otherwise. */
  home?: string;
};

/**
 * Installed skill folders of one scope, in Claude Code's folder and the other agents' (F9 stage 1), each matched to
 * the index by, in order: the skills CLI lock file (source + path), the app's own install log (same name, Claude
 * Code's folder only: the app installs nowhere else), or an identical SKILL.md (hash). A folder reached twice (the
 * CLI links an agent's folder to `~/.agents/skills`) is one row with every agent that reads it. `onlyFolder` limits
 * the scan to that folder.
 */
export async function scanInstalledSkills(store: Store, scope: 'user' | 'project', projectPath: string | null, onlyFolder?: string, opts: ScanOptions = {}): Promise<InstalledSkill[]> {
  const home = opts.home ?? homedir();
  const root = scope === 'user' ? home : projectPath!;
  const lock = readLock(scope === 'user' ? join(home, '.agents', '.skill-lock.json') : join(root, 'skills-lock.json'));
  const logged = new Map<string, { id: string; risk: string | null; md: string | null }>();
  for (const l of installedSkillLog(store)) {
    if (l.scope !== scope || (scope === 'project' && (l.project_path == null || pathKey(l.project_path) !== pathKey(root)))) continue;
    const name = store.getSkill(l.skill_id)?.name.toLowerCase();
    if (name && !logged.has(name)) logged.set(name, { id: l.skill_id, risk: l.risk_level, md: l.skill_md_sha256 });
  }
  const folders = agentFolders(scope, root).filter((f) => opts.agents !== 'claude' || f.agents.some((a) => a.id === CLAUDE_CODE));
  const out: InstalledSkill[] = [];
  const byReal = new Map<string, InstalledSkill>();
  for (const { dir, agents } of folders) {
    const isClaude = agents.some((a) => a.id === CLAUDE_CODE);
    let entries: string[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
    } catch {
      continue; // no such folder
    }
    for (const folder of entries.sort()) {
      if (onlyFolder && !sameName(folder, onlyFolder)) continue;
      const path = join(dir, folder);
      const real = pathKey(await realpath(path).catch(() => path));
      const seen = byReal.get(real);
      if (seen) {
        for (const a of agents) if (!seen.agents.some((x) => x.id === a.id)) seen.agents.push(agentRef(a));
        continue;
      }
      const hit = await inspectSkill(store, path, folder, (name) => {
        const log = isClaude ? (logged.get(name.toLowerCase()) ?? logged.get(folder.toLowerCase())) : undefined;
        const fromLock = lock.get(FOLD_CASE ? folder.toLowerCase() : folder);
        const id = (fromLock && store.getSkill(fromLock)?.id) || (log && store.getSkill(log.id) ? log.id : null);
        const ours = !!log && log.id === id;
        return { id: id || null, installedRisk: ours ? (log.risk as RiskLevel | null) : null, installedMd: ours ? log.md : null };
      });
      if (!hit) continue; // not a skill folder
      const quoted = /\s/.test(folder) ? `"${folder}"` : folder;
      const row: InstalledSkill = {
        ...hit,
        scope,
        agents: agents.map(agentRef),
        removable: true,
        removeCommand: `npx skills@${SKILLS_CLI_VERSION} remove ${quoted} ${agents.map((a) => `-a ${a.id}`).join(' ')} -y${scope === 'user' ? ' -g' : ''}`,
      };
      byReal.set(real, row);
      out.push(row);
    }
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
  known: (name: string) => { id: string | null; installedRisk: RiskLevel | null; installedMd?: string | null },
): Promise<Omit<InstalledSkill, 'scope' | 'removeCommand' | 'agents' | 'removable'> | null> {
  let raw: string;
  try {
    raw = await readFile(join(path, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const meta = extractSkillMeta(raw, folder);
  const hash = mdHash(raw);
  const { id, installedRisk, installedMd } = known(meta.name);
  const skillId = id ?? store.findSkillIdByMdSha(hash);
  const indexed = skillId ? store.getSkill(skillId) : undefined;
  const files = await listFiles(path);
  const fileFindings = await localFileFindings(path, files);
  const flags = [...new Set([...skillRiskFlags({ files, allowedTools: meta.allowedTools, body: meta.body, hasHooks: meta.hasHooks, raw }), ...fileFindings.flatMap((f) => f.flags)])];
  const ownInstall = !!id && id === skillId;
  const drift = driftOf(store, indexed, hash, ownInstall ? (installedMd ?? null) : null, (ownInstall ? installedRisk : null) ?? riskLevel(flags));
  return {
    path,
    folder,
    name: meta.name,
    description: truncate(meta.description, 200),
    skillId,
    risk: { level: riskLevel(flags), flags },
    fileFindings,
    installedRisk: id && id === skillId ? installedRisk : null,
    change: !indexed?.skill_md_sha256 ? 'unknown' : indexed.skill_md_sha256 === hash ? 'same' : 'changed',
    drift,
    tokens: skillTokens(meta.name, meta.description, raw),
  };
}

/** The app's own skills-CLI installs, newest first, with the SKILL.md hash each installed (the store's list lacks it). */
function installedSkillLog(store: Store): Array<{ skill_id: string; scope: string; project_path: string | null; risk_level: string | null; skill_md_sha256: string | null }> {
  return store.db
    .prepare(
      `SELECT skill_id, scope, project_path, risk_level, skill_md_sha256 FROM install_log
        WHERE skill_id IS NOT NULL AND exit_code = 0 AND method = 'skills-cli' ORDER BY id DESC`,
    )
    .all() as Array<{ skill_id: string; scope: string; project_path: string | null; risk_level: string | null; skill_md_sha256: string | null }>;
}

const RISK_LEVELS = new Set<string>(['low', 'medium', 'high']);
const asLevel = (v: string | null | undefined): RiskLevel | null => (v && RISK_LEVELS.has(v) ? (v as RiskLevel) : null);

/**
 * F6: the installed copy (`local`), what was installed (`installedMd`: the app's log; else a version an earlier
 * new-commit notice saw replaced, which the copy still is) and the index's version. `fromRisk`: the level installed,
 * or the copy's own.
 */
export function driftOf(
  store: Store,
  indexed: { id: string; skill_md_sha256: string | null; risk_level: string | null; ref: string | null; last_commit_at: string | null; fetched_at: string | null } | undefined,
  local: string,
  installedMd: string | null,
  fromRisk: RiskLevel | null,
): Drift {
  const base: Drift = { change: 'unknown', newCommitAt: null, riskFrom: null, riskTo: null, indexedRef: indexed?.ref ?? null, upstreamToo: false, differs: false };
  const latest = indexed?.skill_md_sha256;
  if (!indexed || !latest) return base;
  if (latest === local) return { ...base, change: 'latest' };
  const baseline = installedMd ?? (wasPreviousVersion(store, indexed.id, local) ? local : null);
  if (!baseline) return { ...base, differs: true };
  if (baseline === local) {
    return { ...base, change: 'upstream', newCommitAt: indexed.last_commit_at ?? indexed.fetched_at, riskFrom: fromRisk, riskTo: asLevel(indexed.risk_level) };
  }
  return { ...base, change: 'local', upstreamToo: baseline !== latest };
}

const claudeRef: AgentRef = { id: CLAUDE_CODE, name: 'Claude Code' };

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
    // plugins are Claude Code's own; removed with the plugin, never on their own
    if (hit) out.push({ ...hit, scope: plugin.scope === 'project' || plugin.scope === 'local' ? 'project' : 'user', agents: [claudeRef], removable: false, plugin: { id: plugin.id, scope: plugin.scope, enabled: plugin.enabled } });
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
  const [hit] = await scanInstalledSkills(store, scope, projectPath, folder, { agents: 'claude' });
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
  for (const e of installedPluginEntries()) if (e.gitCommitSha) out.set(pluginCommitKey(e.id, e.scope, e.projectPath), e.gitCommitSha);
  return out;
}

/** Every plugin install `installed_plugins.json` lists (the repo watch, B3, reads them without asking Claude Code). */
export function installedPluginEntries(home: string = homedir()): Array<{ id: string; scope: string; projectPath: string | null; gitCommitSha: string | null }> {
  const out: Array<{ id: string; scope: string; projectPath: string | null; gitCommitSha: string | null }> = [];
  try {
    const file = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const plugins = (JSON.parse(readFileSync(file, 'utf8')) as { plugins?: Record<string, Array<Record<string, unknown>>> }).plugins ?? {};
    for (const [id, installs] of Object.entries(plugins)) {
      for (const i of Array.isArray(installs) ? installs : []) {
        if (!i || typeof i !== 'object') continue;
        out.push({
          id,
          scope: String(i.scope),
          projectPath: typeof i.projectPath === 'string' ? i.projectPath : null,
          gitCommitSha: typeof i.gitCommitSha === 'string' ? i.gitCommitSha : null,
        });
      }
    }
  } catch {
    // Claude Code keeps this file; without it the commit is unknown
  }
  return out;
}

// the comparison rule lives in util/paths.ts (the database layer uses it too); kept importable from here
export { pathKey, pathWithin, sameName } from '../util/paths.ts';
export const pluginCommitKey = (id: string, scope: string, projectPath: string | null) => `${id}|${scope}|${scope === 'user' ? '' : pathKey(projectPath ?? '')}`;

/** How a plugin install compares with the index: its skills' top risk and whether it came from the indexed commit. */
/** The indexed skills a plugin install brought in (its own, or those whose install plan names it), for the 설치됨 screen. */
export function pluginSkills(store: Store, id: string): Array<{ id: string; name: string; riskLevel: RiskLevel }> {
  const at = id.lastIndexOf('@');
  const rows = store.getPlugin(id) ? store.listSkillsByPlugin(id) : at > 0 ? store.listSkillsByInstallPlugin(id.slice(at + 1), id.slice(0, at)) : [];
  return rows.map((s) => ({ id: s.id, name: s.name, riskLevel: (s.risk_level ?? 'low') as RiskLevel }));
}

/**
 * F6 for a plugin: the marketplace now points at another commit than the one installed (`claude plugin update` would
 * bring it in). `highRisk`: the indexed skills at that commit with level high. Only shown; the app updates nothing (D-7).
 */
export type PinMoved = { from: string; to: string; highRisk: number; highSkills: string[]; command: string };

export function pluginIndexInfo(
  store: Store,
  id: string,
  commit: string | undefined,
): { indexed: boolean; topRisk: RiskLevel | null; change: Change; pinMoved?: PinMoved } {
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
  const top = (skills: Array<{ risk_level: string | null }>) => skills.reduce<RiskLevel>((t, s) => (rank[s.risk_level as RiskLevel] > rank[t] ? (s.risk_level as RiskLevel) : t), 'low');
  const plugin = store.getPlugin(id);
  if (!plugin) {
    // installed from a repo's own marketplace: known through the skills whose install plan points at it
    const at = id.lastIndexOf('@');
    const skills = at > 0 ? store.listSkillsByInstallPlugin(id.slice(at + 1), id.slice(0, at)) : [];
    return skills.length ? { indexed: true, topRisk: top(skills), change: 'unknown' } : { indexed: false, topRisk: null, change: 'unknown' };
  }
  const skills = store.listSkillsByPlugin(id);
  const topRisk = top(skills);
  const indexedAt = plugin.skills_indexed_sha;
  const change: Change = !commit || !indexedAt ? 'unknown' : commit === indexedAt ? 'same' : 'changed';
  if (change !== 'changed') return { indexed: true, topRisk, change };
  const high = skills.filter((s) => s.risk_level === 'high').map((s) => s.name);
  return { indexed: true, topRisk, change, pinMoved: { from: commit!, to: indexedAt!, highRisk: high.length, highSkills: high.slice(0, 10), command: pluginUpdateCommand(id) } };
}

/** What the user would run to take the marketplace's new commit (shown and copied only, D-7; never `--yes`). */
export const pluginUpdateCommand = (id: string) => `claude plugin update ${id}`;

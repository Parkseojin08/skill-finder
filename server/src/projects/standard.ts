// A project's standard (feature review F12): what its committed files say it uses — the skills CLI's
// `skills-lock.json` and the `enabledPlugins` / `extraKnownMarketplaces` of `.claude/settings.json` — set against
// what is installed for it. Read only: nothing is installed or changed here. A missing skill is installed through
// the team preset dialog (decision 20), never from this module.
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { listClaudePlugins } from '../agentConfig/read.ts';
import { agentFolders, agentRef, CLAUDE_CODE, type AgentRef } from '../install/agents.ts';
import { lockSkillId, pathKey, readLockEntries, skillFolderName, type LockEntry } from '../install/installed.ts';

export type StandardStatus = 'ok' | 'missing' | 'differs' | 'extra' | 'disabled' | 'unregistered';
/** The states that make `check` fail; `extra` (installed, not in the standard) is only reported. */
export const FAILING: readonly StandardStatus[] = ['missing', 'differs', 'disabled', 'unregistered'];

/** Why a skill's content could not be compared: no hash in the lock, a folder too big to hash, or one leading out. */
export type HashNote = 'noLockHash' | 'tooLarge' | 'outside' | 'unreadable';

export type PresetItem = { id?: string; plugin?: string; name: string };

export type StandardItem = {
  kind: 'skill' | 'plugin' | 'marketplace';
  name: string;
  status: StandardStatus;
  /** skill: the lock's source (owner/repo or a URL), ref (a branch or tag, often none) and SKILL.md path. */
  source: string | null;
  ref: string | null;
  skillPath: string | null;
  /** skill: the index id the lock names (GitHub sources only). */
  skillId: string | null;
  /** skill: the installed folders found (every agent's), and the agents that read them. */
  paths: string[];
  agents: AgentRef[];
  /** skill: installed, but in no folder Claude Code reads (another agent's only). */
  notForClaude: boolean;
  /** skill: the lock's computedHash and the installed folder's, made the way the skills CLI makes it. */
  lockHash: string | null;
  localHash: string | null;
  hashNote: HashNote | null;
  /** plugin: its marketplace; marketplace: the source the settings give (a GitHub repo, a URL), when one is. */
  marketplace: string | null;
  /** What the team preset dialog takes to install it (missing ones only). */
  preset: PresetItem | null;
};

export type FileRead = 'read' | 'missing' | 'unreadable';

export type ProjectStandard = {
  projectPath: string;
  files: { lock: FileRead; settings: FileRead };
  /** A lock file with skills, or settings with plugins or marketplaces. Without one there is nothing to compare. */
  hasStandard: boolean;
  /** Nothing in FAILING. */
  ok: boolean;
  counts: Record<StandardStatus, number>;
  items: StandardItem[];
  /** The missing ones, for the team preset dialog (/presets/resolve). */
  missingPreset: PresetItem[];
  /**
   * The app installs a skill at the commit it indexed and checked, not at the lock's (install-scan takes no ref):
   * a missing skill installed from here may differ from the lock and then shows as `differs`.
   */
  refNote: boolean;
};

/** Hashing stops past these: a skill folder this big is not one the lock check is for. */
export const HASH_MAX_FILES = 2000;
export const HASH_MAX_BYTES = 64 * 1024 * 1024;

export class TooLarge extends Error {}

/**
 * skills@1.7.6 `computeSkillFolderHash`: every regular file under the folder (no `.git`, `node_modules`; links inside
 * are passed over, as the CLI's Dirent checks do), sorted by `/`-separated relative path with localeCompare, then
 * sha256 over path and bytes in turn. The CLI hashes the source folder, which may hold a `metadata.json` or
 * `__pycache__` its copy leaves out: such a skill shows as `differs` though nobody changed it. Null when the folder
 * cannot be read; throws TooLarge past HASH_MAX_FILES / HASH_MAX_BYTES.
 */
export async function skillFolderHash(dir: string): Promise<string | null> {
  const files: Array<{ rel: string; full: string }> = [];
  let bytes = 0;
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        await walk(full);
      } else if (e.isFile()) {
        if (files.length >= HASH_MAX_FILES) throw new TooLarge();
        bytes += (await stat(full)).size;
        if (bytes > HASH_MAX_BYTES) throw new TooLarge();
        files.push({ rel: relative(dir, full).split('\\').join('/'), full });
      }
    }
  };
  try {
    await walk(dir);
  } catch (err) {
    if (err instanceof TooLarge) throw err;
    return null;
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f.rel);
    hash.update(await readFile(f.full));
  }
  return hash.digest('hex');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** `.claude/settings.json` (the committed one): enabledPlugins and extraKnownMarketplaces; null when unreadable. */
function readProjectSettings(file: string): { state: FileRead; enabled: Map<string, boolean>; markets: Map<string, string | null> } {
  const empty = { enabled: new Map<string, boolean>(), markets: new Map<string, string | null>() };
  if (!existsSync(file)) return { state: 'missing', ...empty };
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { state: 'unreadable', ...empty };
  }
  if (!isObj(v)) return { state: 'unreadable', ...empty };
  const enabled = new Map<string, boolean>();
  if (isObj(v.enabledPlugins)) for (const [id, on] of Object.entries(v.enabledPlugins)) if (typeof on === 'boolean' && id.length <= 300) enabled.set(id, on);
  const markets = new Map<string, string | null>();
  if (isObj(v.extraKnownMarketplaces)) for (const [name, m] of Object.entries(v.extraKnownMarketplaces)) if (name.length <= 200) markets.set(name, marketSource(isObj(m) ? m.source : null));
  return { state: 'read', enabled, markets };
}

/**
 * A URL without its `user:token@` part: a marketplace added with a token in its address must not carry it into the
 * check's output or a snippet meant for the repository (review 2026-11-10).
 */
export const withoutUserinfo = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');

/** A marketplace source as text: `owner/repo` for GitHub, else its URL; a local path is not shown. */
function marketSource(s: unknown): string | null {
  if (!isObj(s)) return null;
  if (typeof s.repo === 'string') return s.repo.slice(0, 200);
  if (typeof s.url === 'string') return withoutUserinfo(s.url).slice(0, 300);
  return null;
}

/** Marketplaces Claude Code has added on this PC (`~/.claude/plugins/known_marketplaces.json`), by name. */
export function knownMarketplaces(home: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  try {
    const v = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8').replace(/^\uFEFF/, '')) as unknown;
    if (isObj(v)) for (const [name, m] of Object.entries(v)) out.set(name, isObj(m) ? m.source : null);
  } catch {
    // none added, or not readable
  }
  return out;
}

/** Claude Code's own marketplace, there without being added. */
const BUILT_IN_MARKETS = new Set(['claude-plugins-official']);

const marketOf = (pluginId: string) => {
  const at = pluginId.lastIndexOf('@');
  return at > 0 ? pluginId.slice(at + 1) : null;
};

type Folder = { name: string; path: string; agents: AgentRef[] };

/** The skill folders of the project, every agent's, one per real folder (the CLI links agents' folders together). */
async function projectSkillFolders(projectPath: string): Promise<Folder[]> {
  const out: Folder[] = [];
  for (const { dir, agents } of agentFolders('project', projectPath)) {
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const path = join(dir, name);
      if (!existsSync(join(path, 'SKILL.md'))) continue;
      out.push({ name, path, agents: agents.map(agentRef) });
    }
  }
  return out;
}

const blank = (kind: StandardItem['kind'], name: string, status: StandardStatus): StandardItem => ({
  kind,
  name,
  status,
  source: null,
  ref: null,
  skillPath: null,
  skillId: null,
  paths: [],
  agents: [],
  notForClaude: false,
  lockHash: null,
  localHash: null,
  hashNote: null,
  marketplace: null,
  preset: null,
});

/** Whether `child` (a real path) is inside `root` (a real path). */
const inside = (root: string, child: string) => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

export type StandardOptions = { home?: string };

/** The standard of one project folder (an existing absolute directory: the route checks it). */
export async function projectStandard(projectPath: string, opts: StandardOptions = {}): Promise<ProjectStandard> {
  const home = opts.home ?? homedir();
  const lockFile = join(projectPath, 'skills-lock.json');
  const lock: LockEntry[] | null = readLockEntries(lockFile);
  const lockState: FileRead = lock ? 'read' : existsSync(lockFile) ? 'unreadable' : 'missing';
  const settings = readProjectSettings(join(projectPath, '.claude', 'settings.json'));
  const realRoot = await realpath(projectPath).catch(() => projectPath);
  const items: StandardItem[] = [];

  // --- skills: skills-lock.json against the project's skill folders ---
  const folders = await projectSkillFolders(projectPath);
  const claimed = new Set<string>();
  for (const e of lock ?? []) {
    const want = skillFolderName(e.name);
    const found = folders.filter((f) => f.name.toLowerCase() === want || f.name.toLowerCase() === e.name.toLowerCase());
    const item: StandardItem = { ...blank('skill', e.name, 'ok'), source: e.source, ref: e.ref, skillPath: e.skillPath, skillId: lockSkillId(e), lockHash: e.computedHash };
    for (const f of found) claimed.add(pathKey(f.path));
    item.paths = found.map((f) => f.path);
    item.agents = found.flatMap((f) => f.agents).filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i);
    if (!found.length) {
      item.status = 'missing';
      item.preset = item.skillId ? { id: item.skillId, name: e.name } : null;
      items.push(item);
      continue;
    }
    item.notForClaude = !item.agents.some((a) => a.id === CLAUDE_CODE);
    if (!e.computedHash) {
      item.hashNote = 'noLockHash';
      items.push(item);
      continue;
    }
    // each copy (another agent's folder may hold its own): the lock's content if any copy has it
    let matched = false;
    let note: HashNote | null = null;
    for (const f of found) {
      const real = await realpath(f.path).catch(() => null);
      if (!real) {
        note = 'unreadable';
        continue;
      }
      if (!inside(realRoot, real)) {
        note = 'outside';
        continue;
      }
      let h: string | null;
      try {
        h = await skillFolderHash(f.path);
      } catch {
        note = 'tooLarge';
        continue;
      }
      if (!h) {
        note = 'unreadable';
        continue;
      }
      item.localHash ??= h;
      if (h === e.computedHash) {
        matched = true;
        item.localHash = h;
        break;
      }
    }
    if (!matched) {
      if (item.localHash) item.status = 'differs';
      else item.hashNote = note; // nothing could be hashed: shown as installed, content not compared
    }
    items.push(item);
  }
  // installed for the project, not in the lock: reported only (a hand-made skill kept in git is one)
  if (lock) {
    const extra = new Map<string, StandardItem>();
    for (const f of folders) {
      if (claimed.has(pathKey(f.path))) continue;
      const key = f.name.toLowerCase();
      const hit = extra.get(key) ?? { ...blank('skill', f.name, 'extra') };
      hit.paths.push(f.path);
      for (const a of f.agents) if (!hit.agents.some((x) => x.id === a.id)) hit.agents.push(a);
      hit.notForClaude = !hit.agents.some((a) => a.id === CLAUDE_CODE);
      extra.set(key, hit);
    }
    items.push(...extra.values());
  }

  // --- plugins and marketplaces: .claude/settings.json against installed_plugins.json and the settings in force ---
  const known = knownMarketplaces(home);
  const isKnown = (m: string | null) => !!m && (known.has(m) || BUILT_IN_MARKETS.has(m));
  const wanted = [...settings.enabled].filter(([, on]) => on).map(([id]) => id);
  const installed = lock || settings.state === 'read' ? await listClaudePlugins({ home, projectPath }) : [];
  for (const id of wanted) {
    const market = marketOf(id);
    const item: StandardItem = { ...blank('plugin', id, 'ok'), marketplace: market };
    const here = installed.filter((p) => p.id === id);
    if (!here.length) {
      item.status = isKnown(market) ? 'missing' : 'unregistered';
      item.preset = { plugin: id, name: id.split('@')[0] };
    } else if (!here.some((p) => p.enabled)) {
      item.status = 'disabled'; // settings.local.json (or another file in force) turns it off
    }
    items.push(item);
  }
  for (const p of installed) {
    if (p.scope !== 'project' || settings.enabled.has(p.id) || items.some((i) => i.kind === 'plugin' && i.name === p.id)) continue;
    items.push({ ...blank('plugin', p.id, 'extra'), marketplace: marketOf(p.id) });
  }
  for (const [name, source] of settings.markets) {
    items.push({ ...blank('marketplace', name, isKnown(name) ? 'ok' : 'unregistered'), marketplace: source });
  }

  const counts: Record<StandardStatus, number> = { ok: 0, missing: 0, differs: 0, extra: 0, disabled: 0, unregistered: 0 };
  for (const i of items) counts[i.status]++;
  const hasStandard = (lock?.length ?? 0) > 0 || settings.enabled.size > 0 || settings.markets.size > 0;
  const missingPreset = items.filter((i) => i.preset && (i.status === 'missing' || i.status === 'unregistered')).map((i) => i.preset!);
  return {
    projectPath,
    files: { lock: lockState, settings: settings.state },
    hasStandard,
    ok: !items.some((i) => FAILING.includes(i.status)) && lockState !== 'unreadable' && settings.state !== 'unreadable',
    counts,
    items,
    missingPreset,
    refNote: items.some((i) => i.kind === 'skill' && i.status === 'missing' && !!i.preset),
  };
}

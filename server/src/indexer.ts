import { createHash } from 'node:crypto';
import { extractSkillMeta } from './analyze/frontmatter.ts';
import { qualityWarnings } from './analyze/quality.ts';
import { pluginRiskFlags, RISK_RULES_VERSION, riskLevel, skillRiskFlags, TEXT_RISK_FLAGS, type PluginSignals, type RiskFlag } from './analyze/risk.ts';
import { discoverRepo, parseJsonObject, PLUGIN_JSON, type RepoDiscovery } from './discovery/classifyRepo.ts';
import { genericAcceptor, type GenericAcceptor } from './discovery/genericRules.ts';
import { discoverPluginSkills, type MarketplaceEntry } from './discovery/pluginRules.ts';
import { basename, joinPath, skillMdPath, TreeIndex } from './discovery/tree.ts';
import type { PluginRow, SkillRow, Store } from './db/store.ts';
import { textFileFlags } from './install/scan.ts';
import { RepoUnreachableError } from './sources/gitTree.ts';
import { RAW_MAX_BYTES, type GitHub, type RepoTree } from './sources/github.ts';
import { normalizeSource, resolveRelativeRoot } from './sources/pluginSource.ts';
import { pool } from './util/limiter.ts';
import { sanitizeText } from './util/sanitize.ts';
import { SizedCache } from './util/sizedCache.ts';

export type StoredPluginEntry = { entry: MarketplaceEntry; pluginRoot: string | null };

/** Extra install context for skills found in repos that are not registered marketplaces. */
export type RepoInstallInfo = {
  mode: 'marketplace' | 'plugin' | 'generic';
  marketplaceName: string | null;
  marketplaceRepo: string;
  pluginName: string | null;
  signals: PluginSignals | null;
};

/**
 * The marketplace entry points at something that is not there (deleted/private repo, a pinned commit
 * erased from history, a folder that does not exist). Claude Code could not install it either; it is
 * recorded as 설치 불가 and not retried until the marketplace changes the entry.
 */
export class PluginUnavailableError extends Error {}

export type StoredFiles ={ files: Array<{ path: string; size: number | null }>; total: number };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const MAX_FILES_STORED = 500;

export const skillId = (repo: string, dirPath: string) => `gh:${repo.toLowerCase()}:${dirPath}`;

export function normalizeSkillName(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, '-');
}

/** The validator used in generic mode: name and description must be non-empty strings (skills CLI rule). */
export function genericValidator(raw: string): { name: string; description: string } | null {
  const meta = extractSkillMeta(raw, '');
  if (!meta.nameFromFrontmatter || !meta.descriptionFromFrontmatter) return null;
  const internal = (meta.frontmatter.metadata as Record<string, unknown> | undefined)?.internal === true;
  return internal ? null : { name: meta.nameFromFrontmatter, description: meta.descriptionFromFrontmatter };
}

type BuildArgs = {
  repo: string;
  sha: string;
  dirPath: string;
  raw: string;
  tree: TreeIndex;
  origin: SkillRow['origin'];
  pluginId: string | null;
  extraFlags: RiskFlag[];
  install: RepoInstallInfo | null;
  lastCommitAt: string | null;
};

export function buildSkillRow(a: BuildArgs): SkillRow {
  const folderName = a.dirPath ? basename(a.dirPath) : (a.repo.split('/')[1] ?? '');
  const meta = extractSkillMeta(a.raw, folderName);
  const files = a.tree.filesUnder(a.dirPath);
  const relPaths = files.map((f) => f.path);
  const flags = [
    ...new Set([
      ...skillRiskFlags({
        files: relPaths,
        allowedTools: meta.allowedTools,
        body: meta.body,
        hasHooks: meta.hasHooks,
        raw: a.raw,
        partial: checkedInPart(meta, a.raw),
      }),
      ...a.extraFlags,
    ]),
  ];
  const stored: StoredFiles = {
    files: files.slice(0, MAX_FILES_STORED).map((f) => ({ path: f.path, size: f.size })),
    total: files.length,
  };
  return {
    id: skillId(a.repo, a.dirPath),
    origin: a.origin,
    plugin_id: a.pluginId,
    repo: a.repo,
    ref: a.sha,
    dir_path: a.dirPath,
    name: meta.name || folderName,
    description: meta.description || null,
    when_to_use: meta.whenToUse,
    frontmatter_json: JSON.stringify(meta.frontmatter),
    body_lines: meta.bodyLines,
    skill_md_sha256: sha256(a.raw.replace(/\r\n/g, '\n')),
    name_desc_sha256: sha256(`${meta.name}\n${meta.description}`),
    installs: null,
    quality_json: JSON.stringify(qualityWarnings(meta, folderName)),
    risk_json: JSON.stringify(flags),
    risk_level: riskLevel(flags),
    risk_rules: RISK_RULES_VERSION,
    last_commit_at: a.lastCommitAt,
    fetched_at: now(),
    files_json: JSON.stringify(stored),
    install_json: a.install ? JSON.stringify(a.install) : null,
  };
}

/** A download cut at the limit (a split multi-byte character at the end costs at most 3 bytes), or a frontmatter too large to parse. */
const checkedInPart = (meta: { frontmatterTooLarge: boolean }, raw: string) => meta.frontmatterTooLarge || Buffer.byteLength(raw) >= RAW_MAX_BYTES - 3;

/**
 * A stored row's risk under the current rules, from its SKILL.md text: the text flags are computed again, the
 * others (scripts from the file list, the plugin's own flags) are kept. Null when `raw` is not the file the row
 * was built from (its hash differs), so nothing is judged on another version of the skill.
 */
export function recheckRisk(row: SkillRow, raw: string): { risk_json: string; risk_level: string } | null {
  if (!row.skill_md_sha256 || sha256(raw.replace(/\r\n/g, '\n')) !== row.skill_md_sha256) return null;
  const folderName = row.dir_path ? basename(row.dir_path) : (row.repo?.split('/')[1] ?? '');
  const meta = extractSkillMeta(raw, folderName);
  const fromText = skillRiskFlags({ files: [], allowedTools: meta.allowedTools, body: meta.body, hasHooks: meta.hasHooks, raw, partial: checkedInPart(meta, raw) });
  const old = (row.risk_json ? JSON.parse(row.risk_json) : []) as RiskFlag[];
  // the stored order is kept, so a row whose flags did not change is stored exactly as before
  const flags = [...old.filter((f) => !TEXT_RISK_FLAGS.has(f) || fromText.includes(f)), ...fromText.filter((f) => !old.includes(f))];
  return { risk_json: JSON.stringify(flags), risk_level: riskLevel(flags) };
}

export function pluginFtsText(p: PluginRow | null): string {
  if (!p) return '';
  return [p.name, p.display_name, p.description, p.category, p.keywords].filter(Boolean).join(' ');
}

/** Rows written per transaction when a whole repo is indexed. */
const WRITE_BATCH = 50;

/**
 * `skills`: installable skills found (0 when `unchanged`); `removed`: rows deleted because their SKILL.md is gone.
 * `sha`: the head commit, null when some skill could not be read (so the next run reads the repo again).
 */
export type RepoIndexResult = { skills: number; sha: string | null; unchanged: boolean; removed: number };

/**
 * One piece of what a plugin runs (hooks, MCP servers, monitors, bin/ files) and where it is written. `flags`: the
 * text rules (download-and-run, rm -rf) on its commands (feature review F3 minimal, P1).
 */
export type RunConfigItem = { kind: 'hooks' | 'mcp' | 'monitors' | 'bin'; source: string; text: string; truncated: boolean; flags: RiskFlag[] };
/** `findings`: the items with a signal, as the file scan reports them (the page's confirm tick reads them). */
export type PluginRunConfig = { commit: string; items: RunConfigItem[]; findings: Array<{ kind: RunConfigItem['kind']; source: string; flags: RiskFlag[] }> };
const RUN_CONFIG_MAX_CHARS = 16_000;

/**
 * The command lines of a hooks / MCP / monitors config: each object's `command` with its `args` after it, as they
 * would run. Walked without recursion (a deeply nested file cannot overflow the stack). Text that is not JSON is
 * checked whole.
 */
export function runConfigCommands(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [value as string];
    }
  }
  const lines: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') continue;
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === 'object') stack.push(x);
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.command === 'string') {
      const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : [];
      lines.push([o.command, ...args].join(' '));
    } else if (Array.isArray(o.command)) {
      lines.push(o.command.filter((a): a is string => typeof a === 'string').join(' '));
    }
    for (const x of Object.values(o)) if (x && typeof x === 'object') stack.push(x);
  }
  return lines;
}

/** The text rules on a config's command lines (each line on its own, so one command's pipe never meets another's). */
export function runConfigFlags(value: unknown): RiskFlag[] {
  const flags = new Set<RiskFlag>();
  for (const line of runConfigCommands(value)) for (const f of textFileFlags(line)) flags.add(f);
  return [...flags];
}

type RepoSnapshot ={ tree: RepoTree; index: TreeIndex; read: (path: string) => Promise<string | null> };
/** What single-skill lookups need from a repo: its tree, plugin layout, and the generic rules per folder. */
type RepoLookup = { snap: RepoSnapshot; discovery: RepoDiscovery; generic: GenericAcceptor };

export class Indexer {
  private readonly store: Store;
  private readonly github: GitHub;
  /** Bounded by tree entries (perf debate 1-3): a lookup holds its tree and the SKILL.md texts read, ~770B each. */
  private readonly discoveryCache = new SizedCache<RepoLookup>({ maxSize: 60_000, ttlMs: 10 * 60 * 1000, sizeOf: (l) => l.snap.index.files.size });

  constructor(store: Store, github: GitHub) {
    this.store = store;
    this.github = github;
  }

  private async snapshot(repo: string, sha: string | 'HEAD'): Promise<RepoSnapshot> {
    const tree = sha === 'HEAD' ? await this.github.getTreeAtHead(repo) : await this.github.getTree(repo, sha);
    sha = tree.sha;
    const index = new TreeIndex(tree.entries);
    const memo = new Map<string, Promise<string | null>>();
    // null only means "not there" (not in the tree, or a 404). A failed download throws, so a busy
    // GitHub is never mistaken for a missing SKILL.md (that used to drop real skills from results).
    const read = (path: string) => {
      let p = memo.get(path);
      if (!p) {
        p = index.hasFile(path)
          ? this.github.getRawText(repo, sha, path).then((r) => {
              if (r.text != null || r.status === 404) return r.text;
              throw new Error(`${repo}/${path} 읽기 실패 (${r.status})`);
            })
          : Promise.resolve(null);
        p.catch(() => memo.delete(path));
        memo.set(path, p);
      }
      return p;
    };
    return { tree, index, read };
  }

  private async lastCommitAt(repo: string, tree: RepoTree): Promise<string | null> {
    const meta = await this.github.getRepoMeta(repo).catch(() => null);
    return meta?.pushed_at ?? tree.commitDate;
  }

  /** A GitHub plugin's marketplace entry, commit, tree, folder and plugin.json, as the index reads them. */
  private async openPlugin(plugin: PluginRow) {
    const repo = plugin.repo!;
    const stored = (plugin.entry_json ? JSON.parse(plugin.entry_json) : null) as StoredPluginEntry | null;
    const entry = stored?.entry ?? ({ name: plugin.name, source: JSON.parse(plugin.source_json) } as MarketplaceEntry);
    const src = normalizeSource(entry.source, stored?.pluginRoot);
    const sha = plugin.sha ?? (await this.github.resolveRef(repo, plugin.ref))?.sha;
    if (!sha) throw new Error('커밋을 찾을 수 없습니다');
    const snap = await this.snapshot(repo, sha);
    const root = src.kind === 'relative' ? resolveRelativeRoot(src.raw, stored?.pluginRoot ?? null, snap.index) : (plugin.path ?? '');
    if (root == null || !snap.index.hasDir(root)) throw new Error(`플러그인 경로가 없습니다: ${root ?? '?'}`);
    const manifestPath = joinPath(root, PLUGIN_JSON);
    const manifest = snap.index.hasFile(manifestPath) ? parseJsonObject(await snap.read(manifestPath)) : null;
    return { entry, src, sha, snap, root, manifest };
  }

  /**
   * What a plugin runs once installed, as written in it (project review F1): its hooks, MCP servers, monitors and
   * bin/ files, from hooks/hooks.json, .mcp.json, monitors/monitors.json, plugin.json and the marketplace entry.
   * Only read and shown; nothing here is run.
   */
  async pluginRunConfig(pluginId: string): Promise<PluginRunConfig> {
    const plugin = this.store.getPlugin(pluginId);
    if (!plugin?.repo) throw new Error('GitHub에 있는 플러그인이 아니라 읽을 수 없습니다');
    const { entry, sha, snap, root, manifest } = await this.openPlugin(plugin);
    const items: RunConfigItem[] = [];
    const show = (kind: RunConfigItem['kind'], source: string, value: unknown) => {
      const text = sanitizeText(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      // the whole config is checked, not only the part shown; bin/ is a file list, not commands
      const flags = kind === 'bin' ? [] : runConfigFlags(value);
      items.push({ kind, source, text: text.slice(0, RUN_CONFIG_MAX_CHARS), truncated: text.length > RUN_CONFIG_MAX_CHARS, flags });
    };
    const readFile = async (kind: RunConfigItem['kind'], rel: string) => {
      const path = joinPath(root, rel.replace(/^\.\//, ''));
      const text = await snap.read(path).catch(() => null);
      if (text != null) show(kind, path, text);
    };
    // a component field is inline config, or a path (or paths) to it inside the plugin
    const fromField = async (kind: RunConfigItem['kind'], field: unknown, source: string) => {
      if (field == null) return;
      if (typeof field === 'string') await readFile(kind, field);
      else if (Array.isArray(field) && field.every((f) => typeof f === 'string')) for (const f of field) await readFile(kind, f);
      else show(kind, source, field);
    };
    const manifestPath = joinPath(root, PLUGIN_JSON);
    if (snap.index.hasFile(joinPath(root, 'hooks/hooks.json'))) await readFile('hooks', 'hooks/hooks.json');
    await fromField('hooks', manifest?.hooks, `${manifestPath} hooks`);
    await fromField('hooks', entry.hooks, 'marketplace.json hooks');
    if (snap.index.hasFile(joinPath(root, '.mcp.json'))) await readFile('mcp', '.mcp.json');
    await fromField('mcp', manifest?.mcpServers, `${manifestPath} mcpServers`);
    await fromField('mcp', entry.mcpServers, 'marketplace.json mcpServers');
    if (snap.index.hasFile(joinPath(root, 'monitors/monitors.json'))) await readFile('monitors', 'monitors/monitors.json');
    await fromField('monitors', manifest?.monitors, `${manifestPath} monitors`);
    const bin = [...snap.index.files.keys()].filter((f) => f.startsWith(joinPath(root, 'bin') + '/'));
    if (bin.length) show('bin', joinPath(root, 'bin'), bin.slice(0, 50).join('\n') + (bin.length > 50 ? `\n… 외 ${bin.length - 50}개` : ''));
    const findings = items.filter((it) => it.flags.length > 0).map((it) => ({ kind: it.kind, source: it.source, flags: it.flags }));
    return { commit: sha, items, findings };
  }

  /** Indexes the skills of one marketplace plugin; replaces its previous skill rows. Returns the skill count. */
  async indexPlugin(pluginId: string): Promise<number> {
    const plugin = this.store.getPlugin(pluginId);
    if (!plugin) throw new Error(`unknown plugin ${pluginId}`);
    if (!plugin.repo) {
      this.store.markPluginIndexed(pluginId, null, null, 'GitHub 외 출처라 스킬을 색인하지 않습니다');
      return 0;
    }
    try {
      const { entry, src, sha, snap, root, manifest } = await this.openPlugin(plugin);
      const d = discoverPluginSkills(snap.index, root, manifest, entry, {
        entryAtMarketplaceRoot: src.kind === 'relative' && root === '',
      });
      const extraFlags = pluginRiskFlags(d.signals, plugin.source_kind);
      const lastCommitAt = await this.lastCommitAt(plugin.repo, snap.tree);
      const results = await pool(d.skillDirs, 8, async (dirPath) => {
        const raw = await snap.read(skillMdPath(dirPath));
        if (raw == null) return null;
        return buildSkillRow({
          repo: plugin.repo!,
          sha,
          dirPath,
          raw,
          tree: snap.index,
          origin: 'plugin',
          pluginId,
          extraFlags,
          install: null,
          lastCommitAt,
        });
      });
      const rows = results.flatMap((r) => (r?.ok && r.value ? [r.value] : []));
      // A SKILL.md that could not be downloaded (busy GitHub) is not a removed skill: its old row stays, and no
      // commit is recorded so the next sync reads the plugin again. Dropping it hid a high-risk sibling from the
      // plugin-wide warning until the plugin changed (project review 2026-11-02), as indexRepo already avoids.
      const failed = results.filter((r) => !r?.ok).length;
      const text = pluginFtsText(plugin);
      this.store.transaction(() => {
        const keep = new Set(rows.map((r) => r.id));
        if (!failed) for (const old of this.store.listSkillsByPlugin(pluginId)) if (!keep.has(old.id)) this.store.deleteSkill(old.id);
        for (const row of rows) this.store.upsertSkill(row, text);
        this.store.markPluginIndexed(
          pluginId,
          failed ? null : (plugin.sha ?? sha),
          { ...d.signals, strictConflict: d.strictConflict },
          failed ? `SKILL.md ${failed}개를 읽지 못해 다음 동기화 때 다시 읽습니다` : null,
        );
      });
      return rows.length;
    } catch (err) {
      const reason = await this.unavailableReason(plugin.repo, err);
      if (reason) {
        // Indexed "as of" the marketplace's pinned commit, so it is skipped until the entry changes (an unpinned
        // entry is read again every sync, like a working one).
        this.store.markPluginIndexed(pluginId, plugin.sha, null, `설치 불가: ${reason}`);
        throw new PluginUnavailableError(reason);
      }
      // No indexed sha → the next sync retries it.
      this.store.markPluginIndexed(pluginId, null, null, String((err as Error).message ?? err).slice(0, 300));
      throw err;
    }
  }

  /** Why a plugin can never be indexed as listed, or null for failures worth retrying (network, quota). */
  private async unavailableReason(repo: string, err: unknown): Promise<string | null> {
    const msg = String((err as Error)?.message ?? err);
    const path = msg.match(/^플러그인 경로가 없습니다: (.*)$/);
    if (path) return `마켓플레이스가 가리키는 폴더가 저장소에 없습니다 (${path[1]})`;
    if (err instanceof RepoUnreachableError) return '저장소가 삭제됐거나 비공개입니다';
    // "not our ref": git's answer for a pinned commit no branch holds any more (the tree API says 422)
    if (/^tree 422|^tree 409|not our ref/.test(msg)) return '마켓플레이스가 고정한 커밋이 저장소 기록에서 지워졌습니다';
    if (/^tree 404|커밋을 찾을 수 없습니다/.test(msg)) {
      const exists = await this.github.repoExists(repo);
      if (exists === false) return '저장소가 삭제됐거나 비공개입니다';
      if (exists === true && msg.startsWith('tree 404')) return '마켓플레이스가 고정한 커밋이 저장소에 없습니다';
    }
    return null;
  }

  /**
   * A repo at its default branch head, prepared for single-skill lookups; memoized for 10 minutes.
   * Plugin layouts come from the manifests; generic folders are judged one at a time on demand.
   */
  private discoverAtHead(repo: string): Promise<RepoLookup> {
    const key = repo.toLowerCase();
    let p = this.discoveryCache.get(key);
    if (!p) {
      p = (async () => {
        void this.github.getRepoMeta(repo).catch(() => null); // needed for the row's last commit; fetch alongside the tree
        const snap = await this.snapshot(repo, 'HEAD');
        const discovery = await discoverRepo(snap.index, snap.read, genericValidator, { genericSkills: false });
        return { snap, discovery, generic: genericAcceptor(snap.index, snap.read, genericValidator) };
      })();
      this.discoveryCache.set(key, p);
    }
    return p;
  }

  private async rowFromDiscovery(repo: string, snap: RepoSnapshot, discovery: RepoDiscovery, dirPath: string, raw: string): Promise<SkillRow> {
    const b = await this.buildFromDiscovery(repo, snap, discovery, dirPath, raw);
    if ('existing' in b) return b.existing;
    this.store.upsertSkill(b.row, b.text);
    return this.store.getSkill(b.row.id)!;
  }

  /** The row for one discovered folder, unwritten; or the marketplace-indexed row already there, which wins. */
  private async buildFromDiscovery(
    repo: string,
    snap: RepoSnapshot,
    discovery: RepoDiscovery,
    dirPath: string,
    raw: string,
  ): Promise<{ row: SkillRow; text: string } | { existing: SkillRow }> {
    const plugin = discovery.plugins.find((p) => p.skillDirs.includes(dirPath)) ?? null;
    const install: RepoInstallInfo = {
      mode: discovery.mode,
      marketplaceName: discovery.marketplaceName,
      marketplaceRepo: repo,
      pluginName: plugin?.name || null,
      signals: plugin?.signals ?? null,
    };
    const pluginRootDep = /\$\{?CLAUDE_PLUGIN_ROOT\}?/.test(raw);
    const viaPlugin = pluginRootDep && !!discovery.marketplaceName && !!plugin?.name;
    const row = buildSkillRow({
      repo,
      sha: snap.tree.sha,
      dirPath,
      raw,
      tree: snap.index,
      origin: 'generic',
      pluginId: null,
      extraFlags: viaPlugin ? pluginRiskFlags(plugin!.signals) : [],
      install,
      lastCommitAt: await this.lastCommitAt(repo, snap.tree),
    });
    const existing = this.store.getSkill(row.id);
    // A marketplace-indexed row for the same folder wins; only fill in what is new.
    if (existing?.origin === 'plugin') return { existing };
    return { row, text: plugin ? `${plugin.name}` : '' };
  }

  /**
   * SKILL.md text if `dir` is installable: listed by a marketplace plugin, or else by the skills CLI's
   * generic rules (which is how `skills add --skill` would find it). null otherwise.
   */
  private acceptDir(lookup: RepoLookup, dir: string): Promise<string | null> {
    if (lookup.discovery.plugins.some((p) => p.skillDirs.includes(dir))) return lookup.snap.read(skillMdPath(dir));
    return lookup.generic.accepts(dir);
  }

  /**
   * Finds a skill in a repo by name or folder name (skills.sh hits). Folders named like the skill are read
   * first (almost always the hit); the rest are read in small batches only if that fails.
   * Returns null when the repo has no such installable skill; throws when GitHub could not be read.
   */
  async findInRepo(repo: string, name: string, folderHint?: string | null): Promise<SkillRow | null> {
    const lookup = await this.discoverAtHead(repo);
    const want = new Set([normalizeSkillName(name), ...(folderHint ? [normalizeSkillName(folderHint)] : [])]);
    const dirs = [...new Set([...lookup.discovery.plugins.flatMap((p) => p.skillDirs), ...lookup.generic.candidates])];
    const byFolder = dirs.filter((d) => want.has(normalizeSkillName(basename(d || repo))));
    const matches = (dir: string, raw: string, folderMatch: boolean) => {
      const meta = extractSkillMeta(raw, basename(dir || repo));
      return normalizeSkillName(meta.name) === normalizeSkillName(name) || (folderMatch && !meta.nameFromFrontmatter);
    };
    for (const dir of byFolder) {
      const raw = await this.acceptDir(lookup, dir);
      if (raw != null && matches(dir, raw, true)) return this.rowFromDiscovery(repo, lookup.snap, lookup.discovery, dir, raw);
    }
    // Folder named differently from the skill: read folders whose path shares a word with the name
    // (or every folder in a small repo). Scanning hundreds of SKILL.md files for a name that is not
    // there cost ~10s and almost never found anything.
    const others = dirs.filter((d) => !byFolder.includes(d));
    const words = normalizeSkillName(name)
      .split(/[-.]+/)
      .filter((w) => w.length >= 3);
    const overlap = (d: string) => words.filter((w) => d.toLowerCase().includes(w)).length;
    const rest =
      others.length <= 48
        ? others
        : others
            .map((d) => ({ d, n: overlap(d) }))
            .filter((x) => x.n > 0)
            .sort((a, b) => b.n - a.n)
            .slice(0, 48)
            .map((x) => x.d);
    for (let i = 0; i < rest.length; i += 24) {
      const batch = rest.slice(i, i + 24);
      const raws = await Promise.all(batch.map((d) => this.acceptDir(lookup, d)));
      const hit = batch.findIndex((d, j) => raws[j] != null && matches(d, raws[j]!, false));
      if (hit >= 0) return this.rowFromDiscovery(repo, lookup.snap, lookup.discovery, batch[hit], raws[hit]!);
    }
    return null;
  }

  /**
   * Accepts a code-search hit only if a plugin or the generic rules list that folder (filters templates,
   * examples, invalid SKILL.md). Returns null when not installable; throws when GitHub could not be read.
   */
  async findByPath(repo: string, skillMdFile: string): Promise<SkillRow | null> {
    const dirPath = skillMdFile === 'SKILL.md' ? '' : skillMdFile.replace(/\/SKILL\.md$/, '');
    const lookup = await this.discoverAtHead(repo);
    if (!lookup.snap.index.hasFile(skillMdPath(dirPath))) return null;
    const raw = await this.acceptDir(lookup, dirPath);
    return raw == null ? null : this.rowFromDiscovery(repo, lookup.snap, lookup.discovery, dirPath, raw);
  }

  /**
   * Indexes every installable skill of one GitHub repo at its default branch (popular-repo collection):
   * marketplace/plugin layouts by their manifests, otherwise the skills CLI's generic rules. Rows already
   * indexed from a registered marketplace are left as they are.
   * - `unchangedSince`: the head commit last indexed; when the head is still that commit nothing is read.
   * - Rows are written 50 per transaction, yielding in between (20 autocommitted upserts took 111ms, one
   *   transaction 4.9ms, and a big repo no longer holds the event loop while it is written).
   * - After an index without failures, GitHub rows whose SKILL.md is no longer in the repo are deleted
   *   (rows an install was logged for stay).
   */
  async indexRepo(repo: string, opts: { unchangedSince?: string | null } = {}): Promise<RepoIndexResult> {
    const head = await this.github.resolveRef(repo, null);
    if (!head) throw new Error(`저장소를 찾을 수 없습니다: ${repo}`);
    if (opts.unchangedSince && head.sha === opts.unchangedSince) return { skills: 0, sha: head.sha, unchanged: true, removed: 0 };
    const snap = await this.snapshot(repo, head.sha);
    if (!snap.tree.entries.some((e) => e.path === 'SKILL.md' || e.path.endsWith('/SKILL.md'))) {
      return { skills: 0, sha: snap.tree.sha, unchanged: false, removed: this.removeVanished(repo, snap.index) };
    }
    const discovery = await discoverRepo(snap.index, snap.read, genericValidator);
    const found: Array<{ dir: string; raw: string | null }> = [
      ...discovery.generic.map((g) => ({ dir: g.dirPath, raw: g.raw as string | null })),
      ...[...new Set(discovery.plugins.flatMap((p) => p.skillDirs))].map((dir) => ({ dir, raw: null })),
    ].slice(0, 500);
    const built = await pool(found, 8, async ({ dir, raw }) => {
      const text = raw ?? (await snap.read(skillMdPath(dir)));
      return text == null ? null : this.buildFromDiscovery(repo, snap, discovery, dir, text);
    });
    const writes = built.flatMap((b) => (b?.ok && b.value && 'row' in b.value ? [b.value] : []));
    for (let i = 0; i < writes.length; i += WRITE_BATCH) {
      this.store.transaction(() => {
        for (const w of writes.slice(i, i + WRITE_BATCH)) this.store.upsertSkill(w.row, w.text);
      });
      await new Promise((resolve) => setImmediate(resolve));
    }
    const failed = built.some((b) => !b?.ok);
    return {
      skills: built.filter((b) => b?.ok && b.value).length,
      sha: failed ? null : snap.tree.sha,
      unchanged: false,
      removed: failed ? 0 : this.removeVanished(repo, snap.index),
    };
  }

  /** Deletes this repo's GitHub-indexed rows whose SKILL.md the (complete) tree no longer has. */
  private removeVanished(repo: string, index: TreeIndex): number {
    const gone = this.store
      .findSkillsByRepo(repo)
      .filter((s) => s.origin === 'generic' && s.dir_path != null && !index.hasFile(skillMdPath(s.dir_path)))
      .map((s) => s.id);
    return gone.length ? this.store.deleteSkillsUnlessInstalled(gone) : 0;
  }

  /** Placeholder row for a skills.sh hit served from a well-known endpoint (no preview in the MVP). */
  wellKnownRow(domain: string, name: string, installs: number | null): SkillRow {
    const row: SkillRow = {
      id: `wk:${domain.toLowerCase()}:${name}`,
      origin: 'wellknown',
      plugin_id: null,
      repo: null,
      ref: null,
      dir_path: null,
      name,
      description: null,
      when_to_use: null,
      frontmatter_json: null,
      body_lines: null,
      skill_md_sha256: null,
      name_desc_sha256: null,
      installs,
      quality_json: '[]',
      risk_json: '[]',
      risk_level: 'low',
      last_commit_at: null,
      fetched_at: now(),
      files_json: null,
      install_json: JSON.stringify({ domain }),
    };
    this.store.upsertSkill(row, '');
    return this.store.getSkill(row.id)!;
  }

  /** Fresh tree for a stored skill (detail view file listing / file reads). */
  async treeFor(skill: SkillRow): Promise<TreeIndex | null> {
    if (!skill.repo || !skill.ref) return null;
    const tree = await this.github.getTree(skill.repo, skill.ref);
    return new TreeIndex(tree.entries);
  }
}

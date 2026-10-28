import { createHash } from 'node:crypto';
import { extractSkillMeta } from './analyze/frontmatter.ts';
import { qualityWarnings } from './analyze/quality.ts';
import { pluginRiskFlags, riskLevel, skillRiskFlags, type PluginSignals, type RiskFlag } from './analyze/risk.ts';
import { discoverRepo, parseJsonObject, PLUGIN_JSON, type RepoDiscovery } from './discovery/classifyRepo.ts';
import { genericAcceptor, type GenericAcceptor } from './discovery/genericRules.ts';
import { discoverPluginSkills, type MarketplaceEntry } from './discovery/pluginRules.ts';
import { basename, joinPath, skillMdPath, TreeIndex } from './discovery/tree.ts';
import type { PluginRow, SkillRow, Store } from './db/store.ts';
import { RAW_MAX_BYTES, type GitHub, type RepoTree } from './sources/github.ts';
import { normalizeSource, resolveRelativeRoot } from './sources/pluginSource.ts';
import { pool } from './util/limiter.ts';

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
        // a download cut at the limit (a split multi-byte character at the end costs at most 3 bytes)
        partial: meta.frontmatterTooLarge || Buffer.byteLength(a.raw) >= RAW_MAX_BYTES - 3,
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
    last_commit_at: a.lastCommitAt,
    fetched_at: now(),
    files_json: JSON.stringify(stored),
    install_json: a.install ? JSON.stringify(a.install) : null,
  };
}

export function pluginFtsText(p: PluginRow | null): string {
  if (!p) return '';
  return [p.name, p.display_name, p.description, p.category, p.keywords].filter(Boolean).join(' ');
}

type RepoSnapshot = { tree: RepoTree; index: TreeIndex; read: (path: string) => Promise<string | null> };
/** What single-skill lookups need from a repo: its tree, plugin layout, and the generic rules per folder. */
type RepoLookup = { snap: RepoSnapshot; discovery: RepoDiscovery; generic: GenericAcceptor };

export class Indexer {
  private readonly store: Store;
  private readonly github: GitHub;
  private readonly discoveryCache = new Map<string, Promise<RepoLookup>>();

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

  /** Indexes the skills of one marketplace plugin; replaces its previous skill rows. Returns the skill count. */
  async indexPlugin(pluginId: string): Promise<number> {
    const plugin = this.store.getPlugin(pluginId);
    if (!plugin) throw new Error(`unknown plugin ${pluginId}`);
    if (!plugin.repo) {
      this.store.markPluginIndexed(pluginId, null, null, 'GitHub 외 출처라 스킬을 색인하지 않습니다');
      return 0;
    }
    try {
      const stored = (plugin.entry_json ? JSON.parse(plugin.entry_json) : null) as StoredPluginEntry | null;
      const entry = stored?.entry ?? ({ name: plugin.name, source: JSON.parse(plugin.source_json) } as MarketplaceEntry);
      const src = normalizeSource(entry.source, stored?.pluginRoot);
      const sha = plugin.sha ?? (await this.github.resolveRef(plugin.repo, plugin.ref))?.sha;
      if (!sha) throw new Error('커밋을 찾을 수 없습니다');
      const snap = await this.snapshot(plugin.repo, sha);
      const root = src.kind === 'relative' ? resolveRelativeRoot(src.raw, stored?.pluginRoot ?? null, snap.index) : (plugin.path ?? '');
      if (root == null || !snap.index.hasDir(root)) throw new Error(`플러그인 경로가 없습니다: ${root ?? '?'}`);
      const manifestPath = joinPath(root, PLUGIN_JSON);
      const manifest = snap.index.hasFile(manifestPath) ? parseJsonObject(await snap.read(manifestPath)) : null;
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
      const text = pluginFtsText(plugin);
      this.store.transaction(() => {
        const keep = new Set(rows.map((r) => r.id));
        for (const old of this.store.listSkillsByPlugin(pluginId)) if (!keep.has(old.id)) this.store.deleteSkill(old.id);
        for (const row of rows) this.store.upsertSkill(row, text);
        this.store.markPluginIndexed(pluginId, plugin.sha ?? sha, { ...d.signals, strictConflict: d.strictConflict }, null);
      });
      return rows.length;
    } catch (err) {
      const reason = await this.unavailableReason(plugin.repo, err);
      if (reason) {
        // Indexed "as of" the marketplace's pinned commit, so it is skipped until the entry changes.
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
    if (/^tree 422|^tree 409/.test(msg)) return '마켓플레이스가 고정한 커밋이 저장소 기록에서 지워졌습니다';
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
      p.catch(() => this.discoveryCache.delete(key));
      this.discoveryCache.set(key, p);
      setTimeout(() => this.discoveryCache.delete(key), 10 * 60 * 1000).unref();
    }
    return p;
  }

  private async rowFromDiscovery(
    repo: string,
    snap: RepoSnapshot,
    discovery: RepoDiscovery,
    dirPath: string,
    raw: string,
  ): Promise<SkillRow> {
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
    if (existing?.origin === 'plugin') return existing;
    this.store.upsertSkill(row, plugin ? `${plugin.name}` : '');
    return this.store.getSkill(row.id)!;
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
   * indexed from a registered marketplace are left as they are. Returns how many skills the repo has.
   */
  async indexRepo(repo: string): Promise<number> {
    const snap = await this.snapshot(repo, 'HEAD');
    if (!snap.tree.entries.some((e) => e.path === 'SKILL.md' || e.path.endsWith('/SKILL.md'))) return 0;
    const discovery = await discoverRepo(snap.index, snap.read, genericValidator);
    const found: Array<{ dir: string; raw: string | null }> = [
      ...discovery.generic.map((g) => ({ dir: g.dirPath, raw: g.raw as string | null })),
      ...[...new Set(discovery.plugins.flatMap((p) => p.skillDirs))].map((dir) => ({ dir, raw: null })),
    ].slice(0, 500);
    const rows = await pool(found, 8, async ({ dir, raw }) => {
      const text = raw ?? (await snap.read(skillMdPath(dir)));
      return text == null ? null : this.rowFromDiscovery(repo, snap, discovery, dir, text);
    });
    return rows.filter((r) => r?.ok && r.value).length;
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

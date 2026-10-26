import { createHash } from 'node:crypto';
import { extractSkillMeta } from './analyze/frontmatter.ts';
import { qualityWarnings } from './analyze/quality.ts';
import { pluginRiskFlags, riskLevel, skillRiskFlags, type PluginSignals, type RiskFlag } from './analyze/risk.ts';
import { discoverRepo, parseJsonObject, PLUGIN_JSON, type RepoDiscovery } from './discovery/classifyRepo.ts';
import { discoverPluginSkills, type MarketplaceEntry } from './discovery/pluginRules.ts';
import { basename, joinPath, skillMdPath, TreeIndex } from './discovery/tree.ts';
import type { PluginRow, SkillRow, Store } from './db/store.ts';
import type { GitHub, RepoTree } from './sources/github.ts';
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

export type StoredFiles = { files: Array<{ path: string; size: number | null }>; total: number };

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
      ...skillRiskFlags({ files: relPaths, allowedTools: meta.allowedTools, body: meta.body, hasHooks: meta.hasHooks, raw: a.raw }),
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

export class Indexer {
  private readonly store: Store;
  private readonly github: GitHub;
  private readonly discoveryCache = new Map<string, Promise<{ snap: RepoSnapshot; discovery: RepoDiscovery }>>();

  constructor(store: Store, github: GitHub) {
    this.store = store;
    this.github = github;
  }

  private async snapshot(repo: string, sha: string | 'HEAD'): Promise<RepoSnapshot> {
    const tree = sha === 'HEAD' ? await this.github.getTreeAtHead(repo) : await this.github.getTree(repo, sha);
    sha = tree.sha;
    const index = new TreeIndex(tree.entries);
    const memo = new Map<string, Promise<string | null>>();
    const read = (path: string) => {
      let p = memo.get(path);
      if (!p) {
        p = index.hasFile(path)
          ? this.github
              .getRawText(repo, sha, path)
              .then((r) => r.text)
              .catch(() => null)
          : Promise.resolve(null);
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
      // No indexed sha → the next sync retries it.
      this.store.markPluginIndexed(pluginId, null, null, String((err as Error).message ?? err).slice(0, 300));
      throw err;
    }
  }

  /** Classifies and discovers a repo at its default branch head; memoized per commit. */
  private discoverAtHead(repo: string): Promise<{ snap: RepoSnapshot; discovery: RepoDiscovery }> {
    const key = repo.toLowerCase();
    let p = this.discoveryCache.get(key);
    if (!p) {
      p = (async () => {
        const snap = await this.snapshot(repo, 'HEAD');
        const discovery = await discoverRepo(snap.index, snap.read, genericValidator);
        return { snap, discovery };
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

  /** Finds a skill in a repo by name or folder name (skills.sh hits). */
  async findInRepo(repo: string, name: string, folderHint?: string | null): Promise<SkillRow | null> {
    const { snap, discovery } = await this.discoverAtHead(repo);
    const want = new Set([normalizeSkillName(name), ...(folderHint ? [normalizeSkillName(folderHint)] : [])]);
    if (discovery.mode === 'generic') {
      const hit =
        discovery.generic.find((g) => normalizeSkillName(g.name) === normalizeSkillName(name)) ??
        discovery.generic.find((g) => want.has(normalizeSkillName(basename(g.dirPath || repo))));
      return hit ? this.rowFromDiscovery(repo, snap, discovery, hit.dirPath, hit.raw) : null;
    }
    const dirs = [...new Set(discovery.plugins.flatMap((p) => p.skillDirs))];
    const byFolder = dirs.filter((d) => want.has(normalizeSkillName(basename(d || repo))));
    for (const group of [byFolder, dirs.filter((d) => !byFolder.includes(d)).slice(0, 200)]) {
      const raws = await Promise.all(group.map((d) => snap.read(skillMdPath(d))));
      for (let i = 0; i < group.length; i++) {
        const raw = raws[i];
        if (raw == null) continue;
        const meta = extractSkillMeta(raw, basename(group[i] || repo));
        if (normalizeSkillName(meta.name) === normalizeSkillName(name) || (group === byFolder && !meta.nameFromFrontmatter)) {
          return this.rowFromDiscovery(repo, snap, discovery, group[i], raw);
        }
      }
    }
    return null;
  }

  /** Accepts a code-search hit only if the discovery rules also list that folder (filters templates etc.). */
  async findByPath(repo: string, skillMdFile: string): Promise<SkillRow | null> {
    const dirPath = skillMdFile === 'SKILL.md' ? '' : skillMdFile.replace(/\/SKILL\.md$/, '');
    const { snap, discovery } = await this.discoverAtHead(repo);
    if (discovery.mode === 'generic') {
      const hit = discovery.generic.find((g) => g.dirPath === dirPath);
      return hit ? this.rowFromDiscovery(repo, snap, discovery, hit.dirPath, hit.raw) : null;
    }
    if (!discovery.plugins.some((p) => p.skillDirs.includes(dirPath))) return null;
    const raw = await snap.read(skillMdPath(dirPath));
    return raw == null ? null : this.rowFromDiscovery(repo, snap, discovery, dirPath, raw);
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

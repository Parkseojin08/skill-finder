import type { SQLInputValue, StatementSync } from 'node:sqlite';
import type { Db } from './index.ts';
import { tx } from './index.ts';

export type IndexMode = 'eager' | 'lazy';

export type MarketplaceRow = {
  name: string;
  repo: string;
  enabled: number;
  index_mode: IndexMode;
  etag: string | null;
  synced_at: string | null;
  plugin_count: number | null;
  commit_sha: string | null;
  error: string | null;
};

export type PluginRow = {
  id: string;
  marketplace: string;
  name: string;
  display_name: string | null;
  description: string | null;
  category: string | null;
  keywords: string | null;
  source_json: string;
  source_kind: string;
  repo: string | null;
  path: string | null;
  ref: string | null;
  sha: string | null;
  strict: number | null;
  signals_json: string | null;
  skills_indexed_at: string | null;
  error: string | null;
  skills_indexed_sha: string | null;
  entry_json: string | null;
};

export type SkillRow = {
  id: string;
  origin: 'plugin' | 'generic' | 'wellknown';
  plugin_id: string | null;
  repo: string | null;
  ref: string | null;
  dir_path: string | null;
  name: string;
  description: string | null;
  when_to_use: string | null;
  frontmatter_json: string | null;
  body_lines: number | null;
  skill_md_sha256: string | null;
  name_desc_sha256: string | null;
  installs: number | null;
  quality_json: string | null;
  risk_json: string | null;
  risk_level: string | null;
  last_commit_at: string | null;
  fetched_at: string | null;
  files_json: string | null;
  install_json: string | null;
};

export type RepoRow = {
  full_name: string;
  stars: number | null;
  pushed_at: string | null;
  archived: number | null;
  fork: number | null;
  license: string | null;
  default_branch: string | null;
  etag: string | null;
  fetched_at: string | null;
};

export type FtsSkillHit = { skill: SkillRow; bm25: number };
export type FtsPluginHit = { plugin: PluginRow; bm25: number };

const now = () => new Date().toISOString();

export class Store {
  readonly db: Db;
  private cache = new Map<string, StatementSync>();

  constructor(db: Db) {
    this.db = db;
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.stmt(sql).run(...params);
  }

  transaction<T>(fn: () => T): T {
    return tx(this.db, fn);
  }

  // ---- settings
  getSetting<T>(key: string): T | undefined {
    const row = this.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key);
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.run(
      'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      key,
      JSON.stringify(value),
    );
  }

  // ---- marketplaces
  listMarketplaces(): MarketplaceRow[] {
    return this.all<MarketplaceRow>('SELECT * FROM marketplaces ORDER BY rowid');
  }

  getMarketplace(name: string): MarketplaceRow | undefined {
    return this.get<MarketplaceRow>('SELECT * FROM marketplaces WHERE name = ?', name);
  }

  upsertMarketplace(m: { name: string; repo: string; enabled: boolean; index_mode: IndexMode }): void {
    this.run(
      `INSERT INTO marketplaces (name, repo, enabled, index_mode) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET repo = excluded.repo, enabled = excluded.enabled, index_mode = excluded.index_mode`,
      m.name,
      m.repo,
      m.enabled ? 1 : 0,
      m.index_mode,
    );
  }

  insertMarketplaceIfMissing(m: { name: string; repo: string; enabled: boolean; index_mode: IndexMode }): void {
    this.run(
      'INSERT OR IGNORE INTO marketplaces (name, repo, enabled, index_mode) VALUES (?, ?, ?, ?)',
      m.name,
      m.repo,
      m.enabled ? 1 : 0,
      m.index_mode,
    );
  }

  updateMarketplaceSync(
    name: string,
    patch: { etag?: string | null; plugin_count?: number; commit_sha?: string | null; error?: string | null },
  ): void {
    const cur = this.getMarketplace(name);
    if (!cur) return;
    this.run(
      'UPDATE marketplaces SET etag = ?, synced_at = ?, plugin_count = ?, commit_sha = ?, error = ? WHERE name = ?',
      patch.etag !== undefined ? patch.etag : cur.etag,
      now(),
      patch.plugin_count ?? cur.plugin_count,
      patch.commit_sha !== undefined ? patch.commit_sha : cur.commit_sha,
      patch.error ?? null,
      name,
    );
  }

  deleteMarketplace(name: string): void {
    this.transaction(() => {
      const ids = this.all<{ id: string }>('SELECT id FROM plugins WHERE marketplace = ?', name).map((r) => r.id);
      for (const id of ids) this.deletePlugin(id);
      this.run('DELETE FROM marketplaces WHERE name = ?', name);
    });
  }

  // ---- plugins
  getPlugin(id: string): PluginRow | undefined {
    return this.get<PluginRow>('SELECT * FROM plugins WHERE id = ?', id);
  }

  listPlugins(marketplace: string): PluginRow[] {
    return this.all<PluginRow>('SELECT * FROM plugins WHERE marketplace = ? ORDER BY name', marketplace);
  }

  countPlugins(): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM plugins')!.n;
  }

  /** Plugins whose skills were never indexed or whose pinned commit changed since indexing. */
  listPluginsNeedingIndex(marketplace: string): PluginRow[] {
    return this.all<PluginRow>(
      `SELECT * FROM plugins WHERE marketplace = ? AND repo IS NOT NULL
       AND (skills_indexed_at IS NULL OR skills_indexed_sha IS NOT sha) ORDER BY name`,
      marketplace,
    );
  }

  upsertPlugin(p: Omit<PluginRow, 'skills_indexed_at' | 'skills_indexed_sha' | 'error' | 'signals_json'>): void {
    this.run(
      `INSERT INTO plugins (id, marketplace, name, display_name, description, category, keywords, source_json, source_kind,
         repo, path, ref, sha, strict, entry_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, description = excluded.description,
         category = excluded.category, keywords = excluded.keywords, source_json = excluded.source_json,
         source_kind = excluded.source_kind, repo = excluded.repo, path = excluded.path, ref = excluded.ref,
         sha = excluded.sha, strict = excluded.strict, entry_json = excluded.entry_json`,
      p.id,
      p.marketplace,
      p.name,
      p.display_name,
      p.description,
      p.category,
      p.keywords,
      p.source_json,
      p.source_kind,
      p.repo,
      p.path,
      p.ref,
      p.sha,
      p.strict,
      p.entry_json,
    );
    const rowid = this.get<{ rowid: number }>('SELECT rowid FROM plugins WHERE id = ?', p.id)!.rowid;
    this.run('DELETE FROM plugins_fts WHERE rowid = ?', rowid);
    this.run(
      'INSERT INTO plugins_fts (rowid, plugin_id, name, description, category) VALUES (?, ?, ?, ?, ?)',
      rowid,
      p.id,
      [p.name, p.display_name, p.keywords].filter(Boolean).join(' '),
      p.description ?? '',
      p.category ?? '',
    );
  }

  markPluginIndexed(id: string, sha: string | null, signals: unknown, error: string | null): void {
    this.run(
      'UPDATE plugins SET skills_indexed_at = ?, skills_indexed_sha = ?, signals_json = ?, error = ? WHERE id = ?',
      now(),
      sha,
      signals == null ? null : JSON.stringify(signals),
      error,
      id,
    );
  }

  deletePlugin(id: string): void {
    for (const s of this.listSkillsByPlugin(id)) this.deleteSkill(s.id);
    const row = this.get<{ rowid: number }>('SELECT rowid FROM plugins WHERE id = ?', id);
    if (row) this.run('DELETE FROM plugins_fts WHERE rowid = ?', row.rowid);
    this.run('DELETE FROM plugins WHERE id = ?', id);
  }

  // ---- skills
  getSkill(id: string): SkillRow | undefined {
    return this.get<SkillRow>('SELECT * FROM skills WHERE id = ?', id);
  }

  listSkillsByPlugin(pluginId: string): SkillRow[] {
    return this.all<SkillRow>('SELECT * FROM skills WHERE plugin_id = ? ORDER BY name', pluginId);
  }

  findSkillsByRepo(repo: string): SkillRow[] {
    return this.all<SkillRow>('SELECT * FROM skills WHERE repo = ? COLLATE NOCASE', repo);
  }

  countSkills(): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM skills')!.n;
  }

  upsertSkill(s: SkillRow, pluginText: string): void {
    this.run(
      `INSERT INTO skills (id, origin, plugin_id, repo, ref, dir_path, name, description, when_to_use, frontmatter_json,
         body_lines, skill_md_sha256, name_desc_sha256, installs, quality_json, risk_json, risk_level, last_commit_at,
         fetched_at, files_json, install_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET origin = excluded.origin, plugin_id = COALESCE(excluded.plugin_id, skills.plugin_id),
         repo = excluded.repo, ref = excluded.ref, dir_path = excluded.dir_path, name = excluded.name,
         description = excluded.description, when_to_use = excluded.when_to_use, frontmatter_json = excluded.frontmatter_json,
         body_lines = excluded.body_lines, skill_md_sha256 = excluded.skill_md_sha256,
         name_desc_sha256 = excluded.name_desc_sha256, installs = COALESCE(excluded.installs, skills.installs),
         quality_json = excluded.quality_json, risk_json = excluded.risk_json, risk_level = excluded.risk_level,
         last_commit_at = excluded.last_commit_at, fetched_at = excluded.fetched_at, files_json = excluded.files_json,
         install_json = COALESCE(excluded.install_json, skills.install_json)`,
      s.id,
      s.origin,
      s.plugin_id,
      s.repo,
      s.ref,
      s.dir_path,
      s.name,
      s.description,
      s.when_to_use,
      s.frontmatter_json,
      s.body_lines,
      s.skill_md_sha256,
      s.name_desc_sha256,
      s.installs,
      s.quality_json,
      s.risk_json,
      s.risk_level,
      s.last_commit_at,
      s.fetched_at,
      s.files_json,
      s.install_json,
    );
    const rowid = this.get<{ rowid: number }>('SELECT rowid FROM skills WHERE id = ?', s.id)!.rowid;
    this.run('DELETE FROM skills_fts WHERE rowid = ?', rowid);
    this.run(
      'INSERT INTO skills_fts (rowid, skill_id, name, description, when_to_use, plugin_text) VALUES (?, ?, ?, ?, ?, ?)',
      rowid,
      s.id,
      s.name.replace(/[-_]+/g, ' ') + ' ' + s.name,
      s.description ?? '',
      s.when_to_use ?? '',
      pluginText,
    );
  }

  setSkillInstalls(id: string, installs: number): void {
    this.run('UPDATE skills SET installs = MAX(COALESCE(installs, 0), ?) WHERE id = ?', installs, id);
  }

  deleteSkill(id: string): void {
    const row = this.get<{ rowid: number }>('SELECT rowid FROM skills WHERE id = ?', id);
    if (row) this.run('DELETE FROM skills_fts WHERE rowid = ?', row.rowid);
    this.run('DELETE FROM skills WHERE id = ?', id);
  }

  searchSkillsFts(match: string, limit: number, marketplaces?: string[]): FtsSkillHit[] {
    const rows = this.all<SkillRow & { _bm25: number; _mp: string | null }>(
      `SELECT s.*, bm25(skills_fts, 0, 5.0, 2.0, 1.0, 0.5) AS _bm25, p.marketplace AS _mp
       FROM skills_fts JOIN skills s ON s.rowid = skills_fts.rowid
       LEFT JOIN plugins p ON p.id = s.plugin_id
       WHERE skills_fts MATCH ? ORDER BY _bm25 LIMIT ?`,
      match,
      marketplaces ? limit * 4 : limit,
    );
    const filtered = marketplaces ? rows.filter((r) => r._mp == null || marketplaces.includes(r._mp)) : rows;
    return filtered.slice(0, limit).map(({ _bm25, _mp, ...skill }) => ({ skill: skill as SkillRow, bm25: _bm25 }));
  }

  searchPluginsFts(match: string, limit: number, marketplaces?: string[]): FtsPluginHit[] {
    const rows = this.all<PluginRow & { _bm25: number }>(
      `SELECT p.*, bm25(plugins_fts, 0, 4.0, 2.0, 0.5) AS _bm25
       FROM plugins_fts JOIN plugins p ON p.rowid = plugins_fts.rowid
       WHERE plugins_fts MATCH ? ORDER BY _bm25 LIMIT ?`,
      match,
      marketplaces ? limit * 4 : limit,
    );
    const filtered = marketplaces ? rows.filter((r) => marketplaces.includes(r.marketplace)) : rows;
    return filtered.slice(0, limit).map(({ _bm25, ...plugin }) => ({ plugin: plugin as PluginRow, bm25: _bm25 }));
  }

  /** FTS restricted to one plugin's skills; used to pick the matching skills of a lazily indexed plugin. */
  searchSkillsInPlugin(match: string, pluginId: string, limit: number): FtsSkillHit[] {
    const rows = this.all<SkillRow & { _bm25: number }>(
      `SELECT s.*, bm25(skills_fts, 0, 5.0, 2.0, 1.0, 0.5) AS _bm25
       FROM skills_fts JOIN skills s ON s.rowid = skills_fts.rowid
       WHERE skills_fts MATCH ? AND s.plugin_id = ? ORDER BY _bm25 LIMIT ?`,
      match,
      pluginId,
      limit,
    );
    return rows.map(({ _bm25, ...skill }) => ({ skill: skill as SkillRow, bm25: _bm25 }));
  }

  // ---- repos
  getRepo(fullName: string): RepoRow | undefined {
    return this.get<RepoRow>('SELECT * FROM repos WHERE full_name = ? COLLATE NOCASE', fullName);
  }

  upsertRepo(r: RepoRow): void {
    this.run(
      `INSERT INTO repos (full_name, stars, pushed_at, archived, fork, license, default_branch, etag, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(full_name) DO UPDATE SET stars = excluded.stars, pushed_at = excluded.pushed_at,
         archived = excluded.archived, fork = excluded.fork, license = excluded.license,
         default_branch = excluded.default_branch, etag = excluded.etag, fetched_at = excluded.fetched_at`,
      r.full_name,
      r.stars,
      r.pushed_at,
      r.archived,
      r.fork,
      r.license,
      r.default_branch,
      r.etag,
      r.fetched_at,
    );
  }

  touchRepo(fullName: string): void {
    this.run('UPDATE repos SET fetched_at = ? WHERE full_name = ?', now(), fullName);
  }

  // ---- search cache
  getCached(key: string, maxAgeMs: number): unknown | undefined {
    const row = this.get<{ created_at: string; payload_json: string }>(
      'SELECT created_at, payload_json FROM search_cache WHERE key = ?',
      key,
    );
    if (!row || Date.now() - Date.parse(row.created_at) > maxAgeMs) return undefined;
    return JSON.parse(row.payload_json);
  }

  putCached(key: string, payload: unknown): void {
    this.run(
      `INSERT INTO search_cache (key, created_at, payload_json) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET created_at = excluded.created_at, payload_json = excluded.payload_json`,
      key,
      now(),
      JSON.stringify(payload),
    );
  }

  clearSearchCache(): void {
    this.run('DELETE FROM search_cache');
  }

  // ---- logs
  logInstall(e: {
    skill_id: string | null;
    plugin_id: string | null;
    method: string;
    scope: string;
    project_path: string | null;
    argv: string[][];
    exit_code: number;
    output: string;
  }): void {
    this.run(
      `INSERT INTO install_log (skill_id, plugin_id, method, scope, project_path, argv_json, exit_code, output, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.skill_id,
      e.plugin_id,
      e.method,
      e.scope,
      e.project_path,
      JSON.stringify(e.argv),
      e.exit_code,
      e.output.slice(0, 20_000),
      now(),
    );
  }

  logEvent(kind: 'view' | 'install', skillId: string, query: string | null): void {
    this.run('INSERT INTO events (kind, skill_id, query, created_at) VALUES (?, ?, ?, ?)', kind, skillId, query, now());
  }
}

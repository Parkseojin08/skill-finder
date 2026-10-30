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
  /** When `installs` was last seen (set by the store; rows built by the indexer leave it out). */
  installs_at?: string | null;
  quality_json: string | null;
  risk_json: string | null;
  risk_level: string | null;
  /** RISK_RULES_VERSION the risk flags were computed with (null: before versions). */
  risk_rules?: number | null;
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

  /** Repos with at least `minStars` stars (stored count) that GitHub-indexed skills come from. */
  listReposWithGithubSkills(minStars: number): string[] {
    return this.all<{ full_name: string }>(
      `SELECT r.full_name FROM repos r WHERE r.stars >= ?
         AND EXISTS (SELECT 1 FROM skills s WHERE s.repo = r.full_name COLLATE NOCASE AND s.origin = 'generic')
       ORDER BY r.stars DESC`,
      minStars,
    ).map((r) => r.full_name);
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
         fetched_at, files_json, install_json, installs_at, risk_rules)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET origin = excluded.origin, plugin_id = COALESCE(excluded.plugin_id, skills.plugin_id),
         repo = excluded.repo, ref = excluded.ref, dir_path = excluded.dir_path, name = excluded.name,
         description = excluded.description, when_to_use = excluded.when_to_use, frontmatter_json = excluded.frontmatter_json,
         body_lines = excluded.body_lines, skill_md_sha256 = excluded.skill_md_sha256,
         name_desc_sha256 = excluded.name_desc_sha256, installs = COALESCE(excluded.installs, skills.installs),
         quality_json = excluded.quality_json, risk_json = excluded.risk_json, risk_level = excluded.risk_level,
         last_commit_at = excluded.last_commit_at, fetched_at = excluded.fetched_at, files_json = excluded.files_json,
         install_json = COALESCE(excluded.install_json, skills.install_json),
         installs_at = CASE WHEN excluded.installs IS NOT NULL THEN excluded.installs_at ELSE skills.installs_at END,
         risk_rules = excluded.risk_rules`,
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
      s.installs != null ? new Date().toISOString() : null,
      s.risk_rules ?? null,
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

  /** Rows from GitHub checked under risk rules older than `version`, after `afterId` in id order. */
  listSkillsForRiskRecheck(version: number, afterId: string, limit: number): SkillRow[] {
    return this.all<SkillRow>(
      `SELECT * FROM skills WHERE (risk_rules IS NULL OR risk_rules < ?) AND repo IS NOT NULL AND ref IS NOT NULL
         AND dir_path IS NOT NULL AND id > ? ORDER BY id LIMIT ?`,
      version,
      afterId,
      limit,
    );
  }

  /** Every skill's stored flags and level (the level follows from the flags; tasks.ts relevelRisk). */
  listSkillRiskLevels(): Array<{ id: string; risk_json: string | null; risk_level: string }> {
    return this.all('SELECT id, risk_json, risk_level FROM skills');
  }

  setSkillRiskLevel(id: string, riskLevel: string): void {
    this.run('UPDATE skills SET risk_level = ? WHERE id = ?', riskLevel, id);
  }

  /** Updates the risk of a row still built from the SKILL.md with hash `sha`; false when it changed meanwhile. */
  setSkillRisk(id: string, sha: string, riskJson: string, riskLevel: string, version: number): boolean {
    const r = this.run('UPDATE skills SET risk_json = ?, risk_level = ?, risk_rules = ? WHERE id = ? AND skill_md_sha256 = ?', riskJson, riskLevel, version, id, sha);
    return Number(r.changes) > 0;
  }

  /** The latest count wins, even when lower (U4): skills.sh counts can drop, and the highest ever seen stuck forever. */
  setSkillInstalls(id: string, installs: number, at = new Date().toISOString()): void {
    this.run('UPDATE skills SET installs = ?, installs_at = ? WHERE id = ?', installs, at, id);
  }

  /** Deletes these skill rows except those an install was logged for (the installed page still points at them). */
  deleteSkillsUnlessInstalled(ids: string[]): number {
    return this.transaction(() => {
      let n = 0;
      for (const id of ids) {
        if (this.get('SELECT 1 FROM install_log WHERE skill_id = ? LIMIT 1', id)) continue;
        this.deleteSkill(id);
        n++;
      }
      return n;
    });
  }

  deleteSkill(id: string): void {
    const row = this.get<{ rowid: number }>('SELECT rowid FROM skills WHERE id = ?', id);
    if (row) this.run('DELETE FROM skills_fts WHERE rowid = ?', row.rowid);
    this.run('DELETE FROM skills WHERE id = ?', id);
  }

  searchSkillsFts(match: string, limit: number, marketplaces?: string[]): FtsSkillHit[] {
    // rank on the FTS index alone, then read only the kept rows (s.* holds files_json, up to tens of KB);
    // rowid breaks bm25 ties so the order is stable
    const rows = this.all<SkillRow & { _bm25: number; _mp: string | null }>(
      `WITH hit AS (SELECT rowid AS rid, bm25(skills_fts, 0, 5.0, 2.0, 1.0, 0.5) AS b FROM skills_fts
         WHERE skills_fts MATCH ? ORDER BY b, rid LIMIT ?)
       SELECT s.*, hit.b AS _bm25, p.marketplace AS _mp
       FROM hit JOIN skills s ON s.rowid = hit.rid
       LEFT JOIN plugins p ON p.id = s.plugin_id ORDER BY hit.b, hit.rid`,
      match,
      marketplaces ? limit * 4 : limit,
    );
    const filtered = marketplaces ? rows.filter((r) => r._mp == null || marketplaces.includes(r._mp)) : rows;
    return filtered.slice(0, limit).map(({ _bm25, _mp, ...skill }) => ({ skill: skill as SkillRow, bm25: _bm25 }));
  }

  /** Skills of repos whose name (the part after the owner) equals `name`, e.g. "rea" → morluto/rea. */
  findSkillsByRepoName(name: string, limit = 30): SkillRow[] {
    // same expression as the skills_repo_tail index (migration 3); a LIKE '%/name' scanned every row (~48ms)
    return this.all<SkillRow>(
      `SELECT * FROM skills WHERE lower(substr(repo, instr(repo, '/') + 1)) = ?
       AND origin != 'wellknown' AND description IS NOT NULL LIMIT ?`,
      name.toLowerCase(),
      limit,
    );
  }

  /** How many indexed skills match an FTS expression (document frequency for README recommendations). */
  countSkillsFts(match: string): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM skills_fts WHERE skills_fts MATCH ?', match)!.n;
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
    return this.searchSkillsInPlugins(match, [pluginId], limit).get(pluginId) ?? [];
  }

  /**
   * The best `limit` matches in each of several plugins with one full-text pass (one pass per plugin cost
   * ~15–20ms each, 20 plugins per search). Ids go in as one JSON array; rowids never leave SQL (node:sqlite
   * binds JS numbers as REAL, which an FTS rowid comparison silently ignores).
   */
  searchSkillsInPlugins(match: string, pluginIds: string[], limit: number): Map<string, FtsSkillHit[]> {
    const out = new Map<string, FtsSkillHit[]>();
    if (pluginIds.length === 0) return out;
    const rows = this.all<SkillRow & { _bm25: number }>(
      `WITH hit AS (SELECT skills_fts.rowid AS rid, bm25(skills_fts, 0, 5.0, 2.0, 1.0, 0.5) AS b, s.plugin_id AS pid
         FROM skills_fts JOIN skills s ON s.rowid = skills_fts.rowid
         WHERE skills_fts MATCH ? AND s.plugin_id IN (SELECT value FROM json_each(?))),
       top AS (SELECT rid, b, pid, ROW_NUMBER() OVER (PARTITION BY pid ORDER BY b, rid) AS rn FROM hit)
       SELECT s.*, top.b AS _bm25 FROM top JOIN skills s ON s.rowid = top.rid WHERE top.rn <= ? ORDER BY top.pid, top.b, top.rid`,
      match,
      JSON.stringify(pluginIds),
      limit,
    );
    for (const { _bm25, ...skill } of rows) {
      const list = out.get(skill.plugin_id!) ?? [];
      list.push({ skill: skill as SkillRow, bm25: _bm25 });
      out.set(skill.plugin_id!, list);
    }
    return out;
  }

  // ---- repos
  getRepo(fullName: string): RepoRow | undefined {
    return this.get<RepoRow>('SELECT * FROM repos WHERE full_name = ? COLLATE NOCASE', fullName);
  }

  /** Repos that indexed skills point at whose metadata is missing or was fetched before `beforeIso`. */
  listReposToRefresh(beforeIso: string, limit: number): string[] {
    return this.all<{ repo: string }>(
      `SELECT DISTINCT s.repo AS repo FROM skills s
       LEFT JOIN repos r ON r.full_name = s.repo COLLATE NOCASE
       WHERE s.repo IS NOT NULL AND (r.full_name IS NULL OR r.fetched_at IS NULL OR r.fetched_at < ?)
       LIMIT ?`,
      beforeIso,
      limit,
    ).map((r) => r.repo);
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

  /** When `key` was stored, if within `maxAgeMs` (for verdicts that a later change can make stale). */
  getCachedAt(key: string, maxAgeMs: number): string | undefined {
    const row = this.get<{ created_at: string }>('SELECT created_at FROM search_cache WHERE key = ?', key);
    return row && Date.now() - Date.parse(row.created_at) <= maxAgeMs ? row.created_at : undefined;
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

  /**
   * Drops the cached search results (they depend on the index). External answers kept in the same table
   * (`skillssh:`, `ghcode:`, `ghrepo:`) do not, so they stay.
   */
  clearSearchCache(): void {
    this.run("DELETE FROM search_cache WHERE key LIKE 'search:%'");
    // the external answers outlive this, but not forever: nothing reads them after a week
    this.run("DELETE FROM search_cache WHERE key NOT LIKE 'search:%' AND created_at < ?", new Date(Date.now() - 7 * 86_400_000).toISOString());
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
    /** The skill as it was when installed (UI debate 3-3). */
    ref?: string | null;
    skill_md_sha256?: string | null;
    risk_level?: string | null;
  }): void {
    this.run(
      `INSERT INTO install_log (skill_id, plugin_id, method, scope, project_path, argv_json, exit_code, output, created_at, ref, skill_md_sha256, risk_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.skill_id,
      e.plugin_id,
      e.method,
      e.scope,
      e.project_path,
      JSON.stringify(e.argv),
      e.exit_code,
      e.output.slice(0, 20_000),
      now(),
      e.ref ?? null,
      e.skill_md_sha256 ?? null,
      e.risk_level ?? null,
    );
  }

  /** Skills the app installed into a skills folder (skills CLI), newest first, to match those folders to the index. */
  listInstalledSkillLog(): Array<{ skill_id: string; scope: string; project_path: string | null; risk_level: string | null; created_at: string }> {
    return this.all(
      `SELECT skill_id, scope, project_path, risk_level, created_at FROM install_log
        WHERE skill_id IS NOT NULL AND exit_code = 0 AND method = 'skills-cli' ORDER BY id DESC`,
    );
  }

  /** An indexed GitHub skill whose SKILL.md has this hash (newest commit first). */
  findSkillIdByMdSha(sha: string): string | null {
    return this.get<{ id: string }>("SELECT id FROM skills WHERE skill_md_sha256 = ? AND id LIKE 'gh:%' ORDER BY last_commit_at DESC LIMIT 1", sha)?.id ?? null;
  }

  logEvent(kind: EventKind, skillId: string | null, query: string | null, meta?: Record<string, unknown>): void {
    this.run(
      'INSERT INTO events (kind, skill_id, query, created_at, meta_json) VALUES (?, ?, ?, ?, ?)',
      kind,
      skillId,
      query,
      now(),
      meta ? JSON.stringify(meta) : null,
    );
  }

  /** Search log entries (searches and the results opened from them) on this PC. */
  countSearchLog(): number {
    return this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE kind IN ${SEARCH_LOG_KINDS}`)!.n;
  }

  /** Deletes the search log; `olderThan` (ISO time) keeps what came after it. Returns how many were deleted. */
  clearSearchLog(olderThan?: string): number {
    const where = `kind IN ${SEARCH_LOG_KINDS}`;
    const r = olderThan ? this.run(`DELETE FROM events WHERE ${where} AND created_at < ?`, olderThan) : this.run(`DELETE FROM events WHERE ${where}`);
    return Number(r.changes);
  }
}

export type EventKind = 'view' | 'install' | 'search';
/** The kinds that make up the search log (U5-2): what was searched and which result was opened. */
const SEARCH_LOG_KINDS = "('search', 'view')";

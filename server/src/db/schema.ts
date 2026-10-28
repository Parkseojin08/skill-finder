// Each entry upgrades PRAGMA user_version by one. Never edit a released migration; append a new one.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE marketplaces (name TEXT PRIMARY KEY, repo TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    index_mode TEXT NOT NULL CHECK (index_mode IN ('eager','lazy')), etag TEXT, synced_at TEXT, plugin_count INTEGER,
    commit_sha TEXT, error TEXT);
  CREATE TABLE plugins (id TEXT PRIMARY KEY /* name@marketplace */, marketplace TEXT NOT NULL, name TEXT NOT NULL,
    display_name TEXT, description TEXT, category TEXT, keywords TEXT, source_json TEXT NOT NULL, source_kind TEXT NOT NULL,
    repo TEXT, path TEXT, ref TEXT, sha TEXT, strict INTEGER, signals_json TEXT, skills_indexed_at TEXT, error TEXT,
    skills_indexed_sha TEXT, entry_json TEXT);
  CREATE INDEX plugins_marketplace ON plugins(marketplace);
  CREATE TABLE repos (full_name TEXT PRIMARY KEY, stars INTEGER, pushed_at TEXT, archived INTEGER, fork INTEGER,
    license TEXT, default_branch TEXT, etag TEXT, fetched_at TEXT);
  CREATE TABLE skills (id TEXT PRIMARY KEY /* gh:{owner}/{repo}:{dirPath} */, origin TEXT NOT NULL /* plugin|generic|wellknown */,
    plugin_id TEXT REFERENCES plugins(id), repo TEXT, ref TEXT, dir_path TEXT, name TEXT NOT NULL, description TEXT,
    when_to_use TEXT, frontmatter_json TEXT, body_lines INTEGER, skill_md_sha256 TEXT, name_desc_sha256 TEXT,
    installs INTEGER, quality_json TEXT, risk_json TEXT, risk_level TEXT, last_commit_at TEXT, fetched_at TEXT,
    files_json TEXT, install_json TEXT);
  CREATE INDEX skills_plugin ON skills(plugin_id);
  CREATE INDEX skills_repo_name ON skills(repo, name);
  CREATE VIRTUAL TABLE skills_fts USING fts5(skill_id UNINDEXED, name, description, when_to_use, plugin_text, tokenize='porter unicode61');
  CREATE VIRTUAL TABLE plugins_fts USING fts5(plugin_id UNINDEXED, name, description, category, tokenize='porter unicode61');
  CREATE TABLE search_cache (key TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
  CREATE TABLE install_log (id INTEGER PRIMARY KEY, skill_id TEXT, plugin_id TEXT, method TEXT, scope TEXT,
    project_path TEXT, argv_json TEXT, exit_code INTEGER, output TEXT, created_at TEXT NOT NULL);
  CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT /* view|install */, skill_id TEXT, query TEXT, created_at TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  `,
  // Repo lookups ignore case (GitHub names do); without these they scan the whole table (~35ms each).
  `
  CREATE INDEX skills_repo_nocase ON skills(repo COLLATE NOCASE);
  CREATE INDEX repos_full_name_nocase ON repos(full_name COLLATE NOCASE);
  `,
  // One-word queries look up skills by repo name ("rea" → morluto/rea); a LIKE '%/rea' scan took ~48ms.
  `
  CREATE INDEX skills_repo_tail ON skills(lower(substr(repo, instr(repo, '/') + 1)));
  `,
  // Downloads keep the latest count and when it was seen; counts older than 30 days are not ranked on (U4).
  // Counts stored before this have no time of their own: the row's fetch time is the best guess.
  `
  ALTER TABLE skills ADD COLUMN installs_at TEXT;
  UPDATE skills SET installs_at = fetched_at WHERE installs IS NOT NULL;
  `,
  // Local search log (U5-2): details per event, and the 90-day pruning by kind and time.
  `
  ALTER TABLE events ADD COLUMN meta_json TEXT;
  CREATE INDEX events_kind_created ON events(kind, created_at);
  `,
];

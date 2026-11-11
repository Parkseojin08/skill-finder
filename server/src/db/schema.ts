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
  // The risk-rules version a row was checked under (risk.ts RISK_RULES_VERSION); NULL = before versions (1).
  `
  ALTER TABLE skills ADD COLUMN risk_rules INTEGER;
  `,
  // What was installed (UI debate 3-3): the commit, SKILL.md hash and risk level at install time; installed skills
  // are matched to the index by their SKILL.md hash.
  `
  ALTER TABLE install_log ADD COLUMN ref TEXT;
  ALTER TABLE install_log ADD COLUMN skill_md_sha256 TEXT;
  ALTER TABLE install_log ADD COLUMN risk_level TEXT;
  CREATE INDEX skills_md_sha ON skills(skill_md_sha256);
  `,
  // Accounts on this PC and their favorite skills (user decision 2026-11-02). The password is a scrypt hash; the
  // signed-in state is a signed cookie (auth.ts), so there is no session table. The skill's name is kept so a
  // favorite whose skill left the index can still be listed and removed.
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, skill_id)
  );
  `,
  // Favorites without accounts (user decision 2026-11-02): accounts kept only on this PC protected nothing, so the
  // favorites of every account made so far become this PC's favorites (the earliest star of each skill), and the
  // users table and the session key go.
  `
  CREATE TABLE favorites_local (
    skill_id TEXT PRIMARY KEY,
    skill_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO favorites_local (skill_id, skill_name, created_at)
    SELECT skill_id, MIN(skill_name), MIN(created_at) FROM favorites GROUP BY skill_id;
  DROP TABLE favorites;
  DROP TABLE users;
  ALTER TABLE favorites_local RENAME TO favorites;
  DELETE FROM settings WHERE key = 'sessionKey';
  `,
  // Favorite GitHub repositories (user request 2026-11-03) are `repo:owner/name` rows; the description and topics the
  // search showed are kept with them, since the index has neither.
  `ALTER TABLE favorites ADD COLUMN meta_json TEXT;`,
  // Where a renamed or transferred repo now lives (feature review P9): GitHub answers for the old name with the new
  // one's data, and its name is kept here; NULL when it is where it was asked for.
  `ALTER TABLE repos ADD COLUMN moved_to TEXT;`,
  // Feature review stage 2 (2026-11-05), written together so the parallel pieces do not race on this list:
  // - task_runs: every background task's runs (scheduler B2, status view F22); kept 30 days.
  // - task_state: when each task last succeeded and is next due, and how often it failed in a row (B2).
  // - repos.head_sha: the default branch's commit, from the metadata refresh (B3); a repo whose skills were indexed
  //   at another commit is due for a re-index.
  // - notices: changes to installed and favorite skills (F7): risk_up, new_commit, archived, gone, moved.
  // - install_log: what was seen when installing (F7, P7): the risk flags, the file check's summary, the warnings the
  //   user ticked, and whether the install was pinned to the checked commit.
  // - skills.first_seen_at: when the app first indexed the skill ("new this week", F17); older rows get fetched_at.
  `
  CREATE TABLE task_runs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, trigger TEXT NOT NULL /* startup|schedule|manual */,
    started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL /* running|ok|failed|skipped */,
    counts_json TEXT, error TEXT);
  CREATE INDEX task_runs_kind_started ON task_runs(kind, started_at);
  CREATE TABLE task_state (kind TEXT PRIMARY KEY, last_success_at TEXT, next_due_at TEXT, fail_count INTEGER NOT NULL DEFAULT 0);
  ALTER TABLE repos ADD COLUMN head_sha TEXT;
  CREATE TABLE notices (id INTEGER PRIMARY KEY, skill_id TEXT NOT NULL, kind TEXT NOT NULL,
    from_value TEXT, to_value TEXT, detail_json TEXT, created_at TEXT NOT NULL, seen_at TEXT);
  CREATE INDEX notices_seen ON notices(seen_at, created_at);
  CREATE UNIQUE INDEX notices_once ON notices(skill_id, kind, IFNULL(to_value, ''));
  ALTER TABLE install_log ADD COLUMN flags_json TEXT;
  ALTER TABLE install_log ADD COLUMN scan_summary_json TEXT;
  ALTER TABLE install_log ADD COLUMN acks_json TEXT;
  ALTER TABLE install_log ADD COLUMN pinned INTEGER;
  ALTER TABLE skills ADD COLUMN first_seen_at TEXT;
  UPDATE skills SET first_seen_at = fetched_at WHERE first_seen_at IS NULL;
  CREATE INDEX skills_first_seen ON skills(first_seen_at);
  `,
  // Feature review stage 3 (2026-11-09), one migration for the parallel pieces again:
  // - skill_usage / usage_scan_files: skill uses counted from Claude Code's transcripts (F11, off by default): only
  //   day, project, skill, plugin and a count; no conversation text. Each transcript is read on from where it stopped.
  // - quarantine: copies kept before a delete or overwrite, for undo (F14; 30 days, 20 entries, 20MB a folder).
  // - owner_prefs: hidden repos and trusted owners (F20, U7). key is a lower-case "owner/repo" or "owner".
  // - skills.minhash / cluster_id: near-copies grouped (B8); minhash is 64 x 32-bit values, little-endian.
  // - skills.skill_md_blob / plugins.tree_fingerprint: git blob of SKILL.md and a hash of a plugin's path+blob list,
  //   so an unchanged plugin is not downloaded again when its marketplace moves (B9).
  // - repos.created_at / owner_type / parent / gone_at: the source card (F5); fork was already there.
  // - repo_stars_daily: one star count per repo a day, kept for "rising repos" (F17 stage 2) once two weeks exist.
  `
  CREATE TABLE skill_usage (day TEXT NOT NULL, project_path TEXT NOT NULL DEFAULT '', skill TEXT NOT NULL,
    plugin TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL, PRIMARY KEY (day, project_path, skill, plugin));
  CREATE INDEX skill_usage_skill ON skill_usage(skill, day);
  CREATE TABLE usage_scan_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
    offset INTEGER NOT NULL, scanned_at TEXT NOT NULL);
  CREATE TABLE quarantine (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, reason TEXT NOT NULL /* delete|overwrite */,
    name TEXT NOT NULL, skill_id TEXT, scope TEXT, project_path TEXT, agent TEXT, original_path TEXT NOT NULL,
    stored_path TEXT NOT NULL, bytes INTEGER NOT NULL, files INTEGER NOT NULL, restored_at TEXT);
  CREATE INDEX quarantine_created ON quarantine(created_at);
  CREATE TABLE owner_prefs (key TEXT PRIMARY KEY, kind TEXT NOT NULL /* repo|owner */, pref TEXT NOT NULL /* hide|trust */,
    created_at TEXT NOT NULL);
  ALTER TABLE skills ADD COLUMN minhash BLOB;
  ALTER TABLE skills ADD COLUMN cluster_id TEXT;
  CREATE INDEX skills_cluster ON skills(cluster_id);
  ALTER TABLE skills ADD COLUMN skill_md_blob TEXT;
  ALTER TABLE plugins ADD COLUMN tree_fingerprint TEXT;
  ALTER TABLE repos ADD COLUMN created_at TEXT;
  ALTER TABLE repos ADD COLUMN owner_type TEXT;
  ALTER TABLE repos ADD COLUMN parent TEXT;
  ALTER TABLE repos ADD COLUMN gone_at TEXT;
  CREATE TABLE repo_stars_daily (full_name TEXT NOT NULL, day TEXT NOT NULL, stars INTEGER NOT NULL,
    PRIMARY KEY (full_name, day));
  `,
];

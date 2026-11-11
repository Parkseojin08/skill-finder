// A prebuilt index shipped with a release (first-run speed, 2026-11-03): the default marketplaces' plugins, their
// skills and the star counts of the repos they come from, taken from the index the release was built with. Nothing
// a user searched for, set, starred or installed is in it. A new install puts it into its empty database at
// startup, so the first searches need not wait ~20 minutes for 2,600 plugins to be read from GitHub (without a
// token); the normal sync then reads only what changed since.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ROOT_DIR } from '../config.ts';
import { RISK_RULES_VERSION } from '../analyze/risk.ts';
import { pluginFtsText } from '../indexer.ts';
import { DEFAULT_MARKETPLACES } from '../settings.ts';
import type { PluginRow, RepoRow, SkillRow, Store } from './store.ts';

const FORMAT = 1;
/** Rows still checked with older risk rules that a seed may leave out (unreadable sources); more refuses the seed. */
const OLD_RULES_SHARE = 0.01;
/** Next to server/ and web/ in a release (the package scripts write it); a checkout has none. */
export const SEED_PATH = process.env.SKILL_FINDER_SEED_PATH ? resolve(process.env.SKILL_FINDER_SEED_PATH) : join(ROOT_DIR, 'seed-index.json.gz');

type SeedMarketplace = { name: string; repo: string; commit_sha: string; etag: string | null; plugin_count: number | null };
/** A skill row in the seed: its MinHash signature (B8, a BLOB) as base64 text, since JSON has no bytes. */
export type SeedSkill = Omit<SkillRow, 'minhash'> & { minhash?: string | null };
export type Seed = { format: number; createdAt: string; marketplaces: SeedMarketplace[]; plugins: PluginRow[]; skills: SeedSkill[]; repos: RepoRow[] };

/** BLOB → base64 for the JSON file (an empty blob, "worked out, none", stays empty); null stays null. */
const toBase64 = (b: unknown): string | null => (b instanceof Uint8Array ? Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64') : null);
/** base64 back to bytes; anything else (an older seed without it, a stray value) is null. */
const fromBase64 = (s: unknown): Uint8Array | null => (typeof s === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(s) ? new Uint8Array(Buffer.from(s, 'base64')) : null);
export type SeedCounts = { plugins: number; skills: number; repos: number };

/** Plugin errors kept in the seed: the lasting verdicts the app shows. Others are retried anyway and may name local paths. */
const lastingError = (e: string | null) => (e && /^(설치 불가:|GitHub 외 출처)/.test(e) ? e : null);

/** The marketplaces a new install has on: one turned on later on the building PC would be searched though off. */
export function exportSeed(db: DatabaseSync, now = new Date()): Seed {
  const all = <T>(sql: string, ...args: string[]) => db.prepare(sql).all(...args).map((r) => ({ ...r })) as T[];
  const marketplaces = DEFAULT_MARKETPLACES.filter((d) => d.enabled).flatMap((d) =>
    all<SeedMarketplace>('SELECT name, repo, commit_sha, etag, plugin_count FROM marketplaces WHERE name = ? AND repo = ? AND commit_sha IS NOT NULL', d.name, d.repo),
  );
  const names = JSON.stringify(marketplaces.map((m) => m.name));
  const ofSeed = 'SELECT id FROM plugins WHERE marketplace IN (SELECT value FROM json_each(?))';
  const plugins = all<PluginRow>(`SELECT * FROM plugins WHERE id IN (${ofSeed}) ORDER BY id`, names).map((p) => ({ ...p, error: lastingError(p.error) }));
  const skills = all<SkillRow>(`SELECT * FROM skills WHERE origin = 'plugin' AND plugin_id IN (${ofSeed}) ORDER BY id`, names).map(
    (s): SeedSkill => ({ ...s, minhash: toBase64(s.minhash) }),
  );
  const repos = all<RepoRow>(
    `SELECT * FROM repos WHERE lower(full_name) IN (
       SELECT lower(repo) FROM plugins WHERE id IN (${ofSeed}) AND repo IS NOT NULL
       UNION SELECT lower(repo) FROM skills WHERE origin = 'plugin' AND plugin_id IN (${ofSeed}) AND repo IS NOT NULL)
     ORDER BY full_name`,
    names,
    names,
  );
  return { format: FORMAT, createdAt: now.toISOString(), marketplaces, plugins, skills, repos };
}

/**
 * Writes the seed of the database at `dbPath` as gzip JSON: read-only and in one read transaction, so a running app
 * may hold it and a sync it is doing meanwhile does not split plugins from their skills. Refuses an index that would
 * undo the point: empty, or checked with older risk rules (every install would download all SKILL.md files again).
 */
export function writeSeedFile(dbPath: string, outPath: string): SeedCounts & { bytes: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const seed = exportSeed(db);
    db.exec('COMMIT');
    if (seed.plugins.length === 0 || seed.skills.length === 0) throw new Error('색인에 기본 마켓플레이스의 스킬이 없습니다. 앱으로 한 번 동기화한 뒤 만드세요');
    // A few rows the re-check can never read (repo or commit gone: 404) stay at the old rules for good; they are left
    // out. More than 1% means the re-check has not run since the rules changed (2026-11-09).
    const isOld = (s: SeedSkill) => s.risk_rules != null && s.risk_rules < RISK_RULES_VERSION;
    const old = seed.skills.filter(isOld).length;
    if (old > seed.skills.length * OLD_RULES_SHARE) throw new Error(`스킬 ${old}개가 옛 위험 규칙으로 검사돼 있습니다. 앱을 실행해 다시 검사가 끝난 뒤 만드세요`);
    if (old > 0) {
      // their plugins must not look unchanged to the first sync (B9): with the folder's fingerprint kept, a plugin
      // whose skills were left out here would be passed over as "same folder" and never get them (review 2026-11-10)
      const cut = new Set(seed.skills.filter(isOld).map((s) => s.plugin_id));
      seed.plugins = seed.plugins.map((p) => (cut.has(p.id) ? { ...p, tree_fingerprint: null } : p));
      seed.skills = seed.skills.filter((s) => !isOld(s));
      console.warn(`[seed] 다시 검사할 수 없는 스킬 ${old}개(원본이 사라짐)는 넣지 않습니다`);
    }
    const gz = gzipSync(JSON.stringify(seed), { level: 9 });
    writeFileSync(outPath, gz);
    return { plugins: seed.plugins.length, skills: seed.skills.length, repos: seed.repos.length, bytes: gz.length };
  } finally {
    db.close();
  }
}

/**
 * Puts the seed at `path` into a database with no plugins and no skills yet (a new install); does nothing otherwise
 * or without the file. Marketplaces whose repo differs from the seed's are left to the sync. Star counts are dated
 * when the seed was made, so searches stop trusting them a week after the release as they would any other count.
 */
export function importSeed(store: Store, path: string): SeedCounts | null {
  if (!existsSync(path) || store.countPlugins() > 0 || store.countSkills() > 0) return null;
  const seed = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as Seed;
  if (seed.format !== FORMAT) throw new Error(`알 수 없는 색인 형식 ${seed.format}`);
  const local = new Map(store.listMarketplaces().map((m) => [m.name, m.repo]));
  const marketplaces = seed.marketplaces.filter((m) => local.get(m.name) === m.repo);
  const names = new Set(marketplaces.map((m) => m.name));
  const plugins = new Map(seed.plugins.filter((p) => names.has(p.marketplace)).map((p) => [p.id, p]));
  const skills = seed.skills.filter((s) => s.plugin_id && plugins.has(s.plugin_id));
  // never later than the counts themselves (the building PC refreshes them every 6 hours)
  const madeAt = seed.createdAt;
  // the stage-3 columns the store's upserts leave alone (B8 signature and group, B9 blob and fingerprint, F5 source)
  const skillExtras = store.db.prepare('UPDATE skills SET minhash = ?, cluster_id = ?, skill_md_blob = ? WHERE id = ?');
  const pluginExtras = store.db.prepare('UPDATE plugins SET tree_fingerprint = ? WHERE id = ?');
  const repoExtras = store.db.prepare('UPDATE repos SET created_at = ?, owner_type = ?, parent = ?, gone_at = ? WHERE full_name = ?');
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  store.transaction(() => {
    for (const m of marketplaces) store.updateMarketplaceSync(m.name, { etag: m.etag, plugin_count: m.plugin_count ?? undefined, commit_sha: m.commit_sha });
    for (const p of plugins.values()) {
      store.upsertPlugin(p);
      if (p.skills_indexed_at) store.markPluginIndexed(p.id, p.skills_indexed_sha, p.signals_json ? JSON.parse(p.signals_json) : null, p.error);
      // only a plugin read in full carries one (B9): the first sync then skips the unchanged ones
      pluginExtras.run(p.skills_indexed_sha && !p.error ? str(p.tree_fingerprint) : null, p.id);
    }
    for (const { minhash, ...s } of skills) {
      store.upsertSkill(s, pluginFtsText(plugins.get(s.plugin_id!)!));
      skillExtras.run(fromBase64(minhash), str(s.cluster_id), str(s.skill_md_blob), s.id);
    }
    for (const r of seed.repos) {
      store.upsertRepo({ ...r, fetched_at: r.fetched_at && r.fetched_at < madeAt ? r.fetched_at : madeAt });
      repoExtras.run(str(r.created_at), str(r.owner_type), str(r.parent), str(r.gone_at), r.full_name);
    }
  });
  return { plugins: plugins.size, skills: skills.length, repos: seed.repos.length };
}

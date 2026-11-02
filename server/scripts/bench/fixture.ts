// Builds a small fixed index for the search bench (project review 2026-11-02 F3): only the skills the judged query
// sets can reach (each query's top full-text hits, every skill with a reached name, every judged skill) and what
// they hang on (their plugins, marketplaces and repo rows), without the search cache, log or install history.
// Runs on it are repeatable anywhere and fast; they are compared with each other, not with runs on the full index.
//
//   node --disable-warning=ExperimentalWarning scripts/bench/fixture.ts --db <copy of skill-finder.db> [--out <file>]
//        [--per-query 150]
//
// --out defaults to <bench folder>/fixtures/fixture-<date>.db; the bench folder is SKILL_FINDER_BENCH_DIR or
// %LOCALAPPDATA%\SkillFinderBench (recordings and snapshots live there too: %TEMP% gets cleaned).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

export const benchDir = () => process.env.SKILL_FINDER_BENCH_DIR || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'SkillFinderBench');

const src = resolve(opt('--db') ?? die('--db <skill-finder.db 사본>이 필요합니다'));
if (!existsSync(src)) die(`없는 파일입니다: ${src}`);
const perQuery = Number(opt('--per-query') ?? 150);
const out = resolve(opt('--out') ?? join(benchDir(), 'fixtures', `fixture-${new Date().toISOString().slice(0, 10)}.db`));
if (resolve(src) === out) die('--out이 --db와 같습니다');

// every query and every judged "repo|name" key in the query sets and their label files
const queries = new Set<string>();
const judged = new Set<string>();
const collect = (value: unknown) => {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach(collect);
  for (const [k, v] of Object.entries(value)) {
    if (k === 'q' && typeof v === 'string') queries.add(v);
    else if (k.includes('|') && typeof v === 'number') judged.add(k.toLowerCase());
    else if (k === 'key' && typeof v === 'string') judged.add(v.toLowerCase());
    else collect(v);
  }
};
for (const f of readdirSync(join(HERE, 'data'))) if (f.endsWith('.json')) collect(JSON.parse(readFileSync(join(HERE, 'data', f), 'utf8')));

mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
rmSync(tmp, { force: true });
const source = new DatabaseSync(src, { readOnly: true });
source.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
source.close();

const db = new DatabaseSync(tmp);
db.exec('CREATE TEMP TABLE keep (id TEXT PRIMARY KEY); CREATE TEMP TABLE core (id TEXT PRIMARY KEY)');
const add = db.prepare('INSERT OR IGNORE INTO keep (id) VALUES (?)');
const addCore = db.prepare('INSERT OR IGNORE INTO core (id) VALUES (?)');
const hits = db.prepare('SELECT skill_id AS id FROM skills_fts WHERE skills_fts MATCH ? ORDER BY bm25(skills_fts) LIMIT ?');
const STOP = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'how', 'use', 'using', 'my', 'your', 'that', 'this']);
let reached = 0;
for (const q of queries) {
  // the query's words OR-ed (the porter tokenizer matches plurals): wider than the app's own query, which needs
  // most words, so what it can reach stays in
  const words = [...new Set(q.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length >= 2 && !STOP.has(w));
  if (!words.length) continue;
  const rows = hits.all(words.map((w) => `"${w}"`).join(' OR '), perQuery) as Array<{ id: string }>;
  rows.forEach((row, i) => {
    add.run(row.id);
    if (i < 50) addCore.run(row.id);
  });
  reached += rows.length;
}
// judged skills, by repo and name (keys are "owner/repo|name")
const byKey = db.prepare("SELECT id FROM skills WHERE lower(repo) = ? AND lower(name) = ?");
let judgedFound = 0;
for (const key of judged) {
  const [repo, name] = key.split('|');
  for (const row of byKey.all(repo, name) as Array<{ id: string }>) {
    add.run(row.id);
    addCore.run(row.id);
    judgedFound++;
  }
}
// other copies of a top or judged name: same-name folding and duplicate grouping on screen need them
db.exec('INSERT OR IGNORE INTO keep (id) SELECT s.id FROM skills s WHERE lower(s.name) IN (SELECT lower(k.name) FROM skills k JOIN core ON core.id = k.id)');

db.exec(`
  DELETE FROM skills WHERE id NOT IN (SELECT id FROM keep);
  DELETE FROM skills_fts WHERE skill_id NOT IN (SELECT id FROM keep);
  DELETE FROM plugins WHERE id NOT IN (SELECT plugin_id FROM skills WHERE plugin_id IS NOT NULL);
  DELETE FROM plugins_fts WHERE plugin_id NOT IN (SELECT id FROM plugins);
  DELETE FROM repos WHERE lower(full_name) NOT IN (SELECT lower(repo) FROM skills WHERE repo IS NOT NULL);
  DELETE FROM search_cache;
  DELETE FROM events;
  DELETE FROM install_log;
`);
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const summary = { queries: queries.size, judged: judged.size, judgedFound, reached, skills: count('skills'), plugins: count('plugins'), repos: count('repos') };
db.exec('VACUUM');
db.close();
rmSync(out, { force: true });
renameSync(tmp, out);
console.log(JSON.stringify({ out, mb: +(statSync(out).size / 1048576).toFixed(1), ...summary }));

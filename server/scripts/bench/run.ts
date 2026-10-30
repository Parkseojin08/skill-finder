// Runs searches through the real pipeline on a database snapshot and writes what each one showed and when
// (perf debate 1-1; replaces the ad-hoc tools of the two debates). See README.md next to this file.
//
//   node --disable-warning=ExperimentalWarning scripts/bench/run.ts <offline|record|replay> --db <skill-finder.db>
//        --queries <file.json | "q1;q2"> --out <run.json> [--rec <recording.json.gz>] [--token yes|no] [--gap ms]
//        [--now ISO] [--keep-db] [--rollback] [--runtime]
//
// record   real network (GitHub token from the app's .env). --token is required and the run stops when the token
//          state is not the one expected (an earlier measurement silently ran without it). Writes <out>.rec.json.gz.
// replay   answers from --rec after their recorded delays, at the recording's clock. Prints requests not recorded.
// offline  no network at all; clock from --now (default: the database file's time).
// --keep-db   use --db in place (to measure a second process on the same data, e.g. after a restart);
//             otherwise a fresh copy is made next to --out and deleted afterwards.
// --rollback  undo each query's writes (offline default), so queries do not affect each other.
// --runtime   also record heap and allocation per query (run with --expose-gc for heap after collection).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { installNet, pinClock, type Recording } from './env.ts';

const argv = process.argv.slice(2);
const mode = argv[0] as 'offline' | 'record' | 'replay';
const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const flag = (k: string) => argv.includes(k);
const die = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};
if (!['offline', 'record', 'replay'].includes(mode)) die('첫 인자는 offline | record | replay');
const dbArg = opt('--db') ?? die('--db <skill-finder.db>가 필요합니다');
const out = resolve(opt('--out') ?? die('--out <run.json>이 필요합니다'));
const qArg = opt('--queries') ?? die('--queries <file.json | "q1;q2">가 필요합니다');
const queries: string[] = existsSync(qArg)
  ? ((j: unknown) => (Array.isArray(j) ? j : (j as { queries: Array<{ q: string }> }).queries.map((x) => x.q)))(JSON.parse(readFileSync(qArg, 'utf8')))
  : qArg.split(';').map((s) => s.trim()).filter(Boolean);
const gapMs = Number(opt('--gap') ?? (mode === 'record' ? 7000 : 0));
const rollback = flag('--rollback') || (mode === 'offline' && !flag('--no-rollback'));
mkdirSync(dirname(out), { recursive: true });

// ── clock and network, before the app is loaded ───────────────────────────────────────────────────────────
const rec: Recording | null = mode === 'replay' ? JSON.parse(gunzipSync(readFileSync(opt('--rec') ?? die('--rec <recording.json.gz>가 필요합니다'))).toString('utf8')) : null;
if (mode === 'replay') pinClock(rec!.epoch0);
if (mode === 'offline') pinClock(opt('--now') ? Date.parse(opt('--now')!) : statSync(dbArg).mtimeMs);
const T0 = performance.now();
const clock = () => +(performance.now() - T0).toFixed(1);
const net = installNet(mode, rec, clock);

// ── database ──────────────────────────────────────────────────────────────────────────────────────────────
let dbPath = resolve(dbArg);
const scratch = join(dirname(out), `.bench-db-${process.pid}`);
if (!flag('--keep-db')) {
  mkdirSync(scratch, { recursive: true });
  dbPath = join(scratch, 'skill-finder.db');
  const src = new DatabaseSync(resolve(dbArg), { readOnly: true });
  src.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
  src.close();
}

// ── the app ───────────────────────────────────────────────────────────────────────────────────────────────
const { config } = await import('../../src/config.ts');
const { createContext } = await import('../../src/bootstrap.ts');
const { liveSearchDeps } = await import('../../src/routes/search.ts');
const { runSearch } = await import('../../src/search/pipeline.ts');
const { TokenBucket } = await import('../../src/util/limiter.ts');

const token = mode === 'record' ? config.githubToken : mode === 'replay' && rec!.token ? 'replay-token' : null;
console.log(`mode ${mode} · GitHub token ${token ? 'yes' : 'no'} · clock ${new Date().toISOString()} · ${queries.length} queries`);
if (mode === 'record') {
  const want = opt('--token') ?? die('record에는 --token yes|no가 필요합니다 (토큰 상태를 확인하고 시작합니다)');
  if ((want === 'yes') !== !!token) die(`토큰 상태가 기대(${want})와 다릅니다. .env 위치(SKILL_FINDER_ENV_PATH)를 확인하세요.`);
}
const ctx = createContext({ ...config, dataDir: dirname(dbPath), githubToken: token }, dbPath);
if (mode === 'replay') {
  // the recording already went through GitHub's rate limits; a replay must not queue on the app's own buckets
  const g = ctx.github as unknown as Record<string, unknown>;
  for (const k of ['codeSearch', 'searchWithToken', 'searchNoToken']) g[k] = new TokenBucket(1e6);
}
const deps = liveSearchDeps(ctx);
const epoch0 = Date.now();

// event-loop delay
let lastTick = performance.now();
let maxLag = 0;
setInterval(() => {
  const t = performance.now();
  maxLag = Math.max(maxLag, t - lastTick - 10);
  lastTick = t;
}, 10).unref();

type Item = { id: string; name: string; installs: number | null; stars: number | null; tier: number; R: number; riskLevel: string };
const item = (i: Record<string, unknown>): Item => ({
  id: i.id as string,
  name: i.name as string,
  installs: (i.installs as number | undefined) ?? null,
  stars: (i.stars as number | undefined) ?? null,
  tier: (i.tier as number | undefined) ?? 0,
  R: ((i.breakdown as { R?: number } | undefined)?.R as number) ?? 0,
  riskLevel: i.riskLevel as string,
});
const gc = (globalThis as { gc?: () => void }).gc;
const rows: unknown[] = [];
for (const q of queries) {
  net.setQuery(q);
  ctx.store.db.exec("DELETE FROM search_cache WHERE key LIKE 'search:%'");
  const events: Array<Record<string, unknown>> = [];
  const quiet = console.log;
  console.log = () => {};
  const t = clock();
  maxLag = 0;
  gc?.();
  const mem0 = process.memoryUsage();
  if (rollback) ctx.store.db.exec('BEGIN');
  try {
    await runSearch(deps, q, {}, (e) => {
      const at = +(clock() - t).toFixed(1);
      if (e.type === 'results' || e.type === 'candidates') events.push({ at, type: e.type, items: (e.items as unknown as Array<Record<string, unknown>>).map(item) });
      else if (e.type === 'source' || e.type === 'stage' || e.type === 'done' || e.type === 'warning') events.push({ at, ...e });
    });
  } catch (err) {
    events.push({ at: clock() - t, type: 'error', message: String((err as Error).message ?? err) });
  } finally {
    console.log = quiet;
    if (rollback) ctx.store.db.exec('ROLLBACK');
  }
  const mem1 = process.memoryUsage();
  const results = events.filter((e) => e.type === 'results').at(-1);
  const row = {
    q,
    ms: +(clock() - t).toFixed(1),
    firstAt: events.find((e) => e.type === 'candidates')?.at ?? null,
    finalAt: results?.at ?? null,
    maxLag: +maxLag.toFixed(1),
    requests: net.recs.filter((r) => r.q === q).length,
    bytes: net.recs.filter((r) => r.q === q).reduce((a, r) => a + (r.bytes ?? 0), 0),
    gitRuns: net.procs.filter((p) => p.q === q).length,
    ...(flag('--runtime') ? { heapDelta: mem1.heapUsed - mem0.heapUsed, rss: mem1.rss } : {}),
    events,
  };
  rows.push(row);
  console.log(`${q.padEnd(36)} first ${String(row.firstAt).padStart(7)}ms  final ${String(row.finalAt).padStart(7)}ms  req ${row.requests}  git ${row.gitRuns}  lag ${row.maxLag}`);
  if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
}

const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);
const firsts = rows.map((r) => (r as { firstAt: number | null }).firstAt).filter((x): x is number => x != null);
const finals = rows.map((r) => (r as { finalAt: number | null }).finalAt).filter((x): x is number => x != null);
console.log(`first p50 ${q(firsts, 0.5)} p90 ${q(firsts, 0.9)} · final p50 ${q(finals, 0.5)} p90 ${q(finals, 0.9)} (ms)`);
if (net.misses.length) console.log(`not in the recording: ${net.misses.length}\n  ${net.misses.slice(0, 10).join('\n  ')}`);

if (mode === 'record') await new Promise((r) => setTimeout(r, 3000)); // late bodies of lookups still running
writeFileSync(out, JSON.stringify({ mode, token: !!token, epoch0, queries, misses: net.misses, rows }, null, 1));
if (mode === 'record') {
  const recording: Recording = { version: 1, epoch0, token: !!token, recs: net.recs, procs: net.procs };
  writeFileSync(out.replace(/\.json$/, '') + '.rec.json.gz', gzipSync(JSON.stringify(recording)));
}
ctx.store.db.close();
if (!flag('--keep-db')) rmSync(scratch, { recursive: true, force: true });
console.log(`written ${out}`);
process.exit(0);

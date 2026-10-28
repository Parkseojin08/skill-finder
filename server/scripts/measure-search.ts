// Search quality and speed on a fixed set of queries, run against a copy of the real database (the app's own
// data is only read). Network calls are real (skills.sh, GitHub with the .env token), so numbers vary a little.
//
//   node --disable-warning=ExperimentalWarning scripts/measure-search.ts out.json
//   node --disable-warning=ExperimentalWarning scripts/measure-search.ts --compare before.json after.json
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createContext } from '../src/bootstrap.ts';
import { config } from '../src/config.ts';
import { liveSearchDeps } from '../src/routes/search.ts';
import { runSearch, type SearchEvent } from '../src/search/pipeline.ts';

const QUERIES = [
  'extract tables from pdf', 'pull request review', 'react performance', 'postgres migration', 'commit message',
  'figma design to code', 'make slides from my markdown notes', 'test my web app in a real browser',
  'write release notes from git history', 'find security holes in my code', 'pdf에서 표 추출', 'extrcat tabel from pdf',
  'pdf', 'docker', 'code review', 'security', 'pr review skill', 'rea',
  'write unit tests python', 'deploy to kubernetes', '엑셀 정리',
];

/** Results that must stay findable: query → [id fragment, skill name]. */
const EXPECT: Array<[string, string, string]> = [
  ['pdf', 'anthropics/skills', 'pdf'],
  ['extract tables from pdf', 'anthropics/skills', 'pdf'],
  ['docker', '', 'multi-stage-dockerfile'],
  ['rea', 'morluto/rea', 'reverse-engineer-anything'],
];

type Row = {
  q: string;
  ms: number;
  /** Until the first cards (a `candidates` event). Older runs lack it; until stage 2 that was `timings.collect`. */
  firstMs?: number;
  n: number;
  hiddenLowStars: number;
  timings: Record<string, number> | null;
  lookups: Record<string, number> | null;
  avgR10: number;
  lowR10: number;
  top: Array<{ name: string; id: string; installs: number | null; stars: number | null; R: number }>;
};

if (process.argv[2] === '--compare') compare(process.argv[3], process.argv[4]);
else await measure(process.argv[2] ?? 'measure.json');

async function measure(outPath: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sf-measure-'));
  const src = new DatabaseSync(join(config.dataDir, 'skill-finder.db'), { readOnly: true });
  src.exec(`VACUUM INTO '${join(dir, 'skill-finder.db').replace(/'/g, "''")}'`);
  src.close();
  const ctx = createContext({ ...config, dataDir: dir });
  ctx.store.db.exec("DELETE FROM search_cache WHERE key LIKE 'search:%' OR key LIKE 'skillssh:%'");
  const deps = liveSearchDeps(ctx);
  const rows: Row[] = [];
  for (const q of QUERIES) {
    let log = '';
    const origLog = console.log;
    console.log = (...a: unknown[]) => void (log += a.join(' '));
    const events: SearchEvent[] = [];
    const t0 = Date.now();
    let firstMs: number | undefined;
    try {
      await runSearch(deps, q, {}, (e) => {
        if (e.type === 'candidates' && firstMs == null) firstMs = Date.now() - t0;
        events.push(e);
      });
    } finally {
      console.log = origLog;
    }
    const res = events.filter((e) => e.type === 'results').at(-1) as Extract<SearchEvent, { type: 'results' }> | undefined;
    const items = res?.items ?? [];
    const top10 = items.slice(0, 10);
    rows.push({
      q,
      ms: Date.now() - t0,
      firstMs,
      n: items.length,
      hiddenLowStars: res?.hiddenLowStars ?? 0,
      timings: JSON.parse(log.match(/\{"collect[^}]*\}/)?.[0] ?? 'null'),
      lookups: JSON.parse(log.match(/lookups=(\{[^}]*\})/)?.[1] ?? 'null'),
      avgR10: top10.length ? round(top10.reduce((s, i) => s + i.breakdown.R, 0) / top10.length) : 0,
      lowR10: top10.filter((i) => i.breakdown.R < 0.4).length,
      top: items.map((i) => ({ name: i.name, id: i.id, installs: i.installs ?? null, stars: i.stars ?? null, R: round(i.breakdown.R) })),
    });
    const r = rows.at(-1)!;
    origLog(`${q}: ${r.ms}ms n=${r.n} hiddenLowStars=${r.hiddenLowStars} avgR10=${r.avgR10} lowR10=${r.lowR10}`);
  }
  writeFileSync(outPath, JSON.stringify(rows, null, 1));
  console.log(`\nwritten ${outPath}`);
  printChecks(rows);
  // timed-out lookups keep indexing in the background; the copy is thrown away, so stop here
  process.exit(0);
}

function compare(aPath: string, bPath: string): void {
  const a = JSON.parse(readFileSync(aPath, 'utf8')) as Row[];
  const b = JSON.parse(readFileSync(bPath, 'utf8')) as Row[];
  const pad = (s: unknown, w: number) => String(s).padStart(w);
  console.log(`${'query'.padEnd(38)}${pad('first ms', 13)}${pad('ms', 13)}${pad('n', 9)}${pad('hidden', 11)}${pad('avgR10', 13)}${pad('lowR10', 9)}${pad('lookups', 11)}`);
  const first = (r: Row) => r.firstMs ?? r.timings?.collect ?? 0;
  const sum = { a: 0, b: 0, fa: 0, fb: 0 };
  for (const rb of b) {
    const ra = a.find((r) => r.q === rb.q);
    if (!ra) continue;
    sum.a += ra.ms;
    sum.b += rb.ms;
    sum.fa += first(ra);
    sum.fb += first(rb);
    const lk = (r: Row) => (r.lookups ? Object.values(r.lookups).reduce((s, v) => s + v, 0) : 0);
    console.log(
      `${rb.q.slice(0, 37).padEnd(38)}${pad(`${first(ra)}→${first(rb)}`, 13)}${pad(`${ra.ms}→${rb.ms}`, 13)}${pad(`${ra.n}→${rb.n}`, 9)}${pad(`${ra.hiddenLowStars}→${rb.hiddenLowStars}`, 11)}` +
        `${pad(`${ra.avgR10}→${rb.avgR10}`, 13)}${pad(`${ra.lowR10}→${rb.lowR10}`, 9)}${pad(`${lk(ra)}→${lk(rb)}`, 11)}`,
    );
  }
  console.log(`total ms ${sum.a} → ${sum.b} · first cards ${sum.fa} → ${sum.fb}`);
  console.log('\nbefore:');
  printChecks(a);
  console.log('after:');
  printChecks(b);
}

function printChecks(rows: Row[]): void {
  for (const [q, idPart, name] of EXPECT) {
    const r = rows.find((x) => x.q === q);
    const i = r?.top.findIndex((t) => t.name === name && t.id.includes(idPart)) ?? -1;
    console.log(`  ${q} → ${name}${idPart ? ` (${idPart})` : ''}: ${i >= 0 ? `#${i + 1}` : 'missing'}`);
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

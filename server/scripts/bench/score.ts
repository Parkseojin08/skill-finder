// Scores a run.ts output against judged queries, on what the page shows: the page's own order and folding
// (web/src/lib/resultOrder.ts, imported as is), then nDCG@10, strict P@5 and must-find, as the search debate did.
// Also the first-screen numbers: how many of the first five cards are still in the final first five, and when the
// first five stopped changing.
//
//   node --disable-warning=ExperimentalWarning scripts/bench/score.ts <run.json> --eval <set.json>
//        [--extra labels.json ...] [--json per.json]
//
// <set.json>: { queries: [{ q, type?, must?: [{ key: "owner/repo|name", within }], j?: { key: grade }, sameAs? }] }
// grades 0 (wrong) · 1 (acceptable) · 2 (what was asked for); unjudged counts as 0. --extra adds { q: { key: grade } }.
import { readFileSync, writeFileSync } from 'node:fs';
import { byPopular, foldResults, nameMatches, navigationalWord, SORTS } from '../../../web/src/lib/resultOrder.ts';

type Item = { id: string; name: string; installs: number | null; stars: number | null; tier: number; R: number; riskLevel: string };
type Row = { q: string; events: Array<{ at: number; type: string; items?: Item[] }> };
type Query = { q: string; type?: string; must?: Array<{ key: string; within: number }>; j?: Record<string, number>; sameAs?: string };

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const runFile = argv[0];
const evalSet = JSON.parse(readFileSync(opt('--eval') ?? '', 'utf8')) as { queries: Query[] };
const extras = argv.flatMap((a, i) => (argv[i - 1] === '--extra' ? [JSON.parse(readFileSync(a, 'utf8')) as Record<string, Record<string, number>>] : []));
const run = JSON.parse(readFileSync(runFile, 'utf8')) as { rows: Row[] };

/** The page's default view: name matches first for a one-word name query, then the default sort, then folding. */
function visible(items: Item[], q: string): Item[] {
  const word = navigationalWord(q);
  const compare = SORTS[0].compare as unknown as (a: Item, b: Item) => number;
  const toPage = (i: Item) => ({ ...i, breakdown: { R: i.R } }) as never;
  const sorted = items.map(toPage).sort(
    word
      ? (a, b) => {
          const na = nameMatches(a, word);
          const nb = nameMatches(b, word);
          return Number(nb) - Number(na) || (na ? byPopular(a, b) : compare(a, b));
        }
      : (compare as never),
  );
  return foldResults(sorted, new Set(), new Set(), word).map((r) => r.item as unknown as Item);
}

const repoOf = (id: string) => id.match(/^gh:([^/]+\/[^:]+):/)?.[1] ?? id;
const keyOf = (t: Item) => `${repoOf(t.id)}|${t.name}`.toLowerCase();
const byQ = new Map(evalSet.queries.map((x) => [x.q, x]));
const judgments = (x: Query): Record<string, number> => {
  const base = x.sameAs && byQ.get(x.sameAs) ? judgments(byQ.get(x.sameAs)!) : {};
  const lower = (o: Record<string, number> = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  return Object.assign(base, ...extras.map((e) => lower(e[x.q])), lower(x.j));
};
const gain = (g: number | undefined) => (g == null ? 0 : 2 ** g - 1);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const per = [];
for (const x of evalSet.queries) {
  const row = run.rows.find((r) => r.q === x.q);
  if (!row) continue;
  const finalItems = row.events.filter((e) => e.type === 'results').at(-1)?.items ?? [];
  const list = visible(finalItems, x.q);
  const J = judgments(x);
  const g = list.map((t) => J[keyOf(t)]);
  const dcg = g.slice(0, 10).reduce((s, v, i) => s + gain(v) / Math.log2(i + 2), 0);
  const ideal = Object.values(J).sort((a, b) => b - a).slice(0, 10).reduce((s, v, i) => s + gain(v) / Math.log2(i + 2), 0);
  const must = (x.must ?? []).map((m) => {
    const i = list.findIndex((t) => keyOf(t) === m.key.toLowerCase());
    return { key: m.key, within: m.within, pos: i < 0 ? null : i + 1, ok: i >= 0 && i < m.within };
  });
  // first screen: the first early cards against the final five, and when the five shown stopped changing
  const top5 = (items: Item[]) => visible(items, x.q).slice(0, 5).map((t) => t.id);
  const final5 = top5(finalItems);
  const shown = row.events.filter((e) => e.type === 'candidates' || e.type === 'results');
  const first5 = shown.length ? top5(shown[0].items ?? []) : [];
  let stableAt: number | null = null;
  for (let i = shown.length - 1; i >= 0 && top5(shown[i].items ?? []).join() === final5.join(); i--) stableAt = shown[i].at;
  per.push({
    q: x.q,
    type: x.type ?? null,
    n: list.length,
    ndcg10: ideal ? r3(dcg / ideal) : null,
    p5: r3(g.slice(0, 5).filter((v) => v === 2).length / 5),
    unjudged10: list.slice(0, 10).filter((t) => J[keyOf(t)] == null).map(keyOf),
    must,
    keep5: first5.filter((id) => final5.includes(id)).length,
    stableAt,
  });
}

const mean = (xs: number[]) => (xs.length ? r3(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
const scored = per.filter((p) => p.type !== 'negative' && p.ndcg10 != null);
for (const p of per) {
  console.log(`${p.q.slice(0, 34).padEnd(35)}nDCG ${String(p.ndcg10 ?? '-').padEnd(6)} P@5 ${String(p.p5).padEnd(5)} keep5 ${p.keep5}  stable ${p.stableAt}ms  ${p.must.map((m) => `${m.key.split('|')[1]}:${m.pos ?? 'x'}${m.ok ? '' : '!'}`).join(' ')}`);
}
const allMust = scored.flatMap((p) => p.must);
console.log(`\nnDCG@10 ${mean(scored.map((p) => p.ndcg10!))} · P@5 ${mean(scored.map((p) => p.p5))} · must ${allMust.filter((m) => m.ok).length}/${allMust.length} · keep5 ${mean(per.map((p) => p.keep5))} · unjudged in top 10 ${per.reduce((s, p) => s + p.unjudged10.length, 0)}`);
if (opt('--json')) writeFileSync(opt('--json')!, JSON.stringify(per, null, 1));

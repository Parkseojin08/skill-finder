// Paired comparison of two score.ts --json outputs (A = before, B = after): nDCG@10 mean difference with a
// bootstrap 95% interval (5,000 resamples, fixed seed, as the search debate), wins and losses, must-find, and the
// first-screen numbers. The rules a change must pass are in docs/search-debate-final-report.md and
// docs/perf-debate-final-report.md (a new ranking rule: interval low end above 0 and no must-find lost).
//
//   node --disable-warning=ExperimentalWarning scripts/bench/compare.ts per-A.json per-B.json
import { readFileSync } from 'node:fs';

type Per = { q: string; type: string | null; ndcg10: number | null; must: Array<{ key: string; ok: boolean; pos: number | null }>; keep5: number; stableAt: number | null };
const [a, b] = process.argv.slice(2, 4).map((f) => JSON.parse(readFileSync(f, 'utf8')) as Per[]);
const qs = a.filter((x) => x.type !== 'negative' && x.ndcg10 != null && b.some((y) => y.q === x.q)).map((x) => x.q);
const get = (list: Per[], q: string) => list.find((x) => x.q === q)!;
const d = qs.map((q) => (get(b, q).ndcg10 ?? 0) - (get(a, q).ndcg10 ?? 0));
const n = d.length;
const mean = d.reduce((s, v) => s + v, 0) / n;
let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const boot: number[] = [];
for (let i = 0; i < 5000; i++) {
  let s = 0;
  for (let j = 0; j < n; j++) s += d[Math.floor(rnd() * n)];
  boot.push(s / n);
}
boot.sort((x, y) => x - y);
const avg = (list: Per[]) => (qs.reduce((s, q) => s + (get(list, q).ndcg10 ?? 0), 0) / n).toFixed(3);
const must = (list: Per[]) => `${list.flatMap((x) => x.must).filter((m) => m.ok).length}/${list.flatMap((x) => x.must).length}`;
const keep = (list: Per[]) => (list.reduce((s, x) => s + x.keep5, 0) / list.length).toFixed(2);
console.log(`nDCG@10 ${avg(a)} -> ${avg(b)}  diff ${mean.toFixed(3)}  95% CI [${boot[125].toFixed(3)}, ${boot[4875].toFixed(3)}]  wins ${d.filter((v) => v > 0).length} losses ${d.filter((v) => v < 0).length}`);
console.log(`must ${must(a)} -> ${must(b)} · keep5 ${keep(a)} -> ${keep(b)} (${qs.length} queries)`);
qs.forEach((q, i) => Math.abs(d[i]) > 1e-9 && console.log(`  ${q.padEnd(34)} ${d[i] > 0 ? '+' : ''}${d[i].toFixed(3)}`));
for (const x of a) {
  const y = b.find((z) => z.q === x.q);
  x.must.forEach((m, i) => y && (m.ok !== y.must[i]?.ok || m.pos !== y.must[i]?.pos) && console.log(`  must ${x.q} ${m.key} ${m.pos} -> ${y.must[i]?.pos}`));
}

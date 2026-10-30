// Summary of the local search log (UI debate 3-4), read-only. Point it at a copy of the database, not the one the
// running app has open:
//
//   node --disable-warning=ExperimentalWarning scripts/search-log-report.ts <copy of data/skill-finder.db>
//
// The numbers decide stage-4 items of docs/ui-debate-final-report.md, and only once the sample is big enough
// (MIN_SEARCHES searches over MIN_DAYS days): side-by-side comparison when 30%+ of searches open two or more
// results (drop it under 10%), and the empty-result help when 10%+ of searches find nothing (lower under 5%).
import { DatabaseSync } from 'node:sqlite';

const MIN_SEARCHES = 50;
const MIN_DAYS = 28;

const path = process.argv[2];
if (!path) {
  console.error('사용법: search-log-report.ts <DB 사본 경로>');
  process.exit(1);
}
const db = new DatabaseSync(path, { readOnly: true });
type Ev = { kind: string; skill_id: string | null; created_at: string; meta_json: string | null };
const events = db.prepare("SELECT kind, skill_id, created_at, meta_json FROM events WHERE kind IN ('search', 'view', 'install') ORDER BY created_at").all() as Ev[];
const meta = (e: Ev) => (e.meta_json ? (JSON.parse(e.meta_json) as Record<string, unknown>) : {});

const searches = events.filter((e) => e.kind === 'search').map((e) => ({ at: e.created_at, ...meta(e) }) as Record<string, unknown> & { at: string });
const views = events.filter((e) => e.kind === 'view').map((e) => ({ skill: e.skill_id, at: e.created_at, ...meta(e) }) as Record<string, unknown> & { at: string });
const installs = events.filter((e) => e.kind === 'install');

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '–');
const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const ms = (v: number | null) => (v == null ? '–' : `${(v / 1000).toFixed(1)}초`);

const days = searches.length ? (Date.parse(searches.at(-1)!.at) - Date.parse(searches[0].at)) / 86_400_000 : 0;
const enough = searches.length >= MIN_SEARCHES && days >= MIN_DAYS;
const empty = searches.filter((s) => s.n === 0).length;
const live = searches.filter((s) => !s.cached);
// different skills opened from one search (the same one opened twice is one)
const skillsBySid = new Map<string, Set<string | null>>();
for (const v of views) if (typeof v.sid === 'string') skillsBySid.set(v.sid, (skillsBySid.get(v.sid) ?? new Set()).add(v.skill as string | null));
const twoOrMore = [...skillsBySid.values()].filter((s) => s.size >= 2).length;
const positions = views.map((v) => v.pos).filter((p): p is number => typeof p === 'number');
const viewed = new Set(views.map((v) => v.skill));
const installedAfterView = installs.filter((i) => viewed.has(i.skill_id)).length;

console.log(`검색 ${searches.length}건 · 기간 ${days.toFixed(1)}일 · 열람 ${views.length}건 · 설치 ${installs.length}건`);
console.log(`결과 0건 검색: ${empty}건 (${pct(empty, searches.length)})`);
console.log(`첫 결과 시간 (캐시 제외 ${live.length}건): p50 ${ms(quantile(live.map((s) => Number(s.firstMs)).filter(Number.isFinite), 0.5))} · p90 ${ms(quantile(live.map((s) => Number(s.firstMs)).filter(Number.isFinite), 0.9))}`);
console.log(`최종 결과 시간 (캐시 제외): p50 ${ms(quantile(live.map((s) => Number(s.finalMs)).filter(Number.isFinite), 0.5))} · p90 ${ms(quantile(live.map((s) => Number(s.finalMs)).filter(Number.isFinite), 0.9))}`);
console.log(`연 결과의 순위: 중앙값 ${quantile(positions, 0.5) ?? '–'} · 1~5위 ${pct(positions.filter((p) => p <= 5).length, positions.length)}`);
console.log(`서로 다른 상세를 2개 이상 연 검색: ${twoOrMore}건 (${pct(twoOrMore, searches.length)})`);
console.log(`검색에서 열어 본 스킬을 설치한 수: ${installedAfterView}건`);
console.log('');
if (!enough) {
  console.log(`판정 보류: 검색 ${MIN_SEARCHES}건 이상, ${MIN_DAYS}일 이상 쌓인 뒤에 판정합니다.`);
} else {
  const cmp = twoOrMore / searches.length;
  const emp = empty / searches.length;
  console.log(`나란히 비교: ${cmp >= 0.3 ? '만든다' : cmp < 0.1 ? '접는다' : '보류 (10~30%)'}`);
  console.log(`빈 결과 안내: ${emp >= 0.1 ? '우선순위 올림' : emp < 0.05 ? '우선순위 내림' : '그대로 (5~10%)'}`);
}

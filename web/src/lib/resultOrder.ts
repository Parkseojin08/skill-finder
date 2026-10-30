// Result order and folding for the search page (moved out of SearchPage.tsx, UI debate 2-1; no behaviour change).
import { repoOf } from '../components/ResultCard.tsx';
import { RISK_RANK } from '../labels.ts';
import type { ResultItem } from '../types.ts';

export type SortKey = 'popular' | 'stars' | 'recent' | 'name';
// Default order (user decisions, same as the server): skills whose name has a query word and that match at
// least half the words first (tier), then downloads, then stars, then relevance.
export const byPopular = (a: ResultItem, b: ResultItem) =>
  (b.installs ?? -1) - (a.installs ?? -1) || (b.stars ?? -1) - (a.stars ?? -1) || b.breakdown.R - a.breakdown.R;
const byTierThenPopular = (a: ResultItem, b: ResultItem) => (b.tier ?? 0) - (a.tier ?? 0) || byPopular(a, b);
export const SORTS: Array<{ key: SortKey; label: string; compare: (a: ResultItem, b: ResultItem) => number }> = [
  { key: 'popular', label: '관련 → 다운로드 → 스타', compare: byTierThenPopular },
  { key: 'stars', label: '스타 많은 순', compare: (a, b) => (b.stars ?? -1) - (a.stars ?? -1) || byPopular(a, b) },
  {
    key: 'recent',
    label: '최근 업데이트 순',
    compare: (a, b) => (b.lastCommitAt ? Date.parse(b.lastCommitAt) : 0) - (a.lastCommitAt ? Date.parse(a.lastCommitAt) : 0) || byPopular(a, b),
  },
  { key: 'name', label: '이름순', compare: (a, b) => a.name.localeCompare(b.name) },
];

/** Mirrors server/src/search/pipeline.ts: a one-word query as a name, and whether a result carries that name. */
export function navigationalWord(query: string): string | null {
  const q = query.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,99}$/.test(q) ? q : null;
}
export function nameMatches(item: ResultItem, word: string): boolean {
  const name = item.name.toLowerCase();
  return name === word || name.startsWith(`${word}-`) || item.id.match(/^gh:[^/]+\/([^:]+):/)?.[1] === word;
}

/** Results shown per repository before the rest fold into "이 저장소에서 N개 더" (user decision D). */
const PER_REPO = 2;

/**
 * Keeps the sort order but shows only the first PER_REPO results of each repository; the rest fold behind a
 * button after the last one shown, and opening it lists them right there. The repo named like a one-word
 * query ("rea") never folds.
 */
function foldByRepo(sorted: ResultItem[], open: Set<string>, word: string | null): Array<{ item: ResultItem; more?: { repo: string; count: number } }> {
  const byRepo = new Map<string, ResultItem[]>();
  for (const it of sorted) {
    const r = repoOf(it);
    if (r) byRepo.set(r, [...(byRepo.get(r) ?? []), it]);
  }
  const out: Array<{ item: ResultItem; more?: { repo: string; count: number } }> = [];
  for (const it of sorted) {
    const r = repoOf(it);
    const all = r ? byRepo.get(r)! : [];
    if (!r || all.length <= PER_REPO || (word && r.split('/')[1]?.toLowerCase() === word)) {
      out.push({ item: it });
      continue;
    }
    const n = all.indexOf(it);
    if (n >= PER_REPO) continue; // folded, or already listed after the last one shown
    if (n < PER_REPO - 1) out.push({ item: it });
    else if (open.has(r)) out.push(...all.slice(PER_REPO - 1).map((x) => ({ item: x })));
    else out.push({ item: it, more: { repo: r, count: all.length - PER_REPO } });
  }
  return out;
}

/** Name key for same-name folding, as the README recommendation groups copies ("PDF_Tools" = "pdf-tools"). */
const nameKey = (item: ResultItem) => item.name.normalize('NFC').toLowerCase().replace(/[\s_]+/g, '-');
export type Row = { item: ResultItem; more?: { repo: string; count: number }; same?: { key: string; count: number; riskier: boolean } };

/**
 * Same-name skills (U2, user decision) fold under the first one in the current order: the others follow it
 * only when its "같은 이름 N개 더" is opened. Downloads are not summed (they are different copies), and the
 * button says when a folded copy is riskier than the one shown. Repository folding then runs on what is left.
 */
export function foldResults(sorted: ResultItem[], openRepos: Set<string>, openNames: Set<string>, word: string | null): Row[] {
  const copies = new Map<string, ResultItem[]>();
  const firsts: ResultItem[] = [];
  for (const it of sorted) {
    const k = nameKey(it);
    const g = copies.get(k);
    if (g) g.push(it);
    else {
      copies.set(k, []);
      firsts.push(it);
    }
  }
  const out: Row[] = [];
  for (const row of foldByRepo(firsts, openRepos, word)) {
    const k = nameKey(row.item);
    const rest = copies.get(k)!;
    if (rest.length === 0) out.push(row);
    // opened: the copies come right after the card, and its repository's "N개 더" button after the last copy
    else if (openNames.has(k)) out.push({ item: row.item }, ...rest.map((x, i) => ({ item: x, ...(i === rest.length - 1 && row.more ? { more: row.more } : {}) })));
    else out.push({ ...row, same: { key: k, count: rest.length, riskier: rest.some((x) => RISK_RANK[x.riskLevel] > RISK_RANK[row.item.riskLevel]) } });
  }
  return out;
}

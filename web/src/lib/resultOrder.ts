// Result order and folding for the search page (moved out of SearchPage.tsx, UI debate 2-1; no behaviour change).
import { RISK_RANK } from '../labels.ts';
import type { ResultItem } from '../types.ts';
import { t } from '../i18n.ts';

/** `owner/repo` of a GitHub-indexed result (ids are `gh:<owner>/<repo>:<dir>`). */
export const repoOf = (item: Pick<ResultItem, 'id'>) => item.id.match(/^gh:([^/]+\/[^:]+):/)?.[1] ?? null;

export type SortKey = 'popular' | 'stars' | 'recent' | 'name';
// Default order (user decisions, same as the server): skills whose name has a query word and that match at
// least half the words first (tier), then downloads, then stars, then relevance.
export const byPopular = (a: ResultItem, b: ResultItem) =>
  (b.installs ?? -1) - (a.installs ?? -1) || (b.stars ?? -1) - (a.stars ?? -1) || b.breakdown.R - a.breakdown.R;
const byTierThenPopular = (a: ResultItem, b: ResultItem) => (b.tier ?? 0) - (a.tier ?? 0) || byPopular(a, b);
export const SORTS: Array<{ key: SortKey; label: string; compare: (a: ResultItem, b: ResultItem) => number }> = [
  { key: 'popular', label: t('관련 → 다운로드 → 스타'), compare: byTierThenPopular },
  { key: 'stars', label: t('스타 많은 순'), compare: (a, b) => (b.stars ?? -1) - (a.stars ?? -1) || byPopular(a, b) },
  {
    key: 'recent',
    label: t('최근 업데이트 순'),
    compare: (a, b) => (b.lastCommitAt ? Date.parse(b.lastCommitAt) : 0) - (a.lastCommitAt ? Date.parse(a.lastCommitAt) : 0) || byPopular(a, b),
  },
  { key: 'name', label: t('이름순'), compare: (a, b) => a.name.localeCompare(b.name) },
];

/** Mirrors server/src/search/pipeline.ts: a one-word query as a name, and whether a result carries that name. */
export function navigationalWord(query: string): string | null {
  const q = query.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,99}$/.test(q) ? q : null;
}
/** The same-name repo's main skill: its most downloaded, with at least twice the next one's downloads. */
export function repoMainSkill(items: ResultItem[], word: string): string | null {
  const [first, second] = items
    .filter((i) => i.id.match(/^gh:[^/]+\/([^:]+):/)?.[1]?.toLowerCase() === word)
    .map((i) => ({ id: i.id, n: i.installs ?? 0 }))
    .sort((a, b) => b.n - a.n);
  return first && first.n > 0 && first.n >= 2 * (second?.n ?? 0) ? first.id : null;
}
export function nameMatches(item: ResultItem, word: string, main: string | null = null): boolean {
  const name = item.name.toLowerCase();
  return name === word || name.startsWith(`${word}-`) || item.id === main;
}

/** Results shown per repository before the rest fold into "이 저장소에서 N개 더" (user decision D). */
const PER_REPO = 2;

/**
 * Keeps the sort order but shows only the first PER_REPO results of each repository; the rest fold behind a
 * button after the last one shown, and opening it lists them right there. In the repo named like a one-word
 * query ("rea"), what the lookup puts first (nameMatches) never folds; its other skills fold as anywhere else.
 */
function foldByRepo(sorted: ResultItem[], open: Set<string>, word: string | null, main: string | null): Array<{ item: ResultItem; more?: { repo: string; count: number } }> {
  const pinned = (it: ResultItem, r: string) => word != null && r.split('/')[1]?.toLowerCase() === word && nameMatches(it, word, main);
  const byRepo = new Map<string, ResultItem[]>();
  for (const it of sorted) {
    const r = repoOf(it);
    if (r && !pinned(it, r)) byRepo.set(r, [...(byRepo.get(r) ?? []), it]);
  }
  const out: Array<{ item: ResultItem; more?: { repo: string; count: number } }> = [];
  for (const it of sorted) {
    const r = repoOf(it);
    const all = r ? (byRepo.get(r) ?? []) : [];
    if (!r || pinned(it, r) || all.length <= PER_REPO) {
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
/** The near-copy group the server put a result in (B8; `search/result.ts` sets it), or null. */
export const clusterOf = (item: ResultItem): string | null => {
  const c = (item as ResultItem & { clusterId?: string | null }).clusterId;
  return typeof c === 'string' && c ? c : null;
};
/**
 * `copyOf`: an opened copy shown under its first card; `last` gets the "접기" button. `same.renamed`: how many of the
 * folded ones have another name (near-copies found by content, B8); left out when there are none.
 */
export type Row = {
  item: ResultItem;
  more?: { repo: string; count: number };
  same?: { key: string; count: number; riskier: boolean; renamed?: number };
  copyOf?: { key: string; last: boolean };
};

/**
 * Groups of results to fold: the same name (U2), or the same near-copy group (B8), which also catches copies that
 * were renamed. Results sharing either are one group (union-find). A group's key is stable across orders: its
 * near-copy group (`c:` and the smallest one), else the name key as before.
 */
function copyGroups(sorted: ResultItem[]): Map<ResultItem, string> {
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstBy = new Map<string, number>();
  sorted.forEach((it, i) => {
    for (const k of [`n:${nameKey(it)}`, ...(clusterOf(it) ? [`c:${clusterOf(it)}`] : [])]) {
      const j = firstBy.get(k);
      if (j === undefined) firstBy.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const keyOf = new Map<number, string>();
  sorted.forEach((it, i) => {
    const c = clusterOf(it);
    const root = find(i);
    const prev = keyOf.get(root);
    const mine = c ? `c:${c}` : null;
    if (prev === undefined) keyOf.set(root, mine ?? nameKey(sorted[root]));
    else if (mine && (!prev.startsWith('c:') || mine < prev)) keyOf.set(root, mine);
  });
  return new Map(sorted.map((it, i) => [it, keyOf.get(find(i))!]));
}

/**
 * Same-name skills (U2, user decision) and near-copies (B8) fold under the first one in the current order: the
 * others follow it only when its "같은 이름 N개 더" is opened. Downloads are not summed (they are different copies,
 * U4), and the button says when a folded copy is riskier than the one shown, and how many were renamed. Repository
 * folding then runs on what is left.
 */
export function foldResults(sorted: ResultItem[], openRepos: Set<string>, openNames: Set<string>, word: string | null, main: string | null = null): Row[] {
  const groupOf = copyGroups(sorted);
  const copies = new Map<string, ResultItem[]>();
  const firsts: ResultItem[] = [];
  for (const it of sorted) {
    const k = groupOf.get(it)!;
    const g = copies.get(k);
    if (g) g.push(it);
    else {
      copies.set(k, []);
      firsts.push(it);
    }
  }
  const out: Row[] = [];
  for (const row of foldByRepo(firsts, openRepos, word, main)) {
    const k = groupOf.get(row.item)!;
    const rest = copies.get(k)!;
    if (rest.length === 0) out.push(row);
    // opened: the copies come right after the card, and its repository's "N개 더" button after the last copy
    else if (openNames.has(k))
      out.push({ item: row.item }, ...rest.map((x, i) => ({ item: x, copyOf: { key: k, last: i === rest.length - 1 }, ...(i === rest.length - 1 && row.more ? { more: row.more } : {}) })));
    else {
      const renamed = rest.filter((x) => nameKey(x) !== nameKey(row.item)).length;
      out.push({ ...row, same: { key: k, count: rest.length, riskier: rest.some((x) => RISK_RANK[x.riskLevel] > RISK_RANK[row.item.riskLevel]), ...(renamed ? { renamed } : {}) } });
    }
  }
  return out;
}

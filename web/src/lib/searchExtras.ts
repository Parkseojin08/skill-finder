// Fields the search and README recommendation answers carry beyond types.ts (feature review 2026-11-04: B1, B4,
// F18). Kept here so types.ts stays as it is; pages use them as intersections with its types.
import { t } from '../i18n.ts';
import type { Facets } from '../components/FacetPanel.tsx';
import type { ResultItem, SearchEvent } from '../types.ts';

export type SuspectReason = 'ratio' | 'copies' | 'impostor';

/** F18: the download count looks inflated. It is left out of `installs` (sorted as unknown) and given here. */
export type InstallsSuspect = { installs: number; reasons: SuspectReason[] };
export type SuspectFields = { installsSuspect?: InstallsSuspect };
/**
 * Stage 3 (each only when it says something): the repo's license (SPDX id, "other" for NOASSERTION; absent =
 * unknown), `manualOnly` for `disable-model-invocation: true`, and the near-copy group (B8).
 */
export type Stage3Fields = { license?: string; manualOnly?: true; clusterId?: string };
export type SearchItem = ResultItem & SuspectFields & Stage3Fields;

export type SearchResultsExtra = {
  /** Aliases that found shown results ("ppt → pptx도 함께 찾음"). */
  aliases?: Array<{ from: string; to: string[] }>;
  /** Few results and two swapped letters: the fixed query, offered as a button (never applied by itself). */
  spelling?: { query: string; words: Array<{ from: string; to: string }> };
  /** A search cached before the index last changed, shown while it runs again. */
  stale?: boolean;
  /** F20: results left out for a hidden repo (one per SKILL.md), and from how many hidden repos. */
  hiddenByPrefs?: number;
  hiddenRepos?: number;
  /** F19: the facets this search applied to every candidate before the cut, and the counts over all of them. */
  facets?: ServerFacets;
  facetCounts?: SearchFacetCounts;
};

// ── stage 3 (feature review 2026-11-04): F19 facets for the whole candidate list ──────────────────────────────────

export const RUN_FEATURES = ['noHooksMcp', 'manualOnly', 'noBashPreapproved'] as const;
export const UPDATED_WITHIN = ['30d', '90d', '1y'] as const;
const UPDATED_DAYS: Record<string, number> = { '30d': 30, '90d': 90, '1y': 365 };

/** What POST /api/search takes in `filters.facets` (server: search/facets.ts SearchFacets). */
export type ServerFacets = {
  trust?: string[];
  category?: string[];
  method?: string[];
  license?: string[];
  run?: string[];
  updated?: string;
  owner?: string[];
  trusted?: boolean;
};
export type SearchFacetCounts = {
  trust: Record<string, number>;
  category: Record<string, number>;
  method: Record<string, number>;
  license: Record<string, number>;
  run: Record<string, number>;
  updated: Record<string, number>;
  owner: Record<string, number>;
  trusted: number;
  total: number;
};

/** Mirrors server/src/search/facets.ts runFeatures: the conditions a result meets. */
export function itemRunFeatures(it: Pick<ResultItem, 'riskFlags'> & Stage3Fields): string[] {
  const flags = it.riskFlags ?? [];
  const out: string[] = [];
  if (!flags.some((f) => f === 'skillHooks' || f === 'pluginHooks' || f === 'pluginMcp')) out.push('noHooksMcp');
  if (it.manualOnly) out.push('manualOnly');
  if (!flags.some((f) => f === 'preapprovedBash' || f === 'unscopedBash')) out.push('noBashPreapproved');
  return out;
}

/** The update windows a result's last commit falls in ("30d" is also within "90d" and "1y"). */
export function itemUpdatedWithin(it: Pick<ResultItem, 'lastCommitAt'>, now = Date.now()): string[] {
  const at = it.lastCommitAt ? Date.parse(it.lastCommitAt) : NaN;
  if (Number.isNaN(at)) return [];
  return UPDATED_WITHIN.filter((w) => now - at <= UPDATED_DAYS[w] * 86_400_000);
}

/** The side filters as the server's facets; null when none is picked (then the search is the plain one). */
export function toServerFacets(f: Facets): ServerFacets | null {
  const out: ServerFacets = {};
  for (const g of ['trust', 'category', 'method', 'license', 'run', 'owner'] as const) {
    const v = f[g] ?? [];
    if (v.length) out[g] = [...new Set(v)].sort();
  }
  if (f.updated?.length) out.updated = f.updated[0];
  if (f.trusted?.length) out.trusted = true;
  return Object.keys(out).length ? out : null;
}

/** Whether two filter sets ask the server the same thing. */
export function sameFacets(a: Facets | null | undefined, b: Facets | null | undefined): boolean {
  return JSON.stringify(a ? toServerFacets(a) : null) === JSON.stringify(b ? toServerFacets(b) : null);
}
export type SearchResults = Extract<SearchEvent, { type: 'results' }> & SearchResultsExtra;

// ── stage 2 (feature review 2026-11-04): F16 suggestions and recent searches, F17 browsing, F21 stack ────────────

/** GET /api/suggest: a name in the local index that the typed text starts. */
export type Suggestion = { kind: 'skill' | 'plugin' | 'repo' | 'owner'; text: string; stars: number | null; installs: number | null; count: number; marketplace?: string };
/** GET /api/history?kind=search. */
export type RecentSearch = { query: string; at: string; results: number | null };

export type BrowseTrust = 'official' | 'partner' | 'community';
export type BrowseSection = 'anthropic' | 'new' | 'plugins';
/** What the browse list shows; it rides in the page address (`/?cat=testing`, `/?browse=new`, `/?repo=o/r`). */
export type BrowseView = { section?: BrowseSection; cat?: string; trust?: BrowseTrust; marketplace?: string; repo?: string; owner?: string };

export type BrowseOverview = {
  section: 'overview';
  minStars: number;
  categories: Array<{ key: string; count: number }>;
  trust: Array<{ key: BrowseTrust; count: number }>;
  marketplaces: Array<{ name: string; count: number }>;
  anthropic: number;
  newThisWeek: number;
  plugins: number;
  total: number;
};
export type BrowseList = {
  section: 'list' | BrowseSection;
  items: SearchItem[];
  total: number;
  page: number;
  pageSize: number;
  hiddenHighRisk: number;
  hiddenLowStars: number;
  hiddenUnknownStars: number;
  minStars: number;
  /** F20: cards left out because their repo is hidden. */
  hiddenByPrefs?: number;
};

const SECTIONS: BrowseSection[] = ['anthropic', 'new', 'plugins'];
const TRUSTS: BrowseTrust[] = ['official', 'partner', 'community'];
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** The browse view in a page address, or null when it shows none (a search, or the first screen). */
export function browseFromParams(p: URLSearchParams, categories: readonly string[]): BrowseView | null {
  const v: BrowseView = {};
  const section = p.get('browse');
  if (section && (SECTIONS as string[]).includes(section)) v.section = section as BrowseSection;
  const cat = p.get('cat');
  if (cat && categories.includes(cat)) v.cat = cat;
  const trust = p.get('trust');
  if (trust && (TRUSTS as string[]).includes(trust)) v.trust = trust as BrowseTrust;
  const mp = p.get('marketplace');
  if (mp && mp.length <= 128) v.marketplace = mp;
  const repo = p.get('repo');
  if (repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && repo.length <= 200) v.repo = repo;
  const owner = p.get('owner');
  if (owner && NAME.test(owner)) v.owner = owner;
  return Object.keys(v).length ? v : null;
}

/** The view as address parameters (the page's own keys: `browse` for a section). */
export function browseAddress(v: BrowseView): URLSearchParams {
  const p = new URLSearchParams();
  if (v.section) p.set('browse', v.section);
  for (const k of ['cat', 'trust', 'marketplace', 'repo', 'owner'] as const) if (v[k]) p.set(k, v[k]!);
  return p;
}

/**
 * GET /api/browse parameters for one page of the view. `liftStars`: without the star minimum; `showHidden`: with the
 * hidden repositories (F20).
 */
export function browseQuery(v: BrowseView, page: number, risk: string, liftStars: boolean, showHidden = false): Record<string, string | undefined> {
  return {
    section: v.section ?? 'list',
    cat: v.cat,
    trust: v.trust,
    marketplace: v.marketplace,
    repo: v.repo,
    owner: v.owner,
    page: String(page),
    risk,
    ...(liftStars ? { minStars: '0' } : {}),
    ...(showHidden ? { showHidden: '1' } : {}),
  };
}

/** F21: one technology the README recommendation found in the project's manifests; `off` when turned off. */
export type StackTag = { tag: string; evidence: string[]; off?: boolean };
/** What the page sends in `exclude` to turn a stack tag off (server: recommend/readme.ts STACK_EXCLUDE_PREFIX). */
export const stackExclude = (tag: string) => `stack:${tag.toLowerCase()}`;

/** Why a download count is not trusted, for the badge's tooltip. */
export function suspectReasonText(r: SuspectReason): string {
  switch (r) {
    case 'ratio':
      return t('별 수에 비해 다운로드가 지나치게 많습니다');
    case 'copies':
      return t('별 적은 저장소 여러 곳에 같은 스킬이 올라와 각각 다운로드가 많습니다');
    case 'impostor':
      return t('별 많은 유명 저장소와 이름이 같고 만든 곳이 다릅니다');
  }
}

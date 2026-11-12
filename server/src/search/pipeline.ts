import { createHash } from 'node:crypto';
import { isOffline, noteNetworkError, noteNetworkOk } from '../scheduler.ts';
import { RISK_ORDER, RISK_RULES_VERSION, type RiskLevel } from '../analyze/risk.ts';
import { SKILLS_CLI_VERSION } from '../config.ts';
import type { AppContext } from '../context.ts';
import type { PluginRow, SkillRow } from '../db/store.ts';
import { basename } from '../discovery/tree.ts';
import { normalizeSkillName, PluginUnavailableError, skillId } from '../indexer.ts';
import { installSummary } from '../install/summary.ts';
import { getSettings } from '../settings.ts';
import { classifySkillsShSource, type SkillsShHit } from '../sources/skillsSh.ts';
import { pool, Semaphore, sleep, withTimeout } from '../util/limiter.ts';
import { ownerFilter } from '../prefs/ownerPrefs.ts';
import { countFacets, facetValuesOf, matchFacetValues, mayMatchPending, normalizeFacets, type FacetCounts, type FacetValues, type SearchFacets } from './facets.ts';
import { indexGeneration } from './indexGeneration.ts';
import { installsSuspect, type InstallsSuspect } from './installsSuspect.ts';
import { koreanSuggestion } from './koreanTerms.ts';
import { queryAliases, type AliasUse } from './queryAliases.ts';
import { spellingSuggestion, type SpellingSuggestion } from './spelling.ts';
import {
  blendRelevance,
  bm25ToRelevance,
  freshInstalls,
  freshness,
  GENERIC_WORDS,
  lexicalMatch,
  queryTokens,
  popularity,
  relevanceTier,
  totalScore,
  TRUST_SCORE,
  trustTier,
  type Breakdown,
  type LexicalMatch,
  type TrustTier,
} from './rank.ts';
import {
  buildResultItem,
  githubSource,
  marketplaceSource,
  mergeSources,
  storeLookup,
  type Lookup,
  type RepoResult,
  type ResultItem,
  type SourceKind,
  type SourceRef,
} from './result.ts';

/**
 * `minStars` overrides the setting for one search (0 = no minimum). `facets`: "이 조건으로 전체에서 다시 찾기" (F19),
 * applied to every candidate before the cut. `showHidden`: this search shows the hidden repositories too (F20).
 */
export type SearchFilters = { sources?: SourceKind[]; maxRisk?: RiskLevel; marketplaces?: string[]; minStars?: number; facets?: SearchFacets; showHidden?: boolean };

/** local: the marketplace/GitHub index on this PC. repos: the repo-name search for one-word queries. */
export type SourceName = 'local' | 'skillssh' | 'github' | 'repos';
export type SourceState = 'running' | 'done' | 'failed' | 'timeout' | 'skipped';
/**
 * Part of the search cache key: bump it whenever what a cached search replays changes shape (results fields,
 * warning fields) or meaning, so older cached searches are not shown. test/pipeline.test.ts pins the shape.
 * 23 (stage 3): items may carry license, manualOnly and clusterId; results may carry hiddenByPrefs, hiddenRepos,
 * facets and facetCounts (each only when it has a value).
 */
export const RESULTS_VERSION = 23;
/** How many generations back a cached search is still shown first as "이전 결과" while it is searched again. */
const STALE_GENERATIONS = 8;
/** Below this many indexed skills (a first run still collecting, D#323b) an older cached search is not shown first. */
const STALE_MIN_SKILLS = 1000;
/** Final results fewer than this offer a spelling fix for swapped letters (B4, user decision 6). */
const SPELLING_FEW = 5;

const SOURCE_NAME_KO: Record<SourceName, string> = { local: '내 PC 색인', skillssh: 'skills.sh', github: 'GitHub', repos: '같은 이름 저장소' };

export type SearchEvent =
  | { type: 'stage'; stage: 'collect' | 'enrich' | 'score'; message: string }
  /** Progress of one source; `count` is how many hits it returned, `ms` how long it took. */
  | { type: 'source'; source: SourceName; state: SourceState; count?: number; ms?: number }
  /** An English query for a Korean one, offered as a button (dictionary-based, never applied by itself). */
  | { type: 'suggest'; query: string; dropped: string[] }
  | { type: 'candidates'; items: ResultItem[] }
  /** `urgent`: changes what the results mean (stays on screen); `note`: routine, folds into the "알림" toggle. */
  | { type: 'warning'; source: string; message: string; severity: 'urgent' | 'note' }
  | {
      type: 'results';
      items: ResultItem[];
      hiddenHighRisk: number;
      hiddenNoDescription: number;
      hiddenLowStars?: number;
      /**
       * Hidden because the repo's star count is not known yet (a first run, no token): told apart from "below the
       * minimum" so the page can say why (project review 2026-11-02).
       */
      hiddenUnknownStars?: number;
      minStars?: number;
      /** Results without a single query word in their name or description (user decision A). */
      hiddenNoMatch?: number;
      /** An English query for a Korean one, offered as a button (dictionary-based, never applied by itself). */
      suggestQuery?: string;
      /** Every query word is a stopword ("skill"): searched as typed, so the results are broad. */
      broadQuery?: boolean;
      /** Repositories named like a one-word query, shown above the skills. */
      repos?: RepoResult[];
      /** Aliases that found shown results ("ppt → pptx도 함께 찾음"; B4, user decision 5). */
      aliases?: AliasUse[];
      /** Few results and a word with two letters swapped: the fixed query, offered as a button (user decision 6). */
      spelling?: SpellingSuggestion;
      /**
       * Left out because their repo (or its owner) is hidden (F20): results, one per SKILL.md, and how many hidden
       * repos they came from ("숨긴 저장소 N개 · 보기"). Absent when nothing was hidden.
       */
      hiddenByPrefs?: number;
      hiddenRepos?: number;
      /** The facets this search applied before the cut (F19), and per value how many candidates each leaves. */
      facets?: SearchFacets;
      facetCounts?: FacetCounts;
      /**
       * A cached search from before the index last changed (B1), sent first while the search runs again; the
       * fresh results replace it. Never stored.
       */
      stale?: boolean;
    }
  /** `sid`: this search in the search log (added by the route when the log is on), for the opened results. */
  | { type: 'done'; cached: boolean; elapsedMs: number; sid?: string };

export type SearchDeps = {
  ctx: AppContext;
  skillsSh(query: string): Promise<SkillsShHit[]>;
  /** Overrides GITHUB_COLLECT_WAIT_MS (tests). */
  githubWaitMs?: number;
  /** Overrides SEARCH_DEADLINE_MS (tests). */
  deadlineMs?: number;
  /** Overrides STALE_MIN_SKILLS (tests). */
  staleMinSkills?: number;
};

type Pending =
  | { type: 'plugin'; plugin: PluginRow }
  | { type: 'skillssh'; hit: SkillsShHit }
  | { type: 'github'; repo: string; path: string };

/** What a source returned; null when it did not run (turned off, or no GitHub token). */
type SourceDone = { state: 'done' | 'failed' | 'timeout'; count: number } | null;

type Candidate = {
  key: string;
  skill: SkillRow | null;
  sources: SourceRef[];
  installs: number | null;
  bm25: number | null;
  /** Best position score (0..1) per source. */
  pos: Partial<Record<SourceKind, number>>;
  pending: Pending | null;
  /**
   * Found by name: a marketplace plugin named by the query, or the repo named like a one-word query. Such a
   * skill is kept without a query word in its text (user decision A); a full-text hit alone no longer is (B4,
   * user decision 4: porter stemming matched "localization" to "local").
   */
  viaName?: boolean;
  /** Its download count looks inflated (F18): `installs` is then null for sorting. */
  suspect?: InstallsSuspect;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ENRICH = 60;
const MAX_RESULTS = 50;
/** Lookups still running this long after the search started are left to finish in the background. */
const SEARCH_DEADLINE_MS = 18_000;
const ENRICH_CONCURRENCY = 24;
/** How long after collecting to wait for lookups before sending results without the stragglers. */
const INTERIM_WAIT_MS = 2000;
/** GitHub code-search hits looked up as soon as the search returns (the rest only if they rank in the top). */
const GITHUB_EARLY_LOOKUPS = 30;
/** How long (from the start) the enrich step waits for GitHub code search before going on without it. */
const GITHUB_COLLECT_WAIT_MS = 4000;
/** Results that missed some candidates are cached briefly; those candidates finish indexing in the background. */
const PARTIAL_CACHE_MS = 60 * 1000;
/**
 * Candidates whose stored star count (a day or two old) is below this share of the minimum are dropped before
 * the top-MAX_ENRICH cut and never looked up; closer to the minimum the fresh count in buildResults decides.
 */
const STAR_PREFILTER_SHARE = 0.8;
/** Characters of a description (and of when_to_use) that word matching reads: the SKILL.md spec's limit. */
const MATCH_TEXT_MAX = 1024;
/** Characters of a skill name that word matching reads (the spec allows 64; some real names run longer). */
const MATCH_NAME_MAX = 128;
/** Stored star counts older than this are treated as unknown (checked again before a lookup). */
const STORED_STARS_MAX_AGE_MS = 7 * DAY_MS;

/**
 * found: resolved to an installable skill. missing: the repo has no installable SKILL.md for it (examples,
 * templates, renamed or removed skills) — retrying will not change that. error: GitHub could not be read.
 * timeout: still running at the deadline; it keeps going in the background and is indexed for next time.
 * lowstars: the repo has fewer stars than the minimum, so its SKILL.md was not read.
 */
type Outcome = 'found' | 'missing' | 'error' | 'timeout' | 'lowstars';

const STOPWORDS = new Set(
  'a an the and or for to of in on with from by using use uses skill skills claude code tool tools that this is are be my your how what into as at it its via any can will should'.split(' '),
);

function ftsTokens(texts: string[]): string[] {
  const collect = (keepGeneric: boolean) => {
    const tokens = new Set<string>();
    const ok = (w: string) => w.length >= 2 && (!STOPWORDS.has(w) || (keepGeneric && GENERIC_WORDS.has(w)));
    for (const t of texts) {
      const lower = t.toLowerCase();
      for (const m of lower.matchAll(/[\p{L}\p{N}]+/gu)) if (ok(m[0])) tokens.add(m[0]);
      // ASCII runs inside mixed Korean words ("pdf에서" → "pdf")
      for (const m of lower.matchAll(/[a-z0-9]+/g)) if (ok(m[0])) tokens.add(m[0]);
    }
    return tokens;
  };
  // a query of stopwords only ("skill", "claude code") is searched as typed; dropping them left no local search
  let tokens = collect(false);
  if (tokens.size === 0) tokens = collect(true);
  return [...tokens].slice(0, 24).map((t) => `"${t.replace(/"/g, '')}"`);
}

/** Every word of the query is a stopword and one names something ("skill", "tool use"): searched, but broad. */
export function isBroadQuery(query: string): boolean {
  const words = query.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length >= 2) ?? [];
  return words.every((w) => STOPWORDS.has(w)) && words.some((w) => GENERIC_WORDS.has(w)) && !/\p{Script=Hangul}/u.test(query);
}

/** Each FTS token with its aliases (queryAliases.ts: "ppt" → "pptx", "powerpoint"), all quoted. */
function aliasGroups(texts: string[]): string[][] {
  const aliases = queryAliases(texts.join(' '));
  return ftsTokens(texts).map((t) => [t, ...(aliases.get(t.slice(1, -1)) ?? []).map((a) => `"${a}"`)]);
}

/** OR-query of distinct tokens and their aliases for FTS5 (each token quoted, so no FTS syntax leaks through). */
export function ftsQuery(texts: string[]): string | null {
  const list = [...new Set(aliasGroups(texts).flat())];
  return list.length ? list.join(' OR ') : null;
}

/**
 * The same tokens, all required (a word or one of its aliases): searched first so skills with every word lead
 * (null for one word). A word with a Korean ending ("pdf에서") is left out, as its Latin part ("pdf") is already a
 * token.
 */
export function ftsAllQuery(texts: string[]): string | null {
  const groups = aliasGroups(texts).filter((g) => !(/[a-z0-9]/.test(g[0]) && /\p{Script=Hangul}/u.test(g[0])));
  return groups.length >= 2 ? groups.map((g) => (g.length > 1 ? `(${g.join(' OR ')})` : g[0])).join(' AND ') : null;
}

export function normalizeQuery(q: string): string {
  return q.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Words of the query for GitHub code search, stopwords dropped. */
export function queryKeywords(q: string): string[] {
  const words = q.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];
  const kept = words.filter((w) => w.length >= 2 && !STOPWORDS.has(w.toLowerCase()));
  return (kept.length ? kept : words).slice(0, 3);
}

const posScore = (i: number, n: number) => (n <= 1 ? 1 : 1 - i / n);

function prelim(c: Candidate): number {
  const vals = Object.values(c.pos).filter((v): v is number => v != null);
  if (vals.length === 0) return 0;
  return Math.max(...vals) + 0.1 * (vals.length - 1);
}

/**
 * R: the engines' signal (bm25 against the best/worst hit, position in the skills.sh / GitHub lists)
 * blended with how many query words appear in the skill name and description.
 */
function relevance(c: Candidate, bestBm25: number, worstBm25: number, m: LexicalMatch): number {
  const parts: number[] = [];
  if (c.bm25 != null) parts.push(bm25ToRelevance(c.bm25, bestBm25, worstBm25));
  if (c.pos.marketplace != null && c.bm25 == null) parts.push(0.8 * c.pos.marketplace);
  if (c.pos.skillssh != null) parts.push(0.8 * c.pos.skillssh); // fuzzy engine: rank alone is not enough
  if (c.pos.github != null) parts.push(0.5 * c.pos.github);
  const base = parts.length ? Math.max(...parts) : 0;
  return blendRelevance(base, m);
}

function cacheKey(query: string, filters: SearchFilters, extra: unknown): string {
  const f = {
    sources: [...(filters.sources ?? ['marketplace', 'skillssh', 'github'])].sort(),
    maxRisk: filters.maxRisk ?? 'medium',
    marketplaces: filters.marketplaces ? [...filters.marketplaces].sort() : null,
  };
  return 'search:' + createHash('sha256').update(JSON.stringify({ q: normalizeQuery(query), f, extra })).digest('hex');
}

type CachedSearch = {
  warnings: Array<Extract<SearchEvent, { type: 'warning' }>>;
  results: Extract<SearchEvent, { type: 'results' }>;
  cachedAt?: number;
  /** Shorter lifetime than the 24h default (set when some candidates were not resolved in time). */
  ttlMs?: number;
};

export async function runSearch(
  deps: SearchDeps,
  query: string,
  filters: SearchFilters,
  emit: (e: SearchEvent) => void,
): Promise<void> {
  const t0 = Date.now();
  const { ctx } = deps;
  const { store, indexer, github } = ctx;
  const settings = getSettings(store);
  // the setting, unless this search lifted it ("별 N개 미만 숨김 · 보기")
  const minStars = filters.minStars ?? settings.minStars;
  const sources = new Set<SourceKind>(filters.sources?.length ? filters.sources : ['marketplace', 'skillssh', 'github']);
  const maxRisk: RiskLevel = filters.maxRisk ?? 'medium';
  // `r` is the result-item shape; bump it when items gain fields so cached searches are rebuilt.
  // c: cached results carry install commands naming the skills CLI version (`npx skills@x.y.z …`)
  // g: the index generation (B1): a sync or collection that changed the index bumps it, so searches cached before
  // are not replayed as they are (they used to be dropped after every sync, changed or not)
  const generation = indexGeneration(store);
  // F20: hidden repos (unless this search shows them) and F19: facets picked for the whole candidate list. Each
  // joins the key only when in use, so a plain search with nothing hidden keeps the key it had before them; a
  // trusted-owner change matters only to a search that filters on it.
  const owners = ownerFilter(store, { showHidden: filters.showHidden });
  const facets = normalizeFacets(filters.facets);
  const prefsKey = {
    ...(owners.hideHash ? { h: owners.hideHash } : {}),
    ...(facets ? { fc: facets, ...(facets.trusted ? { tr: owners.trustHash } : {}) } : {}),
  };
  const keyOf = (g: number) => cacheKey(query, filters, { w: settings.weights, t: !!ctx.config.githubToken, s: minStars, r: RESULTS_VERSION, k: RISK_RULES_VERSION, c: SKILLS_CLI_VERSION, g, ...prefsKey });
  const key = keyOf(generation);

  // The English query for a Korean one goes out first, cached search or not: it comes from the query alone,
  // and the button helps most exactly when there is little else to show.
  const suggestion = koreanSuggestion(query);
  const suggestQuery = suggestion?.query ?? null;
  if (suggestion) emit({ type: 'suggest', query: suggestion.query, dropped: suggestion.dropped });

  const usable = (c: CachedSearch | undefined): c is CachedSearch => !!c && !(c.ttlMs && c.cachedAt && Date.now() - c.cachedAt > c.ttlMs);
  const cached = store.getCached(key, DAY_MS) as CachedSearch | undefined;
  if (usable(cached)) {
    for (const w of cached.warnings) emit(w);
    emit(cached.results);
    emit({ type: 'done', cached: true, elapsedMs: Date.now() - t0 });
    return;
  }
  // The same search from an earlier generation (within a day) is shown first, marked, while it runs again; its
  // warnings are not replayed (the new run sends its own). Not on a first run still collecting (D#323b): those
  // results were partial, and a new search showed the new skills at once.
  if (generation > 0 && store.countSkills() >= (deps.staleMinSkills ?? STALE_MIN_SKILLS)) {
    for (let g = generation - 1; g >= Math.max(0, generation - STALE_GENERATIONS); g--) {
      const old = store.getCached(keyOf(g), DAY_MS) as CachedSearch | undefined;
      if (usable(old) && old.results.items.length > 0) {
        emit({ ...old.results, stale: true });
        break;
      }
    }
  }

  const warnings: CachedSearch['warnings'] = [];
  const warn = (source: string, message: string, severity: 'urgent' | 'note') => {
    const w = { type: 'warning' as const, source, message, severity };
    warnings.push(w);
    emit(w);
  };
  const timings = { collect: 0, enrich: 0, local: 0, skillssh: 0, github: 0, repos: 0, stars: 0 };
  /** Repos whose final star check missed the deadline (their stored count was used). */
  let starsLate = 0;
  /** Slowest candidate resolutions, for the log line. */
  const slow: Array<{ what: string; ms: number; outcome: Outcome }> = [];

  if (/\p{Script=Hangul}/u.test(query)) {
    warn('query', '스킬 설명이 대부분 영어라 한국어 검색어는 결과가 적거나 부정확합니다. 영어로 검색해 보세요 (예: extract tables from pdf).', 'urgent');
  }
  /** Whether the query has an English word at all (a purely Korean one can't match the English descriptions word for word). */
  const latinQuery = queryTokens(query).some((t) => /[a-z0-9]/.test(t));
  /** Above the risk level this search shows (default: high is hidden). Applied on every path that shows skills. */
  const tooRisky = (s: SkillRow) => RISK_ORDER[(s.risk_level as RiskLevel) ?? 'low'] > RISK_ORDER[maxRisk];
  // Only the first MATCH_TEXT_MAX chars of each field count, the spec's description limit: a keyword list
  // stuffed past it (the longest stored description is 13.5K chars) would otherwise buy a higher tier.
  const capped = (t: string | null) => (t ?? '').slice(0, MATCH_TEXT_MAX);
  // names are capped too (the spec allows 64 chars), or a name stuffed with keywords would buy the name tier.
  // One search matches the same skill (and its same-text copies) on every early-cards pass and in each results
  // pass, so each name and text is read once per search: by text, then name.
  const matchMemo = new Map<string, Map<string, LexicalMatch>>();
  const matchOf = (c: Candidate): LexicalMatch => {
    const name = c.skill!.name.slice(0, MATCH_NAME_MAX);
    const text = [capped(c.skill!.description), capped(c.skill!.when_to_use)].join(' ');
    let byName = matchMemo.get(text);
    if (!byName) matchMemo.set(text, (byName = new Map()));
    let m = byName.get(name);
    if (!m) byName.set(name, (m = lexicalMatch(query, name, text)));
    return m;
  };
  /**
   * Not one query word in the name or description (user decision A): mostly skills.sh's semantic matches and
   * GitHub code-search hits on a SKILL.md body. Kept: a skill found by name (a plugin matched by name, the repo
   * named like a one-word query) and searches without an English word. A local full-text hit is kept only when
   * the app's own word matching (stems, prefixes, aliases) also finds a query word (B4, user decision 4): the
   * index's porter stemming joins words that are not the same ("localization" and "local").
   */
  const noQueryWord = (c: Candidate, m: LexicalMatch) => m.any === 0 && latinQuery && !c.viaName;
  /** The same download count rule everywhere (F18): a suspected count becomes unknown for sorting. */
  const withSuspicion = (c: Candidate): Candidate => {
    const s = c.skill;
    if (!s || c.installs == null) return c;
    const suspect = installsSuspect(store, {
      repo: s.repo,
      name: s.name,
      nameDesc: s.name_desc_sha256,
      origin: s.origin,
      installs: c.installs,
      stars: s.repo ? (store.getRepo(s.repo)?.stars ?? null) : null,
      exempt: starsExempt(c),
    });
    return suspect ? { ...c, installs: null, suspect } : c;
  };

  // 1. collect
  emit({ type: 'stage', stage: 'collect', message: '마켓플레이스·skills.sh·GitHub에서 후보를 모으는 중' });
  const match = ftsQuery([query]);
  const allMatch = ftsAllQuery([query]);
  const cands = new Map<string, Candidate>();
  const upsert = (k: string, init: () => Candidate): Candidate => {
    let c = cands.get(k);
    if (!c) cands.set(k, (c = init()));
    return c;
  };
  const blank = (k: string, skill: SkillRow | null, pending: Pending | null = null): Candidate => ({
    key: k,
    skill,
    sources: [],
    installs: null,
    bm25: null,
    pos: {},
    pending,
  });
  const lookup = storeLookup(store);

  // The minimum-stars setting, applied early with the stored counts so low-star candidates neither take the
  // top-MAX_ENRICH places of popular ones nor cost a lookup. buildResults still checks every result with
  // fresh counts; these only decide what gets that far.
  const storedStars = new Map<string, number | null>();
  const storedStarsOf = (repo: string): number | null => {
    const k = repo.toLowerCase();
    if (!storedStars.has(k)) {
      const row = store.getRepo(repo);
      const fresh = row?.fetched_at && Date.now() - Date.parse(row.fetched_at) < STORED_STARS_MAX_AGE_MS;
      storedStars.set(k, fresh ? (row.stars ?? null) : null);
    }
    return storedStars.get(k)!;
  };
  // Official and partner skills skip the star minimum (U1): Anthropic chose them, and most come from plugin
  // repos with few stars or none counted (1,115 of 1,158 official marketplace skills were hidden).
  const starsExempt = (c: Candidate): boolean => {
    const tier = c.skill ? trustTier(c.skill, lookup.plugin(c.skill.plugin_id)) : pendingTier(c);
    return tier === 'official' || tier === 'partner';
  };
  const belowMinStars = (c: Candidate, share: number): boolean => {
    const repo = minStars > 0 && !starsExempt(c) ? candidateRepo(c) : null;
    const st = repo ? storedStarsOf(repo) : null;
    return st != null && st < minStars * share;
  };
  /** Candidates left out for stars before buildResults; they count as hidden low-star results. */
  const droppedForStars = new Set<Candidate>();
  const dropForStars = (c: Candidate): boolean => {
    if (!belowMinStars(c, STAR_PREFILTER_SHARE)) return false;
    droppedForStars.add(c);
    return true;
  };
  // F20: a hidden repo's candidates leave as early as low-star ones (never looked up, no place in the top
  // MAX_ENRICH), from every source; counted for the "숨긴 저장소" chip.
  const droppedForPrefs = new Set<Candidate>();
  /** Hidden repos (lower case) whose own card (a repository found by name) this search left out. */
  const hiddenRepoCards = new Set<string>();
  const dropForPrefs = (c: Candidate): boolean => {
    if (!owners.anyHidden) return false;
    const repo = candidateRepo(c);
    if (!owners.hidden(repo)) return false;
    droppedForPrefs.add(c);
    return true;
  };
  // F19: picked facets, judged on the skill row when there is one, else on what the source says (repo, tier);
  // the rest is checked when the candidate has been read. Kept for the counts over all candidates.
  const valuesMemo = new Map<string, FacetValues>();
  const licenseOf = (r: string | null) => lookup.repoLicense?.(r) ?? null;
  const valuesOf = (s: SkillRow): FacetValues => {
    let v = valuesMemo.get(s.id);
    if (!v) valuesMemo.set(s.id, (v = facetValuesOf(lookup, s, owners, licenseOf)));
    return v;
  };
  const facetPass = (s: SkillRow) => !facets || matchFacetValues(valuesOf(s), facets, t0);
  const droppedForFacets = new Set<Candidate>();
  const dropForFacets = (c: Candidate): boolean => {
    if (!facets) return false;
    const ok = c.skill ? facetPass(c.skill) : mayMatchPending(facets, candidateRepo(c), pendingTier(c), owners);
    if (ok) return false;
    droppedForFacets.add(c);
    return true;
  };
  /** Left out before the top-MAX_ENRICH cut and never looked up: hidden repo, facets, too few stars. */
  const dropped = (c: Candidate): boolean => dropForPrefs(c) || dropForFacets(c) || dropForStars(c);

  // Lookups for candidates that are not in the local index start as soon as their source answers, so
  // skills.sh hits are being resolved while the (slower) GitHub code search is still running.
  const late: Candidate[] = [];
  /**
   * Opens once the local search has run. The network requests leave before it, but their answers (even instant
   * cached ones) merge only after it, so the first cards are the local ones, as before.
   */
  let openLocalGate!: () => void;
  const localGate = new Promise<void>((r) => (openLocalGate = r));
  /** Indexed candidates scored without a lookup: the top of the ranking, plus GitHub and repo-name hits that arrive after it was cut. */
  const ready: Candidate[] = [];
  let enrichStarted = false;
  const addLateIndexed = (list: Candidate[]) => {
    if (!enrichStarted) return;
    for (const c of list) if (!c.pending && c.skill && !ready.includes(c) && !dropped(c)) ready.push(c);
  };
  const outcomes: Record<Outcome, number> = { found: 0, missing: 0, error: 0, timeout: 0, lowstars: 0 };
  const deadline = t0 + (deps.deadlineMs ?? SEARCH_DEADLINE_MS);
  const slots = new Semaphore(ENRICH_CONCURRENCY);
  const started = new Set<Candidate>();
  const lookups: Promise<void>[] = [];
  const errors: string[] = [];

  // "Nothing installable here" is remembered for a day (perf debate 1-2): after a restart the same search read
  // whole trees again (kubernetes, 10MB) and asked deleted repos twice. A push to the repo since (its stored
  // pushed_at) makes the verdict stale. Kept in search_cache, which a restart does not clear for these keys.
  const knownMissing = (key: string, repo: string | null) => {
    const at = store.getCachedAt(key, DAY_MS);
    if (!at) return false;
    const pushed = repo ? store.getRepo(repo)?.pushed_at : null;
    return !(pushed && Date.parse(pushed) > Date.parse(at));
  };

  const resolveCandidate = async (c: Candidate): Promise<Outcome> => {
    const p = c.pending!;
    const ss = p.type === 'skillssh' ? classifySkillsShSource(p.hit.source) : null;
    const [missKey, missRepo] =
      p.type === 'github'
        ? [`miss:v1:gh:${p.repo.toLowerCase()}:${p.path}`, p.repo]
        : p.type === 'skillssh' && ss?.kind === 'github'
          ? [`miss:v1:ss:${ss.repo.toLowerCase()}:${normalizeSkillName(p.hit.name)}:${p.hit.skillId ?? ''}`, ss.repo]
          : [null, null];
    if (missKey && knownMissing(missKey, missRepo)) return 'missing';
    const missed = (): Outcome => {
      if (missKey) store.putCached(missKey, 1);
      return 'missing';
    };
    // A repo never seen before: one metadata call (cached a day) is cheaper than reading its tree and SKILL.md.
    const repo = minStars > 0 && !starsExempt(c) ? candidateRepo(c) : null;
    if (repo && storedStarsOf(repo) == null) {
      const meta = await withTimeout(github.getRepoMeta(repo), Math.max(0, deadline - Date.now()), 'timeout').catch(() => null);
      // other candidates from this repo are then decided in startLookup without waiting for a slot
      if (meta?.stars != null) storedStars.set(repo.toLowerCase(), meta.stars);
      if (meta?.stars != null && meta.stars < minStars) {
        droppedForStars.add(c);
        return 'lowstars';
      }
    }
    let work: Promise<SkillRow[]>;
    if (p.type === 'plugin') {
      work = indexer.indexPlugin(p.plugin.id).then(() => {
        let skills = match ? store.searchSkillsInPlugin(match, p.plugin.id, 3).map((x) => x.skill) : [];
        if (skills.length === 0) skills = store.listSkillsByPlugin(p.plugin.id).slice(0, 2);
        return skills;
      });
    } else if (p.type === 'skillssh') {
      const src = classifySkillsShSource(p.hit.source);
      work =
        src?.kind === 'github'
          ? indexer.findInRepo(src.repo, p.hit.name, p.hit.skillId).then((s) => (s ? [s] : []))
          : Promise.resolve(src?.kind === 'domain' ? [indexer.wellKnownRow(src.domain, p.hit.name, p.hit.installs)] : []);
    } else {
      work = indexer.findByPath(p.repo, p.path).then((s) => (s ? [s] : []));
    }
    work.catch(() => {}); // a timed-out lookup keeps running and stores its row for the next search
    try {
      const skills = await withTimeout(work, Math.max(0, deadline - Date.now()), 'timeout');
      if (skills.length === 0) return missed();
      if (p.type === 'plugin') {
        const plugin = store.getPlugin(p.plugin.id) ?? p.plugin;
        for (const s of skills) late.push({ ...blank(s.id, s), sources: [marketplaceSource(s, plugin)], pos: { ...c.pos }, viaName: c.viaName });
      } else {
        late.push({ ...c, key: skills[0].id, skill: skills[0], pending: null });
      }
      return 'found';
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg === 'timeout') return 'timeout';
      // A deleted or renamed repo is gone for good, not a hiccup.
      if (err instanceof PluginUnavailableError || /저장소를 찾을 수 없습니다|tree 40[49]|tree 422/.test(msg)) return missed();
      errors.push(msg.slice(0, 100));
      return 'error';
    }
  };

  const startLookup = (c: Candidate) => {
    if (!c.pending || started.has(c) || dropped(c)) return;
    started.add(c);
    const p = c.pending;
    const what = p.type === 'plugin' ? `plugin:${p.plugin.id}` : p.type === 'skillssh' ? `ss:${p.hit.source}/${p.hit.name}` : `gh:${p.repo}/${p.path}`;
    lookups.push(
      slots.run(async () => {
        const t = Date.now();
        const outcome = await resolveCandidate(c);
        outcomes[outcome]++;
        slow.push({ what, ms: Date.now() - t, outcome });
      }),
    );
  };

  // One-word queries are often a name ("rea"). The repo with that name is shown as a result of its own, and
  // all its skills join the candidates, even ones whose text never contains the word (morluto/rea's main
  // skill is "reverse-engineer-anything").
  const word = navigationalWord(query);
  const repoInfo = new Map<string, { stars: number | null; description: string | null; topics: string[] }>();
  const addRepoNameSkills = (): Candidate[] => {
    if (!word) return [];
    return store.findSkillsByRepoName(word).map((s) => {
      const c = upsert(s.id, () => blank(s.id, s));
      const plugin = lookup.plugin(s.plugin_id);
      const source = plugin ? marketplaceSource(s, plugin) : githubSource(s);
      if (source) c.sources = mergeSources(c.sources, [source]);
      c.pos.marketplace = 1;
      c.viaName = true;
      return c;
    });
  };
  // Not waited for before the enrich step (a repo search plus indexing a new repo can take up to 14s); its
  // skills join the results when it finishes.
  const collectRepos = async (): Promise<SourceDone> => {
    if (!word) return null;
    try {
      // repository search can filter by stars and returns description and topics for the repo card
      const hits = await withTimeout(github.searchRepos(`${word} in:name stars:>=${Math.max(1, minStars)}`, 30, { maxWaitMs: 4000 }), 6000, 'timeout');
      for (const r of hits) if (r.repo.split('/')[1]?.toLowerCase() === word) repoInfo.set(r.repo, r);
    } catch {
      // GitHub search unavailable: repos already in the local index still count
    }
    await localGate;
    for (const s of store.findSkillsByRepoName(word)) {
      if (s.repo && ![...repoInfo.keys()].some((k) => k.toLowerCase() === s.repo!.toLowerCase())) {
        repoInfo.set(s.repo, { stars: store.getRepo(s.repo)?.stars ?? null, description: null, topics: [] });
      }
    }
    // a hidden repo gets no card and is not read (F20)
    if (owners.anyHidden) {
      for (const k of repoInfo.keys()) {
        if (!owners.hidden(k)) continue;
        repoInfo.delete(k);
        hiddenRepoCards.add(k.toLowerCase());
      }
    }
    // Found on GitHub but never indexed: read its skills now (a slow repo keeps indexing in the background).
    // One read that found no skills is remembered for a day like a missing lookup (perf debate 1-2).
    const noSkillKey = (r: string) => `noskill:v1:${r.toLowerCase()}`;
    const unindexed = [...repoInfo.keys()].slice(0, 3).filter((r) => store.findSkillsByRepo(r).length === 0 && !knownMissing(noSkillKey(r), r));
    await Promise.all(
      unindexed.map((r) => {
        const job = indexer.indexRepo(r);
        job.then((res) => (res.skills === 0 && !res.unchanged ? store.putCached(noSkillKey(r), 1) : undefined)).catch(() => {});
        return withTimeout(job, 8000, 'timeout').catch(() => 0);
      }),
    );
    addLateIndexed(addRepoNameSkills());
    return { state: 'done', count: repoInfo.size };
  };

  const collectLocal = async (): Promise<SourceDone> => {
    if (!sources.has('marketplace') || !match) return null;
    // Marketplace skills plus skills indexed straight from GitHub repos (popular-repo collection, earlier lookups).
    // Skills with every query word come first, then the rest of the OR matches ("find security holes": a rare
    // word alone, "hole" in Pi-hole, no longer outranks a skill about security holes). bm25 is the same in both.
    const all = (allMatch ? store.searchSkillsFts(allMatch, 120, filters.marketplaces) : []).filter((h) => h.skill.origin !== 'wellknown');
    const allIds = new Set(all.map((h) => h.skill.id));
    // 120 skills with every word already fill the list; the OR query would only be cut off
    const rest = all.length >= 120 ? [] : store.searchSkillsFts(match, 120, filters.marketplaces);
    const hits = [...all, ...rest.filter((h) => !allIds.has(h.skill.id) && h.skill.origin !== 'wellknown')].slice(0, 120);
    hits.forEach((h, i) => {
      const c = upsert(h.skill.id, () => blank(h.skill.id, h.skill));
      const plugin = lookup.plugin(h.skill.plugin_id);
      const source = plugin ? marketplaceSource(h.skill, plugin) : githubSource(h.skill);
      if (source) c.sources = mergeSources(c.sources, [source]);
      c.bm25 = c.bm25 == null ? h.bm25 : Math.min(c.bm25, h.bm25);
      c.pos.marketplace = Math.max(c.pos.marketplace ?? 0, posScore(i, hits.length));
    });
    addRepoNameSkills();
    const pluginHits = store.searchPluginsFts(match, 20, filters.marketplaces);
    // the matching skills of every indexed plugin hit in one query
    const inPlugins = store.searchSkillsInPlugins(match, pluginHits.filter((h) => h.plugin.skills_indexed_at).map((h) => h.plugin.id), 3);
    pluginHits.forEach((h, i) => {
      const score = 0.9 * posScore(i, pluginHits.length);
      if (h.plugin.skills_indexed_at) {
        let skills = (inPlugins.get(h.plugin.id) ?? []).map((x) => x.skill);
        if (skills.length === 0) skills = store.listSkillsByPlugin(h.plugin.id).slice(0, 2);
        for (const s of skills) {
          const c = upsert(s.id, () => blank(s.id, s));
          c.sources = mergeSources(c.sources, [marketplaceSource(s, h.plugin)]);
          c.pos.marketplace = Math.max(c.pos.marketplace ?? 0, score);
          c.viaName = true;
        }
      } else if (h.plugin.repo) {
        const c = upsert(`pl:${h.plugin.id}`, () => blank(`pl:${h.plugin.id}`, null, { type: 'plugin', plugin: h.plugin }));
        c.pos.marketplace = Math.max(c.pos.marketplace ?? 0, score);
        c.viaName = true;
        startLookup(c);
      }
    });
    return { state: 'done', count: hits.length + pluginHits.length };
  };

  const collectSkillsSh = async (): Promise<SourceDone> => {
    if (!sources.has('skillssh')) return null;
    // offline (the scheduler saw the network fail): the local index only, without waiting for timeouts (P10)
    if (isOffline()) {
      warn('skillssh', '오프라인 · 로컬 색인만', 'note');
      return null;
    }
    let hits: SkillsShHit[];
    try {
      hits = await withTimeout(deps.skillsSh(query), 6000, 'timeout');
      noteNetworkOk();
    } catch (err) {
      noteNetworkError(err);
      warn('skillssh', `skills.sh 검색 실패 (${shortErr(err)})`, 'urgent');
      return { state: shortErr(err) === 'timeout' ? 'timeout' : 'failed', count: 0 };
    }
    await localGate;
    const touched: Candidate[] = [];
    hits.forEach((hit, i) => {
      const src = classifySkillsShSource(hit.source);
      if (!src) return;
      const local = src.kind === 'github' ? matchLocal(store.findSkillsByRepo(src.repo), hit) : null;
      const k = local ? local.id : `ss:${hit.source.toLowerCase()}:${normalizeSkillName(hit.name)}`;
      const c = upsert(k, () => blank(k, local, local ? null : { type: 'skillssh', hit }));
      c.sources = mergeSources(c.sources, [{ kind: 'skillssh', label: 'skills.sh', url: `https://skills.sh/${hit.id.split('/').map(encodeURIComponent).join('/')}` }]);
      c.installs = Math.max(c.installs ?? 0, hit.installs);
      c.pos.skillssh = Math.max(c.pos.skillssh ?? 0, posScore(i, hits.length));
      startLookup(c);
      touched.push(c);
    });
    // an answer after the collect wait joins like a late GitHub one (indexed hits as they are)
    addLateIndexed(touched);
    return { state: 'done', count: hits.length };
  };

  // Waited for at most GITHUB_COLLECT_WAIT_MS; hits arriving later still get their lookups and join the results.
  const collectGithub = async (): Promise<SourceDone> => {
    if (!sources.has('github')) return null;
    if (!github.hasToken) {
      warn('github', 'GitHub 토큰이 없어 GitHub 코드 검색을 건너뜁니다 (설정에서 토큰을 넣으면 사용됩니다)', 'note');
      return null;
    }
    if (isOffline()) return null;
    try {
      // past ~8s of queue (the 10/min limit) it gives up at once instead of taking a slot the next search needs
      const items = await withTimeout(github.searchSkillFiles(queryKeywords(query), 50, { maxWaitMs: 8000 }), 10_000, 'timeout');
      await localGate;
      const hits: Candidate[] = [];
      items.forEach((it, i) => {
        const dir = it.path === 'SKILL.md' ? '' : it.path.replace(/\/SKILL\.md$/, '');
        const k = skillId(it.repo, dir);
        const local = store.getSkill(k) ?? null;
        const c = upsert(k, () => blank(k, local, local ? null : { type: 'github', repo: it.repo, path: it.path }));
        const url = it.htmlUrl.startsWith('https://github.com/') ? it.htmlUrl : `https://github.com/${it.repo}`;
        c.sources = mergeSources(c.sources, [{ kind: 'github', label: 'GitHub', url }]);
        c.pos.github = Math.max(c.pos.github ?? 0, 0.8 * posScore(i, items.length));
        if (i < GITHUB_EARLY_LOOKUPS) startLookup(c);
        hits.push(c);
      });
      // after the cut, indexed hits join as they are (no lookup needed); unindexed ones past the first 30 are left out
      addLateIndexed(hits);
      return { state: 'done', count: items.length };
    } catch (err) {
      warn('github', `GitHub 검색 실패 (${shortErr(err)})`, 'urgent');
      return { state: shortErr(err) === 'timeout' ? 'timeout' : 'failed', count: 0 };
    }
  };

  const runSource = (name: SourceName, fn: () => Promise<SourceDone>): Promise<void> => {
    const t = Date.now();
    emit({ type: 'source', source: name, state: 'running' });
    // Never rejects: GitHub and the repo search are awaited much later, and an unhandled rejection would end the process.
    return fn()
      .catch((err): SourceDone => {
        warn(name, `${SOURCE_NAME_KO[name]} 검색 실패 (${shortErr(err)})`, name === 'repos' ? 'note' : 'urgent');
        return { state: 'failed', count: 0 };
      })
      .then((r) => {
        timings[name] = Date.now() - t;
        emit(r ? { type: 'source', source: name, state: r.state, count: r.count, ms: timings[name] } : { type: 'source', source: name, state: 'skipped' });
      });
  };
  const ranked = () => [...cands.values()].sort((a, b) => prelim(b) - prelim(a));
  // Early cards, sent as each source answers: only ones the final checks (stars, a query word) are likely to
  // keep, so they don't flash and vanish; with their tier, so the page sorts them as it will the results.
  // They carry the stored installs and stars and go through the same copy merging, so the page sorts them the
  // way it will sort the results (without them it ordered by rank alone, and the final list reshuffled).
  const emitCandidates = () => {
    const shown = ranked().filter((c) => {
      if (!c.skill?.description || tooRisky(c.skill)) return false;
      if (owners.hidden(c.skill.repo) || !facetPass(c.skill)) return false;
      // stars unknown is hidden in the end ("모르면 숨김"), so not shown early either
      const repo = c.skill.repo;
      if (minStars > 0 && !starsExempt(c) && (repo ? storedStarsOf(repo) : null) == null) return false;
      return !belowMinStars(c, 1) && !noQueryWord(c, matchOf(c));
    });
    const items: ResultItem[] = [];
    for (const c of dedupeByContent(shown.map((c) => withSuspicion({ ...c, installs: c.installs ?? freshInstalls(c.skill!) })), lookup)) {
      if (items.length >= MAX_RESULTS) break;
      const s = c.skill!;
      const st = s.repo ? storedStarsOf(s.repo) : null;
      const item = toItem(c, lookup, { R: Math.min(1, prelim(c)), P: 0, F: freshness(s.last_commit_at), T: trust(s, lookup) }, settings.weights, st);
      items.push({ ...item, tier: relevanceTier(matchOf(c)) });
    }
    if (items.length) emit({ type: 'candidates', items });
  };

  // The local index answers in a fraction of a second, so its cards show first; skills.sh (a few seconds) is
  // waited for; GitHub code search only up to GITHUB_COLLECT_WAIT_MS, and the repo-name search not at all.
  // The requests are started before the local search (synchronous SQLite) instead of after it, which held them
  // back for its whole duration (median ~250ms). They get as far as one event-loop turn takes them (sockets
  // opening); their answers are read once the local search is done.
  const skillsShDone = runSource('skillssh', collectSkillsSh);
  const githubDone = runSource('github', collectGithub);
  const reposDone = word ? runSource('repos', collectRepos) : Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
  try {
    await runSource('local', collectLocal).then(emitCandidates);
  } finally {
    openLocalGate(); // whatever happens, or the network sources would wait forever
  }
  // skills.sh carries the downloads, the first sort key: the early cards are sent again as soon as it answers,
  // not only when GitHub is also in (perf debate 1-5; the top five settled 0.3–1s sooner where they changed).
  let collected = false;
  void skillsShDone.then(() => {
    if (!collected) emitCandidates();
  });
  // skills.sh and GitHub are waited for up to the same point (it took over 4s in ~1% of measured searches);
  // a later answer joins the results when it arrives, and that search is cached only briefly.
  const collectWait = sleep(Math.max(0, t0 + (deps.githubWaitMs ?? GITHUB_COLLECT_WAIT_MS) - Date.now())).then(() => false);
  const [skillsShInTime, githubInTime] = await Promise.all([
    Promise.race([skillsShDone.then(() => true), collectWait]),
    Promise.race([githubDone.then(() => true), collectWait]),
  ]);
  timings.collect = Date.now() - t0;
  collected = true;
  emitCandidates();

  // 2. enrich: wait for the lookups (already running), plus any top candidate not started yet
  emit({ type: 'stage', stage: 'enrich', message: '상위 후보의 SKILL.md와 저장소 정보를 확인하는 중' });
  const top = ranked()
    .filter((c) => !dropped(c))
    .slice(0, MAX_ENRICH);
  ready.push(...top.filter((c) => !c.pending));
  enrichStarted = true;
  // Star counts for the already-indexed candidates load while the lookups run.
  const readyRepos = [...new Set(ready.map((c) => c.skill!.repo).filter((r): r is string => !!r))];
  void pool(readyRepos.slice(0, 15), 6, (r) => github.getRepoMeta(r).catch(() => null));
  for (const c of top) startLookup(c);
  // GitHub and the repo-name search may still add lookups, so wait until no new ones appear.
  const settled = (async () => {
    await Promise.all([skillsShDone, githubDone, reposDone]);
    for (let n = -1; n !== lookups.length; ) {
      n = lookups.length;
      await Promise.all(lookups);
    }
  })();
  // Most lookups finish within a second or two, but a giant mirror repo (tree too big for the API, so a
  // git fetch) takes 5–7s. Show the finished results after a short wait and fold stragglers in when done.
  const allDone = await Promise.race([settled.then(() => true), sleep(INTERIM_WAIT_MS).then(() => false)]);
  if (!allDone) emit(await buildResults([...late], false));
  await settled;
  if (outcomes.timeout > 0) {
    warn('enrich', `${outcomes.timeout}개 후보는 GitHub 응답이 늦어 이번 결과에서 빠졌습니다. 확인은 계속 진행되니 잠시 뒤 다시 검색하면 포함됩니다.`, 'urgent');
  }
  if (outcomes.error > 0) warn('enrich-skip', `GitHub에서 읽지 못한 후보 ${outcomes.error}개는 뺐습니다.`, 'note');
  if (outcomes.missing > 0) {
    warn('enrich-skip', `설치할 수 있는 SKILL.md가 없는 후보 ${outcomes.missing}개는 뺐습니다 (예제·템플릿이거나 이름이 바뀐 스킬).`, 'note');
  }

  timings.enrich = Date.now() - t0 - timings.collect;

  // 3. score
  emit({ type: 'stage', stage: 'score', message: '점수를 계산하는 중' });
  const results = await buildResults(late, true);
  emit(results);
  if (results.items.length > 0) {
    // A late GitHub answer skipped the lookups of its unindexed hits past the first 30, so cache it briefly too.
    const partial = outcomes.timeout + outcomes.error > 0 || !githubInTime || !skillsShInTime || starsLate > 0;
    store.putCached(key, { warnings, results, cachedAt: Date.now(), ...(partial ? { ttlMs: PARTIAL_CACHE_MS } : {}) } satisfies CachedSearch);
  }
  const elapsedMs = Date.now() - t0;
  const slowest = slow
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 4)
    .map((s) => `${s.what} ${s.ms}ms${s.outcome === 'found' ? '' : ` (${s.outcome})`}`);
  console.log(
    `[search] ${elapsedMs}ms ${JSON.stringify(timings)} lookups=${JSON.stringify(outcomes)} results=${results.items.length}${allDone ? '' : ' (interim sent)'}${githubInTime ? '' : ' (github late)'}${skillsShInTime ? '' : ' (skills.sh late)'}${starsLate ? ` (stars late ${starsLate})` : ''} q=${JSON.stringify(query)}` +
      (slowest.length ? `\n  slowest: ${slowest.join(' | ')}` : '') +
      (errors.length ? `\n  errors: ${errors.slice(0, 3).join(' | ')}` : ''),
  );
  emit({ type: 'done', cached: false, elapsedMs });

  /**
   * Candidates left out for stars before buildResults. A copy of a shown skill (same SKILL.md, e.g. a low-star
   * fork) adds its installs to it, as dedupeByContent does for the others; the rest are counted once each as
   * hidden low-star results (a skill reached from both skills.sh and GitHub code search counts once).
   */
  function foldDroppedForStars(shown: Candidate[]): number {
    const byContent = new Map<string, Candidate>();
    for (const c of shown) if (c.skill?.skill_md_sha256) byContent.set(c.skill.skill_md_sha256, c);
    const hidden = new Set<string>();
    for (const c of droppedForStars) {
      const s = c.skill;
      const copyOf = s?.skill_md_sha256 ? byContent.get(s.skill_md_sha256) : undefined;
      if (copyOf) {
        // a low-star copy with a suspected count (F18) adds nothing (it is what inflated the original before)
        const own = withSuspicion(c).installs;
        if (own != null) copyOf.installs = (copyOf.installs ?? 0) + own;
        copyOf.sources = mergeSources(copyOf.sources, c.sources);
        continue;
      }
      if (s && !s.description) continue;
      hidden.add(s?.skill_md_sha256 ?? droppedKey(c));
    }
    return hidden.size;
  }

  /** Scores the indexed candidates plus the resolved ones; `final` also refreshes star counts from GitHub. */
  async function buildResults(resolved: Candidate[], final: boolean): Promise<Extract<SearchEvent, { type: 'results' }>> {
    // One transaction for the pass, not an autocommit per candidate (10.9ms a search). The writes and reads stay
    // interleaved as before: withSuspicion's facts read the installs written for the candidates before it.
    const merged = store.transaction(() =>
      mergeById([...ready, ...resolved]).map((c) => {
        if (c.installs != null && c.skill) store.setSkillInstalls(c.skill.id, c.installs); // the latest count, even 0 (U4)
        if (c.installs == null && c.skill) c.installs = freshInstalls(c.skill);
        // before copies are merged, so a suspected count is not added to the copy shown (F18)
        return withSuspicion(c);
      }),
    );
    // F20: a resolved candidate from a hidden repo (a plugin read under its marketplace name) leaves here too.
    const visible = owners.anyHidden ? merged.filter((c) => !dropForPrefs(c)) : merged;
    // The risk filter comes before merging copies: a hidden high-risk representative used to take its
    // lower-risk copies with it, and high-risk candidates held places in the top MAX_ENRICH.
    const risky: Candidate[] = [];
    const allowedAll = visible.filter((c) => (tooRisky(c.skill!) ? (risky.push(c), false) : true));
    // F19: the facets before copies are merged (a copy in another repo may pass where its representative would
    // not) and before any cut. What they leave out still counts in facetCounts, with the candidates dropped early.
    const allowed = facets ? allowedAll.filter((c) => facetPass(c.skill!)) : allowedAll;
    const deduped = dedupeByContent(allowed, lookup).sort((a, b) => prelim(b) - prelim(a));

    // Stars for every candidate repo (cached 24h; the minimum-stars filter needs them all). Interim results
    // use what is cached. The final check stops at the search deadline (U5-1, user decision): repos not
    // checked by then use a stored count up to 7 days old, and without one stay unknown (hidden) as before.
    const repos = [...new Set([...deduped, ...risky].map((c) => c.skill!.repo).filter((r): r is string => !!r))];
    const stars = new Map<string, number | null>();
    const tStars = Date.now();
    if (final) {
      let open = true;
      const check = pool(repos, 8, async (r) => {
        if (Date.now() >= deadline) return;
        const meta = await github.getRepoMeta(r).catch(() => null);
        if (open) stars.set(r.toLowerCase(), meta?.stars ?? null);
      });
      await withTimeout(check, Math.max(0, deadline - Date.now()), 'timeout').catch(() => undefined);
      open = false;
      timings.stars = Date.now() - tStars;
      starsLate = repos.filter((r) => !stars.has(r.toLowerCase())).length;
      for (const r of repos) if (!stars.has(r.toLowerCase())) stars.set(r.toLowerCase(), storedStarsOf(r));
    }
    for (const r of repos) if (!stars.has(r.toLowerCase())) stars.set(r.toLowerCase(), store.getRepo(r)?.stars ?? null);
    const starsOf = (c: Candidate) => (c.skill!.repo ? (stars.get(c.skill!.repo.toLowerCase()) ?? null) : null);

    // Minimum GitHub stars (user setting, default 5,000). An unknown count does not pass: it may be below.
    const starsPass = (c: Candidate) => {
      if (minStars <= 0 || starsExempt(c)) return true;
      const st = starsOf(c);
      return st != null && st >= minStars;
    };
    let hiddenLowStars = 0;
    let hiddenUnknownStars = 0;
    const finalists = deduped
      .filter((c) => {
        if (starsPass(c)) return true;
        if (c.skill!.description) {
          if (starsOf(c) == null) hiddenUnknownStars++;
          else hiddenLowStars++;
        }
        return false;
      })
      .slice(0, MAX_ENRICH);
    // "위험 높음 N개 숨김" counts only what would otherwise have been shown (one per SKILL.md)
    const hiddenHighRisk = new Set(
      risky.filter((c) => c.skill!.description && facetPass(c.skill!) && starsPass(c) && !noQueryWord(c, matchOf(c))).map((c) => c.skill!.skill_md_sha256 ?? c.skill!.id),
    ).size;
    hiddenLowStars += foldDroppedForStars(finalists);
    const facetCounts = facets ? countFacets(countPool(), facets, t0) : undefined;
    /**
     * Every candidate the facets are counted over: what this search would show without them (hidden repos, risk,
     * stars, description and query-word rules applied, one per SKILL.md), including the ones dropped for the
     * facets before the cut. Their stars are the stored counts.
     */
    function countPool(): FacetValues[] {
      const byId = new Map<string, Candidate>();
      for (const c of allowedAll) byId.set(c.skill!.id, c);
      for (const c of droppedForFacets) {
        const s = c.skill;
        if (s && !byId.has(s.id) && !owners.hidden(s.repo) && !tooRisky(s)) byId.set(s.id, c);
      }
      const list = dedupeByContent([...byId.values()], lookup);
      for (const c of list) {
        const r = c.skill!.repo?.toLowerCase();
        if (r && !stars.has(r)) stars.set(r, store.getRepo(c.skill!.repo!)?.stars ?? null);
      }
      return list.filter((c) => c.skill!.description && starsPass(c) && !noQueryWord(c, matchOf(c))).map((c) => valuesOf(c.skill!));
    }
    // "숨긴 저장소 N개" (F20): results left out for a hidden repo, one per SKILL.md (not one shown through a copy
    // elsewhere), not the name-only ones
    const shownMd = new Set(finalists.map((c) => c.skill!.skill_md_sha256).filter(Boolean));
    // Only what showing them would bring back: a hidden repo's result that is also over the risk limit or under the
    // star line stays out either way, and "숨긴 저장소 5개 · 보기" then showed two (review 2026-11-10). Stars are the
    // stored counts; a candidate never read is counted, since nothing is known of it.
    const backFromPrefs = owners.anyHidden
      ? [...droppedForPrefs].filter((c) => {
          const s = c.skill;
          if (!s) return true;
          if (!s.description || tooRisky(s)) return false;
          const r = s.repo?.toLowerCase();
          if (r && !stars.has(r)) stars.set(r, store.getRepo(s.repo!)?.stars ?? null);
          return starsPass(c);
        })
      : [];
    const hiddenByPrefs = new Set(
      backFromPrefs.filter((c) => !(c.skill?.skill_md_sha256 && shownMd.has(c.skill.skill_md_sha256))).map((c) => c.skill?.skill_md_sha256 ?? droppedKey(c)),
    ).size;
    const hiddenRepoNames = new Set([...hiddenRepoCards, ...backFromPrefs.map((c) => candidateRepo(c)?.toLowerCase()).filter((r): r is string => !!r)]);

    const bm = finalists.map((c) => c.bm25).filter((b): b is number => b != null);
    const best = bm.length ? Math.min(...bm) : 0;
    const worst = bm.length ? Math.max(...bm) : 0;
    const maxInstalls = Math.max(0, ...finalists.map((c) => c.installs ?? 0));
    const maxStars = Math.max(0, ...finalists.map((c) => stars.get(c.skill!.repo?.toLowerCase() ?? '') ?? 0));
    let hiddenNoDescription = 0;
    let hiddenNoMatch = 0;
    const items: ResultItem[] = [];
    /** Results a query word matched only through an alias, by id. */
    const aliasOf = new Map<string, AliasUse[]>();
    for (const found of finalists) {
      const s = found.skill!;
      // Name-only hits (well-known sources without a description) can't be judged or read.
      if (!s.description) {
        hiddenNoDescription++;
        continue;
      }
      const m = matchOf(found);
      if (noQueryWord(found, m)) {
        hiddenNoMatch++;
        continue;
      }
      if (m.aliased) aliasOf.set(s.id, m.aliased);
      const st = s.repo ? (stars.get(s.repo.toLowerCase()) ?? null) : null;
      // checked again with the star count just fetched (the first check used the stored one)
      const fresh = !found.suspect && found.installs != null && st != null
        ? installsSuspect(store, { repo: s.repo, name: s.name, nameDesc: s.name_desc_sha256, origin: s.origin, installs: found.installs, stars: st, exempt: starsExempt(found) })
        : null;
      const c = fresh ? { ...found, installs: null, suspect: fresh } : found;
      const breakdown: Breakdown = {
        R: relevance(c, best, worst, m),
        P: popularity({ installs: c.installs, stars: st }, maxInstalls, maxStars),
        F: freshness(s.last_commit_at),
        T: trust(s, lookup),
      };
      items.push({ ...toItem(c, lookup, breakdown, settings.weights, st), tier: relevanceTier(m) });
    }
    items.sort(byNameThenPopularity(query, items));
    const repoCards: RepoResult[] = [...repoInfo]
      .filter(([, i]) => minStars <= 0 || (i.stars ?? 0) >= minStars)
      .sort((a, b) => (b[1].stars ?? 0) - (a[1].stars ?? 0))
      .slice(0, 3)
      .map(([repo, i]) => ({
        repo,
        url: `https://github.com/${repo}`,
        description: i.description,
        stars: i.stars,
        topics: i.topics,
        skills: store
          .findSkillsByRepo(repo)
          .filter((s) => s.description && s.origin !== 'wellknown' && !tooRisky(s))
          .slice(0, 30)
          .map((s) => installSummary(s, lookup)),
      }))
      // a skill finder: a same-named repo without skills (facebook/react for "react") is not a result
      .filter((r) => r.skills.length > 0);
    const shownItems = items.slice(0, MAX_RESULTS);
    const aliasUses = new Map<string, Set<string>>();
    for (const it of shownItems) for (const a of aliasOf.get(it.id) ?? []) aliasUses.set(a.from, new Set([...(aliasUses.get(a.from) ?? []), ...a.to]));
    const aliases: AliasUse[] = [...aliasUses].map(([from, to]) => ({ from, to: [...to] }));
    // only when there is little to show, and only from the final results (the dictionary takes ~0.4 s to build once)
    const spelling = final && shownItems.length < SPELLING_FEW && latinQuery ? spellingSuggestion(store, query) : null;
    return {
      type: 'results' as const,
      items: shownItems,
      hiddenHighRisk,
      hiddenNoDescription,
      hiddenLowStars,
      hiddenUnknownStars,
      minStars,
      hiddenNoMatch,
      ...(isBroadQuery(query) ? { broadQuery: true } : {}),
      repos: repoCards,
      ...(suggestQuery ? { suggestQuery } : {}),
      ...(aliases.length ? { aliases } : {}),
      ...(spelling ? { spelling } : {}),
      ...(hiddenByPrefs > 0 || hiddenRepoNames.size > 0 ? { hiddenByPrefs, hiddenRepos: hiddenRepoNames.size } : {}),
      ...(facets ? { facets, facetCounts } : {}),
    };
  }
}

/**
 * Result order (user decision): installs, then stars, then relevance (R). Unknown counts sort after
 * known ones, so a skill with any installs ranks above one whose installs are unknown.
 */
export function byPopularity(a: ResultItem, b: ResultItem): number {
  return (b.installs ?? -1) - (a.installs ?? -1) || (b.stars ?? -1) - (a.stars ?? -1) || b.breakdown.R - a.breakdown.R;
}

/** The query as a single lowercase name-like word ("rea", "pdf-tools"), or null for multi-word queries. */
export function navigationalWord(query: string): string | null {
  const q = normalizeQuery(query);
  return /^[a-z0-9][a-z0-9._-]{1,99}$/.test(q) ? q : null;
}

/**
 * The main skill of the repo named like a one-word query: its most downloaded one, when that has at least twice
 * the downloads of the next (morluto/rea's reverse-engineer-anything: 11,216, the rest none). The repo's other
 * skills are mostly its contributors' own tooling (react/react's `.claude/skills`), and installing a whole repo
 * counts each of its skills, so they often have about the same count (mastra-ai/mastra 2,400-2,800 each): no
 * main skill there (user decision 2026-11-02). Ids are `gh:owner/repo:dir`.
 */
export function repoMainSkill(items: ReadonlyArray<Pick<ResultItem, 'id' | 'installs'>>, word: string): string | null {
  const [first, second] = items
    .filter((i) => i.id.match(/^gh:[^/]+\/([^:]+):/)?.[1]?.toLowerCase() === word)
    .map((i) => ({ id: i.id, n: i.installs ?? 0 }))
    .sort((a, b) => b.n - a.n);
  return first && first.n > 0 && first.n >= 2 * (second?.n ?? 0) ? first.id : null;
}

/**
 * Typing a skill's or repo's exact name is a lookup: skills named `q` or `q-…` come first (most popular first
 * among them), and so does the main skill of a repo named `q` (repoMainSkill). Everything else, the repo's other
 * skills included, keeps the popularity order.
 */
export function nameMatches(item: Pick<ResultItem, 'id' | 'name'>, word: string, main: string | null = null): boolean {
  const name = item.name.toLowerCase();
  return name === word || name.startsWith(`${word}-`) || item.id === main;
}

/** Relevance tier first (user decision C, see relevanceTier), then popularity. */
export function byTierThenPopularity(a: ResultItem, b: ResultItem): number {
  return (b.tier ?? 0) - (a.tier ?? 0) || byPopularity(a, b);
}

/** `items`: the results being sorted, to find the same-name repo's main skill. */
export function byNameThenPopularity(query: string, items: ReadonlyArray<ResultItem> = []): (a: ResultItem, b: ResultItem) => number {
  const word = navigationalWord(query);
  if (!word) return byTierThenPopularity;
  const main = repoMainSkill(items, word);
  // Among the skills a name lookup found, popularity alone decides (morluto/rea's main skill has no "rea" in its name).
  return (a, b) => {
    const na = nameMatches(a, word, main);
    const nb = nameMatches(b, word, main);
    return Number(nb) - Number(na) || (na ? byPopularity(a, b) : byTierThenPopularity(a, b));
  };
}

/** The trust tier of a candidate not read yet, from what its source says (the repo, the plugin's marketplace). */
function pendingTier(c: Candidate): TrustTier | null {
  const p = c.pending;
  if (p?.type === 'plugin') return trustTier({ repo: p.plugin.repo, dir_path: p.plugin.path }, p.plugin);
  const repo = candidateRepo(c);
  return repo ? trustTier({ repo, dir_path: p?.type === 'github' ? p.path : null }, null) : null;
}

/** The GitHub repo a candidate's skill lives in, known before its lookup (null for well-known sites). */
function candidateRepo(c: Candidate): string | null {
  if (c.skill) return c.skill.repo;
  const p = c.pending;
  if (!p) return null;
  if (p.type === 'plugin') return p.plugin.repo;
  if (p.type === 'github') return p.repo;
  const src = classifySkillsShSource(p.hit.source);
  return src?.kind === 'github' ? src.repo : null;
}

/** Same key for one skill whether it came from skills.sh, GitHub code search or the index: repo + skill name. */
function droppedKey(c: Candidate): string {
  const p = c.pending;
  const name = c.skill ? c.skill.name : p?.type === 'skillssh' ? p.hit.name : p?.type === 'github' ? basename(p.path.replace(/\/?SKILL\.md$/, '')) : null;
  if (p?.type === 'plugin') return `pl:${p.plugin.id}`;
  return `${candidateRepo(c)?.toLowerCase() ?? ''}:${normalizeSkillName(name ?? c.key)}`;
}

/** Folds candidates that resolved to the same skill row into one (first one wins as the base). */
function mergeById(list: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of list) {
    const k = c.skill!.id;
    const prev = byId.get(k);
    if (!prev) {
      byId.set(k, { ...c, key: k, sources: [...c.sources], pos: { ...c.pos } });
      continue;
    }
    prev.sources = mergeSources(prev.sources, c.sources);
    prev.installs = maxNullable(prev.installs, c.installs);
    if (c.viaName) prev.viaName = true;
    prev.bm25 = prev.bm25 == null ? c.bm25 : c.bm25 == null ? prev.bm25 : Math.min(prev.bm25, c.bm25);
    for (const [kind, v] of Object.entries(c.pos) as Array<[SourceKind, number]>) prev.pos[kind] = Math.max(prev.pos[kind] ?? 0, v);
  }
  return [...byId.values()];
}

function shortErr(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 120);
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function trust(s: SkillRow, lookup: Lookup): number {
  return TRUST_SCORE[trustTier(s, lookup.plugin(s.plugin_id))];
}

function matchLocal(rows: SkillRow[], hit: SkillsShHit): SkillRow | null {
  const want = normalizeSkillName(hit.name);
  const folder = hit.skillId ? normalizeSkillName(hit.skillId) : null;
  const plugins = rows.filter((r) => r.origin !== 'wellknown');
  return (
    plugins.find((r) => normalizeSkillName(r.name) === want && r.origin === 'plugin') ??
    plugins.find((r) => normalizeSkillName(r.name) === want) ??
    (folder ? plugins.find((r) => r.dir_path && normalizeSkillName(basename(r.dir_path)) === folder) : undefined) ??
    null
  );
}

/**
 * Same SKILL.md published in several places → one result, sources and installs combined. Only the same file
 * (U4, user decision): a same name+description with a different body is another skill (an edited fork), so
 * summing its downloads overstated both; the screen folds same-name results instead, without summing.
 */
function dedupeByContent(cands: Candidate[], lookup: Lookup): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  const merged: Candidate[] = [];
  const out: Candidate[][] = [];
  for (const c of cands) {
    const k = c.skill!.skill_md_sha256;
    const existing = k ? groups.get(k) : undefined;
    if (existing) existing.push(c);
    else {
      const g = [c];
      if (k) groups.set(k, g);
      out.push(g);
    }
  }
  for (const g of out) {
    const c = g[0];
    if (g.length === 1) {
      merged.push(c);
      continue;
    }
    const rep = [...g].sort(
      (a, b) =>
        trust(b.skill!, lookup) - trust(a.skill!, lookup) ||
        Number(b.skill!.origin === 'plugin') - Number(a.skill!.origin === 'plugin') ||
        (b.installs ?? 0) - (a.installs ?? 0),
    )[0];
    const combined: Candidate = { ...rep, sources: [...rep.sources], pos: { ...rep.pos } };
    let installs = 0;
    let anyInstalls = false;
    for (const x of g) {
      combined.sources = mergeSources(combined.sources, x.sources);
      if (x.installs != null) {
        installs += x.installs;
        anyInstalls = true;
      }
      if (x.bm25 != null) combined.bm25 = combined.bm25 == null ? x.bm25 : Math.min(combined.bm25, x.bm25);
      for (const [kind, v] of Object.entries(x.pos) as Array<[SourceKind, number]>) combined.pos[kind] = Math.max(combined.pos[kind] ?? 0, v);
    }
    combined.installs = anyInstalls ? installs : null;
    if (g.some((x) => x.viaName)) combined.viaName = true;
    // the copies' trusted downloads stand for the group; with none, the group's count is the suspected one
    const suspect = anyInstalls ? undefined : (rep.suspect ?? g.find((x) => x.suspect)?.suspect);
    if (suspect) combined.suspect = suspect;
    else delete combined.suspect;
    merged.push(combined);
  }
  return merged;
}

function toItem(c: Candidate, lookup: Lookup, breakdown: Breakdown, weights: Breakdown, stars: number | null = null): ResultItem {
  const item = buildResultItem({
    skill: c.skill!,
    lookup,
    sources: c.sources.length ? c.sources : [githubSource(c.skill!) ?? { kind: 'github', label: 'GitHub', url: '' }],
    installs: c.installs,
    stars,
    breakdown,
    score: totalScore(breakdown, weights),
  });
  return c.suspect && c.installs == null ? { ...item, installsSuspect: c.suspect } : item;
}

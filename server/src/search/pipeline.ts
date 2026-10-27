import { createHash } from 'node:crypto';
import { RISK_ORDER, type RiskLevel } from '../analyze/risk.ts';
import type { AppContext } from '../context.ts';
import type { PluginRow, SkillRow } from '../db/store.ts';
import { basename } from '../discovery/tree.ts';
import { normalizeSkillName, PluginUnavailableError, skillId } from '../indexer.ts';
import { getSettings } from '../settings.ts';
import { classifySkillsShSource, type SkillsShHit } from '../sources/skillsSh.ts';
import { pool, Semaphore, sleep, withTimeout } from '../util/limiter.ts';
import { blendRelevance, bm25ToRelevance, freshness, lexicalMatch, popularity, totalScore, TRUST_SCORE, trustTier, type Breakdown } from './rank.ts';
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

export type SearchFilters = { sources?: SourceKind[]; maxRisk?: RiskLevel; marketplaces?: string[] };

export type SearchEvent =
  | { type: 'stage'; stage: 'collect' | 'enrich' | 'score'; message: string }
  | { type: 'candidates'; items: ResultItem[] }
  | { type: 'warning'; source: string; message: string }
  | {
      type: 'results';
      items: ResultItem[];
      hiddenHighRisk: number;
      hiddenNoDescription: number;
      hiddenLowStars?: number;
      minStars?: number;
      /** Repositories named like a one-word query, shown above the skills. */
      repos?: RepoResult[];
    }
  | { type: 'done'; cached: boolean; elapsedMs: number };

export type SearchDeps = {
  ctx: AppContext;
  skillsSh(query: string): Promise<SkillsShHit[]>;
};

type Pending =
  | { type: 'plugin'; plugin: PluginRow }
  | { type: 'skillssh'; hit: SkillsShHit }
  | { type: 'github'; repo: string; path: string };

type Candidate = {
  key: string;
  skill: SkillRow | null;
  sources: SourceRef[];
  installs: number | null;
  bm25: number | null;
  /** Best position score (0..1) per source. */
  pos: Partial<Record<SourceKind, number>>;
  pending: Pending | null;
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
/** Results that missed some candidates are cached briefly; those candidates finish indexing in the background. */
const PARTIAL_CACHE_MS = 60 * 1000;

/**
 * found: resolved to an installable skill. missing: the repo has no installable SKILL.md for it (examples,
 * templates, renamed or removed skills) — retrying will not change that. error: GitHub could not be read.
 * timeout: still running at the deadline; it keeps going in the background and is indexed for next time.
 */
type Outcome = 'found' | 'missing' | 'error' | 'timeout';

const STOPWORDS = new Set(
  'a an the and or for to of in on with from by using use uses skill skills claude code tool tools that this is are be my your how what into as at it its via any can will should'.split(' '),
);

/** OR-query of distinct tokens for FTS5 (each token quoted, so no FTS syntax leaks through). */
export function ftsQuery(texts: string[]): string | null {
  const tokens = new Set<string>();
  for (const t of texts) {
    const lower = t.toLowerCase();
    for (const m of lower.matchAll(/[\p{L}\p{N}]+/gu)) if (m[0].length >= 2 && !STOPWORDS.has(m[0])) tokens.add(m[0]);
    // ASCII runs inside mixed Korean words ("pdf에서" → "pdf")
    for (const m of lower.matchAll(/[a-z0-9]+/g)) if (m[0].length >= 2 && !STOPWORDS.has(m[0])) tokens.add(m[0]);
  }
  const list = [...tokens].slice(0, 24);
  return list.length ? list.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ') : null;
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
function relevance(c: Candidate, bestBm25: number, worstBm25: number, query: string): number {
  const parts: number[] = [];
  if (c.bm25 != null) parts.push(bm25ToRelevance(c.bm25, bestBm25, worstBm25));
  if (c.pos.marketplace != null && c.bm25 == null) parts.push(0.8 * c.pos.marketplace);
  if (c.pos.skillssh != null) parts.push(0.8 * c.pos.skillssh); // fuzzy engine: rank alone is not enough
  if (c.pos.github != null) parts.push(0.5 * c.pos.github);
  const base = parts.length ? Math.max(...parts) : 0;
  const s = c.skill!;
  return blendRelevance(base, lexicalMatch(query, s.name, [s.description ?? '', s.when_to_use ?? ''].join(' ')));
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
  const sources = new Set<SourceKind>(filters.sources?.length ? filters.sources : ['marketplace', 'skillssh', 'github']);
  const maxRisk: RiskLevel = filters.maxRisk ?? 'medium';
  // `r` is the result-item shape; bump it when items gain fields so cached searches are rebuilt.
  const key = cacheKey(query, filters, { w: settings.weights, t: !!ctx.config.githubToken, s: settings.minStars, r: 9 });

  const cached = store.getCached(key, DAY_MS) as CachedSearch | undefined;
  const fresh = cached && !(cached.ttlMs && cached.cachedAt && Date.now() - cached.cachedAt > cached.ttlMs);
  if (cached && fresh) {
    for (const w of cached.warnings) emit(w);
    emit(cached.results);
    emit({ type: 'done', cached: true, elapsedMs: Date.now() - t0 });
    return;
  }

  const warnings: CachedSearch['warnings'] = [];
  const warn = (source: string, message: string) => {
    const w = { type: 'warning' as const, source, message };
    warnings.push(w);
    emit(w);
  };
  const timings = { collect: 0, enrich: 0, local: 0, skillssh: 0, github: 0, stars: 0 };
  /** Slowest candidate resolutions, for the log line. */
  const slow: Array<{ what: string; ms: number; outcome: Outcome }> = [];
  const timed = async <T,>(key: 'local' | 'skillssh' | 'github', fn: () => Promise<T>) => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings[key] = Date.now() - t;
    }
  };

  if (/\p{Script=Hangul}/u.test(query)) {
    warn('query', '스킬 설명이 대부분 영어라 한국어 검색어는 결과가 적거나 부정확합니다. 영어로 검색해 보세요 (예: extract tables from pdf).');
  }

  // 1. collect
  emit({ type: 'stage', stage: 'collect', message: '마켓플레이스·skills.sh·GitHub에서 후보를 모으는 중' });
  const match = ftsQuery([query]);
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

  // Lookups for candidates that are not in the local index start as soon as their source answers, so
  // skills.sh hits are being resolved while the (slower) GitHub code search is still running.
  const late: Candidate[] = [];
  const outcomes: Record<Outcome, number> = { found: 0, missing: 0, error: 0, timeout: 0 };
  const deadline = t0 + SEARCH_DEADLINE_MS;
  const slots = new Semaphore(ENRICH_CONCURRENCY);
  const started = new Set<Candidate>();
  const lookups: Promise<void>[] = [];
  const errors: string[] = [];

  const resolveCandidate = async (c: Candidate): Promise<Outcome> => {
    const p = c.pending!;
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
      if (skills.length === 0) return 'missing';
      if (p.type === 'plugin') {
        const plugin = store.getPlugin(p.plugin.id) ?? p.plugin;
        for (const s of skills) late.push({ ...blank(s.id, s), sources: [marketplaceSource(s, plugin)], pos: { ...c.pos } });
      } else {
        late.push({ ...c, key: skills[0].id, skill: skills[0], pending: null });
      }
      return 'found';
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg === 'timeout') return 'timeout';
      // A deleted or renamed repo is gone for good, not a hiccup.
      if (err instanceof PluginUnavailableError || /저장소를 찾을 수 없습니다|tree 40[49]|tree 422/.test(msg)) return 'missing';
      errors.push(msg.slice(0, 100));
      return 'error';
    }
  };

  const startLookup = (c: Candidate) => {
    if (!c.pending || started.has(c)) return;
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
  const addRepoNameSkills = () => {
    if (!word) return;
    for (const s of store.findSkillsByRepoName(word)) {
      const c = upsert(s.id, () => blank(s.id, s));
      const plugin = lookup.plugin(s.plugin_id);
      const source = plugin ? marketplaceSource(s, plugin) : githubSource(s);
      if (source) c.sources = mergeSources(c.sources, [source]);
      c.pos.marketplace = 1;
    }
  };
  const collectRepos = async () => {
    if (!word) return;
    try {
      // repository search can filter by stars and returns description and topics for the repo card
      const hits = await withTimeout(github.searchRepos(`${word} in:name stars:>=${Math.max(1, settings.minStars)}`, 30), 6000, 'timeout');
      for (const r of hits) if (r.repo.split('/')[1]?.toLowerCase() === word) repoInfo.set(r.repo, r);
    } catch {
      // GitHub search unavailable: repos already in the local index still count
    }
    for (const s of store.findSkillsByRepoName(word)) {
      if (s.repo && ![...repoInfo.keys()].some((k) => k.toLowerCase() === s.repo!.toLowerCase())) {
        repoInfo.set(s.repo, { stars: store.getRepo(s.repo)?.stars ?? null, description: null, topics: [] });
      }
    }
    // Found on GitHub but never indexed: read its skills now (a slow repo keeps indexing in the background).
    const unindexed = [...repoInfo.keys()].slice(0, 3).filter((r) => store.findSkillsByRepo(r).length === 0);
    await Promise.all(unindexed.map((r) => withTimeout(indexer.indexRepo(r), 8000, 'timeout').catch(() => 0)));
    addRepoNameSkills();
  };

  const collectLocal = async () => {
    if (!sources.has('marketplace') || !match) return;
    // Marketplace skills plus skills indexed straight from GitHub repos (popular-repo collection, earlier lookups).
    const hits = store.searchSkillsFts(match, 120, filters.marketplaces).filter((h) => h.skill.origin !== 'wellknown');
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
    pluginHits.forEach((h, i) => {
      const score = 0.9 * posScore(i, pluginHits.length);
      if (h.plugin.skills_indexed_at) {
        let skills = store.searchSkillsInPlugin(match, h.plugin.id, 3).map((x) => x.skill);
        if (skills.length === 0) skills = store.listSkillsByPlugin(h.plugin.id).slice(0, 2);
        for (const s of skills) {
          const c = upsert(s.id, () => blank(s.id, s));
          c.sources = mergeSources(c.sources, [marketplaceSource(s, h.plugin)]);
          c.pos.marketplace = Math.max(c.pos.marketplace ?? 0, score);
        }
      } else if (h.plugin.repo) {
        const c = upsert(`pl:${h.plugin.id}`, () => blank(`pl:${h.plugin.id}`, null, { type: 'plugin', plugin: h.plugin }));
        c.pos.marketplace = Math.max(c.pos.marketplace ?? 0, score);
        startLookup(c);
      }
    });
  };

  const collectSkillsSh = async () => {
    if (!sources.has('skillssh')) return;
    let hits: SkillsShHit[];
    try {
      hits = await withTimeout(deps.skillsSh(query), 6000, 'timeout');
    } catch (err) {
      warn('skillssh', `skills.sh 검색 실패 (${shortErr(err)})`);
      return;
    }
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
    });
  };

  const collectGithub = async () => {
    if (!sources.has('github')) return;
    if (!github.hasToken) {
      warn('github', 'GitHub 토큰이 없어 GitHub 코드 검색을 건너뜁니다 (설정에서 토큰을 넣으면 사용됩니다)');
      return;
    }
    try {
      const items = await withTimeout(github.searchSkillFiles(queryKeywords(query)), 10_000, 'timeout');
      items.forEach((it, i) => {
        const dir = it.path === 'SKILL.md' ? '' : it.path.replace(/\/SKILL\.md$/, '');
        const k = skillId(it.repo, dir);
        const local = store.getSkill(k) ?? null;
        const c = upsert(k, () => blank(k, local, local ? null : { type: 'github', repo: it.repo, path: it.path }));
        const url = it.htmlUrl.startsWith('https://github.com/') ? it.htmlUrl : `https://github.com/${it.repo}`;
        c.sources = mergeSources(c.sources, [{ kind: 'github', label: 'GitHub', url }]);
        c.pos.github = Math.max(c.pos.github ?? 0, 0.8 * posScore(i, items.length));
        if (i < GITHUB_EARLY_LOOKUPS) startLookup(c);
      });
    } catch (err) {
      warn('github', `GitHub 검색 실패 (${shortErr(err)})`);
    }
  };

  await Promise.all([timed('local', collectLocal), timed('skillssh', collectSkillsSh), timed('github', collectGithub), collectRepos()]);
  timings.collect = Date.now() - t0;

  const ranked = () => [...cands.values()].sort((a, b) => prelim(b) - prelim(a));
  const provisional = ranked()
    .filter((c) => c.skill?.description)
    .slice(0, MAX_RESULTS)
    .map((c) => toItem(c, lookup, { R: Math.min(1, prelim(c)), P: 0, F: freshness(c.skill!.last_commit_at), T: trust(c.skill!, lookup) }, settings.weights));
  emit({ type: 'candidates', items: provisional });

  // 2. enrich: wait for the lookups (already running), plus any top candidate not started yet
  emit({ type: 'stage', stage: 'enrich', message: '상위 후보의 SKILL.md와 저장소 정보를 확인하는 중' });
  const top = ranked().slice(0, MAX_ENRICH);
  const ready = top.filter((c) => !c.pending);
  // Star counts for the already-indexed candidates load while the lookups run.
  const readyRepos = [...new Set(ready.map((c) => c.skill!.repo).filter((r): r is string => !!r))];
  void pool(readyRepos.slice(0, 15), 6, (r) => github.getRepoMeta(r).catch(() => null));
  for (const c of top) startLookup(c);
  const settled = Promise.all(lookups);
  // Most lookups finish within a second or two, but a giant mirror repo (tree too big for the API, so a
  // git fetch) takes 5–7s. Show the finished results after a short wait and fold stragglers in when done.
  const allDone = await Promise.race([settled.then(() => true), sleep(INTERIM_WAIT_MS).then(() => false)]);
  if (!allDone) emit(await buildResults([...late], false));
  await settled;
  if (outcomes.timeout > 0) {
    warn('enrich', `${outcomes.timeout}개 후보는 GitHub 응답이 늦어 이번 결과에서 빠졌습니다. 확인은 계속 진행되니 잠시 뒤 다시 검색하면 포함됩니다.`);
  }
  if (outcomes.error > 0) warn('enrich-skip', `GitHub에서 읽지 못한 후보 ${outcomes.error}개는 뺐습니다.`);
  if (outcomes.missing > 0) {
    warn('enrich-skip', `설치할 수 있는 SKILL.md가 없는 후보 ${outcomes.missing}개는 뺐습니다 (예제·템플릿이거나 이름이 바뀐 스킬).`);
  }

  timings.enrich = Date.now() - t0 - timings.collect;

  // 3. score
  emit({ type: 'stage', stage: 'score', message: '점수를 계산하는 중' });
  const results = await buildResults(late, true);
  emit(results);
  if (results.items.length > 0) {
    const partial = outcomes.timeout + outcomes.error > 0;
    store.putCached(key, { warnings, results, cachedAt: Date.now(), ...(partial ? { ttlMs: PARTIAL_CACHE_MS } : {}) } satisfies CachedSearch);
  }
  const elapsedMs = Date.now() - t0;
  const slowest = slow
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 4)
    .map((s) => `${s.what} ${s.ms}ms${s.outcome === 'found' ? '' : ` (${s.outcome})`}`);
  console.log(
    `[search] ${elapsedMs}ms ${JSON.stringify(timings)} lookups=${JSON.stringify(outcomes)} results=${results.items.length}${allDone ? '' : ' (interim sent)'} q=${JSON.stringify(query)}` +
      (slowest.length ? `\n  slowest: ${slowest.join(' | ')}` : '') +
      (errors.length ? `\n  errors: ${errors.slice(0, 3).join(' | ')}` : ''),
  );
  emit({ type: 'done', cached: false, elapsedMs });

  /** Scores the indexed candidates plus the resolved ones; `final` also refreshes star counts from GitHub. */
  async function buildResults(resolved: Candidate[], final: boolean): Promise<Extract<SearchEvent, { type: 'results' }>> {
    const merged = mergeById([...ready, ...resolved]);
    for (const c of merged) {
      if (c.installs != null && c.installs > 0 && c.skill) store.setSkillInstalls(c.skill.id, c.installs);
      if (c.installs == null && c.skill?.installs) c.installs = c.skill.installs;
    }
    const deduped = dedupeByContent(merged, lookup).sort((a, b) => prelim(b) - prelim(a));

    // Stars for every candidate repo (cached 24h; the minimum-stars filter needs them all). Interim results
    // use what is cached.
    const repos = [...new Set(deduped.map((c) => c.skill!.repo).filter((r): r is string => !!r))];
    const stars = new Map<string, number | null>();
    const tStars = Date.now();
    if (final) {
      await pool(repos, 8, async (r) => {
        const meta = await github.getRepoMeta(r).catch(() => null);
        stars.set(r.toLowerCase(), meta?.stars ?? null);
      });
      timings.stars = Date.now() - tStars;
    }
    for (const r of repos) if (!stars.has(r.toLowerCase())) stars.set(r.toLowerCase(), store.getRepo(r)?.stars ?? null);
    const starsOf = (c: Candidate) => (c.skill!.repo ? (stars.get(c.skill!.repo.toLowerCase()) ?? null) : null);

    // Minimum GitHub stars (user setting, default 5,000). An unknown count does not pass: it may be below.
    let hiddenLowStars = 0;
    const finalists = deduped
      .filter((c) => {
        if (settings.minStars <= 0) return true;
        const st = starsOf(c);
        if (st != null && st >= settings.minStars) return true;
        if (c.skill!.description) hiddenLowStars++;
        return false;
      })
      .slice(0, MAX_ENRICH);

    const bm = finalists.map((c) => c.bm25).filter((b): b is number => b != null);
    const best = bm.length ? Math.min(...bm) : 0;
    const worst = bm.length ? Math.max(...bm) : 0;
    const maxInstalls = Math.max(0, ...finalists.map((c) => c.installs ?? 0));
    const maxStars = Math.max(0, ...finalists.map((c) => stars.get(c.skill!.repo?.toLowerCase() ?? '') ?? 0));
    let hiddenHighRisk = 0;
    let hiddenNoDescription = 0;
    const items: ResultItem[] = [];
    for (const c of finalists) {
      const s = c.skill!;
      // Name-only hits (well-known sources without a description) can't be judged or read.
      if (!s.description) {
        hiddenNoDescription++;
        continue;
      }
      if (RISK_ORDER[(s.risk_level as RiskLevel) ?? 'low'] > RISK_ORDER[maxRisk]) {
        hiddenHighRisk++;
        continue;
      }
      const st = s.repo ? (stars.get(s.repo.toLowerCase()) ?? null) : null;
      const breakdown: Breakdown = {
        R: relevance(c, best, worst, query),
        P: popularity({ installs: c.installs, stars: st }, maxInstalls, maxStars),
        F: freshness(s.last_commit_at),
        T: trust(s, lookup),
      };
      items.push(toItem(c, lookup, breakdown, settings.weights, st));
    }
    items.sort(byNameThenPopularity(query));
    const repoCards: RepoResult[] = [...repoInfo]
      .filter(([, i]) => settings.minStars <= 0 || (i.stars ?? 0) >= settings.minStars)
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
          .filter((s) => s.description && s.origin !== 'wellknown')
          .slice(0, 30)
          .map((s) => ({ id: s.id, name: s.name })),
      }))
      // a skill finder: a same-named repo without skills (facebook/react for "react") is not a result
      .filter((r) => r.skills.length > 0);
    return { type: 'results' as const, items: items.slice(0, MAX_RESULTS), hiddenHighRisk, hiddenNoDescription, hiddenLowStars, minStars: settings.minStars, repos: repoCards };
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
 * Typing a skill's or repo's exact name is a lookup: skills named `q` or `q-…`, or from a repo named `q`, come
 * first (most popular first among them). Everything else keeps the popularity order. Ids are `gh:owner/repo:dir`.
 */
export function nameMatches(item: Pick<ResultItem, 'id' | 'name'>, word: string): boolean {
  const name = item.name.toLowerCase();
  const repo = item.id.match(/^gh:[^/]+\/([^:]+):/)?.[1];
  return name === word || name.startsWith(`${word}-`) || repo === word;
}

export function byNameThenPopularity(query: string): (a: ResultItem, b: ResultItem) => number {
  const word = navigationalWord(query);
  if (!word) return byPopularity;
  return (a, b) => Number(nameMatches(b, word)) - Number(nameMatches(a, word)) || byPopularity(a, b);
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

/** Same SKILL.md (or same name+description) published in several places → one result, sources and installs combined. */
function dedupeByContent(cands: Candidate[], lookup: Lookup): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  const out: Candidate[] = [];
  for (const c of cands) {
    const s = c.skill!;
    const k = s.skill_md_sha256 ? `md:${s.skill_md_sha256}` : null;
    const k2 = s.name_desc_sha256 ? `nd:${s.name_desc_sha256}` : null;
    const existing = (k && groups.get(k)) || (k2 && groups.get(k2));
    if (existing) existing.push(c);
    else {
      const g = [c];
      if (k) groups.set(k, g);
      if (k2) groups.set(k2, g);
      out.push(c);
    }
  }
  const seen = new Set<Candidate[]>();
  const merged: Candidate[] = [];
  for (const c of out) {
    const s = c.skill!;
    const g = (s.skill_md_sha256 && groups.get(`md:${s.skill_md_sha256}`)) || (s.name_desc_sha256 && groups.get(`nd:${s.name_desc_sha256}`)) || [c];
    if (seen.has(g)) continue;
    seen.add(g);
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
    merged.push(combined);
  }
  return merged;
}

function toItem(c: Candidate, lookup: Lookup, breakdown: Breakdown, weights: Breakdown, stars: number | null = null): ResultItem {
  return buildResultItem({
    skill: c.skill!,
    lookup,
    sources: c.sources.length ? c.sources : [githubSource(c.skill!) ?? { kind: 'github', label: 'GitHub', url: '' }],
    installs: c.installs,
    stars,
    breakdown,
    score: totalScore(breakdown, weights),
  });
}

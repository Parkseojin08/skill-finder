import { createHash } from 'node:crypto';
import { RISK_ORDER, type RiskLevel } from '../analyze/risk.ts';
import type { AppContext } from '../context.ts';
import type { PluginRow, SkillRow } from '../db/store.ts';
import { basename } from '../discovery/tree.ts';
import { normalizeSkillName, skillId } from '../indexer.ts';
import { getSettings } from '../settings.ts';
import { classifySkillsShSource, type SkillsShHit } from '../sources/skillsSh.ts';
import { pool, withTimeout } from '../util/limiter.ts';
import { blendRelevance, bm25ToRelevance, freshness, lexicalMatch, popularity, totalScore, TRUST_SCORE, trustTier, type Breakdown } from './rank.ts';
import {
  buildResultItem,
  githubSource,
  marketplaceSource,
  mergeSources,
  storeLookup,
  type Lookup,
  type ResultItem,
  type SourceKind,
  type SourceRef,
} from './result.ts';

export type SearchFilters = { sources?: SourceKind[]; maxRisk?: RiskLevel; marketplaces?: string[] };

export type SearchEvent =
  | { type: 'stage'; stage: 'collect' | 'enrich' | 'score'; message: string }
  | { type: 'candidates'; items: ResultItem[] }
  | { type: 'warning'; source: string; message: string }
  | { type: 'results'; items: ResultItem[]; hiddenHighRisk: number; hiddenNoDescription: number }
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
const ENRICH_DEADLINE_MS = 15_000;
const ENRICH_CONCURRENCY = 16;
/** Results that missed some candidates are cached briefly; those candidates finish indexing in the background. */
const PARTIAL_CACHE_MS = 60 * 1000;

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
  const key = cacheKey(query, filters, { w: settings.weights, t: !!ctx.config.githubToken });

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
  const timings = { collect: 0, enrich: 0 };

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

  const collectLocal = async () => {
    if (!sources.has('marketplace') || !match) return;
    const hits = store.searchSkillsFts(match, 80, filters.marketplaces).filter((h) => h.skill.origin === 'plugin');
    hits.forEach((h, i) => {
      const c = upsert(h.skill.id, () => blank(h.skill.id, h.skill));
      const plugin = lookup.plugin(h.skill.plugin_id);
      if (plugin) c.sources = mergeSources(c.sources, [marketplaceSource(h.skill, plugin)]);
      c.bm25 = c.bm25 == null ? h.bm25 : Math.min(c.bm25, h.bm25);
      c.pos.marketplace = Math.max(c.pos.marketplace ?? 0, posScore(i, hits.length));
    });
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
      });
    } catch (err) {
      warn('github', `GitHub 검색 실패 (${shortErr(err)})`);
    }
  };

  await Promise.all([collectLocal(), collectSkillsSh(), collectGithub()]);
  timings.collect = Date.now() - t0;

  const ranked = () => [...cands.values()].sort((a, b) => prelim(b) - prelim(a));
  const provisional = ranked()
    .filter((c) => c.skill?.description)
    .slice(0, MAX_RESULTS)
    .map((c) => toItem(c, lookup, { R: Math.min(1, prelim(c)), P: 0, F: freshness(c.skill!.last_commit_at), T: trust(c.skill!, lookup) }, settings.weights));
  emit({ type: 'candidates', items: provisional });

  // 2. enrich: candidates not in the local index yet (skills.sh / GitHub / lazily indexed plugins)
  emit({ type: 'stage', stage: 'enrich', message: '상위 후보의 SKILL.md와 저장소 정보를 확인하는 중' });
  const top = ranked().slice(0, MAX_ENRICH);
  const ready = top.filter((c) => !c.pending);
  const late: Candidate[] = [];
  const deadline = Date.now() + ENRICH_DEADLINE_MS;
  let unresolved = 0;
  await pool(
    top.filter((c) => c.pending),
    ENRICH_CONCURRENCY,
    async (c) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        unresolved++;
        return;
      }
      try {
        const p = c.pending!;
        if (p.type === 'plugin') {
          await withTimeout(indexer.indexPlugin(p.plugin.id), remaining, 'timeout');
          let skills = match ? store.searchSkillsInPlugin(match, p.plugin.id, 3).map((x) => x.skill) : [];
          if (skills.length === 0) skills = store.listSkillsByPlugin(p.plugin.id).slice(0, 2);
          const plugin = store.getPlugin(p.plugin.id) ?? p.plugin;
          for (const s of skills) late.push({ ...blank(s.id, s), sources: [marketplaceSource(s, plugin)], pos: { ...c.pos } });
          if (skills.length === 0) unresolved++;
          return;
        }
        let skill: SkillRow | null = null;
        if (p.type === 'skillssh') {
          const src = classifySkillsShSource(p.hit.source);
          if (src?.kind === 'github') skill = await withTimeout(indexer.findInRepo(src.repo, p.hit.name, p.hit.skillId), remaining, 'timeout');
          else if (src?.kind === 'domain') skill = indexer.wellKnownRow(src.domain, p.hit.name, p.hit.installs);
        } else {
          skill = await withTimeout(indexer.findByPath(p.repo, p.path), remaining, 'timeout');
        }
        if (!skill) {
          unresolved++;
          return;
        }
        late.push({ ...c, key: skill.id, skill, pending: null });
      } catch {
        unresolved++;
      }
    },
  );
  if (unresolved > 0) warn('enrich', `${unresolved}개 후보는 아직 확인 중이라 이번 결과에서 빠졌습니다. 1분쯤 뒤 다시 검색하면 포함됩니다.`);

  const merged = mergeById([...ready, ...late]);
  for (const c of merged) {
    if (c.installs != null && c.installs > 0 && c.skill) store.setSkillInstalls(c.skill.id, c.installs);
    if (c.installs == null && c.skill?.installs) c.installs = c.skill.installs;
  }
  const finalists = dedupeByContent(merged, lookup)
    .sort((a, b) => prelim(b) - prelim(a))
    .slice(0, MAX_ENRICH);

  // stars (cached 24h; skipped when the quota is short)
  const repos = [...new Set(finalists.map((c) => c.skill!.repo).filter((r): r is string => !!r))];
  const stars = new Map<string, number | null>();
  await pool(repos.slice(0, 15), 6, async (r) => {
    const meta = await github.getRepoMeta(r).catch(() => null);
    stars.set(r.toLowerCase(), meta?.stars ?? null);
  });
  for (const r of repos.slice(15)) stars.set(r.toLowerCase(), store.getRepo(r)?.stars ?? null);
  timings.enrich = Date.now() - t0 - timings.collect;

  // 3. score
  emit({ type: 'stage', stage: 'score', message: '점수를 계산하는 중' });
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
  items.sort((a, b) => b.score - a.score);
  const results = { type: 'results' as const, items: items.slice(0, MAX_RESULTS), hiddenHighRisk, hiddenNoDescription };
  emit(results);
  if (results.items.length > 0) {
    store.putCached(key, { warnings, results, cachedAt: Date.now(), ...(unresolved > 0 ? { ttlMs: PARTIAL_CACHE_MS } : {}) } satisfies CachedSearch);
  }
  const elapsedMs = Date.now() - t0;
  console.log(`[search] ${elapsedMs}ms ${JSON.stringify(timings)} results=${results.items.length} q=${JSON.stringify(query)}`);
  emit({ type: 'done', cached: false, elapsedMs });
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

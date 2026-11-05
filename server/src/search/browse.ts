import { RISK_ORDER, type RiskLevel } from '../analyze/risk.ts';
import type { AppContext } from '../context.ts';
import type { SkillRow, Store } from '../db/store.ts';
import { getSettings } from '../settings.ts';
import { CATEGORIES, categorize, type Category } from './category.ts';
import { indexGeneration } from './indexGeneration.ts';
import { installsSuspect, type InstallsSuspect } from './installsSuspect.ts';
import { freshInstalls, freshness, TRUST_SCORE, trustTier, type TrustTier } from './rank.ts';
import { buildResultItem, githubSource, marketplaceSource, storeLookup, type ResultItem } from './result.ts';

/**
 * Browsing the local index without a query (F17, feature review 2026-11-04; user decision 1: the search page's
 * first screen, not a new tab): categories, sources, Anthropic's own collection, skills new this week and plugins
 * that install as one bundle. Same rules as a search's results: a description, not a well-known site's name-only
 * entry, the star minimum (official and partner skills exempt, an unknown count hidden), the risk limit, one card per
 * SKILL.md, downloads → stars order with a suspected download count taken as unknown (F18). Nothing goes to the
 * network: star counts are the stored ones, whatever their age (a search would ask GitHub again).
 *
 * Categories are not stored (D#4c1f keeps them rule-based and recomputed); they are computed for the whole index
 * once per index generation and kept in memory with the rest of what browsing filters on.
 */

export const BROWSE_PAGE_SIZE = 50;
/** "이번 주 새로 들어온": first seen by this app within this many days. */
export const NEW_DAYS = 7;
/** The setting holding when first_seen_at started being filled (the first run of runFirstSeenFill). */
export const FIRST_SEEN_SINCE_KEY = 'firstSeenTrackedSince';
/**
 * Skills first seen within this long of tracking's start are not "new": they are the first index (a new install's
 * seed and first sync, filled in one go) or rows migrated with their last fetch time, not skills that just appeared.
 */
const FIRST_SEEN_GRACE_MS = 24 * 60 * 60 * 1000;
/** The in-memory index is rebuilt after this long even within one generation (downloads and stars change without one). */
const INDEX_MAX_AGE_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Anthropic's Agent Skills collection (the anthropic-agent-skills marketplace). */
const ANTHROPIC_COLLECTION = 'anthropics/skills';

export type BrowseSection = 'overview' | 'list' | 'anthropic' | 'new' | 'plugins';
export const BROWSE_TRUST = ['official', 'partner', 'community'] as const;
export type BrowseTrust = (typeof BROWSE_TRUST)[number];

export type BrowseQuery = {
  section: BrowseSection;
  cat?: Category;
  trust?: BrowseTrust;
  marketplace?: string;
  /** `owner/repo` (any case). */
  repo?: string;
  owner?: string;
  page?: number;
  maxRisk?: RiskLevel;
  /** Overrides the star-minimum setting (0: none), as a search's "별 기준 없이 다시 찾기". */
  minStars?: number;
};

type Entry = {
  id: string;
  name: string;
  repo: string | null;
  repoLower: string | null;
  owner: string | null;
  pluginId: string | null;
  marketplace: string | null;
  tier: TrustTier;
  risk: RiskLevel;
  /** Trusted downloads (fresh, not suspected), else null. */
  installs: number | null;
  suspect: InstallsSuspect | null;
  stars: number | null;
  mdSha: string | null;
  isPlugin: boolean;
  firstSeen: number | null;
  categories: Category[];
};

/** One card: the representative copy of a SKILL.md, with the trusted downloads of all its visible copies. */
type Card = { rep: Entry; installs: number | null; suspect: InstallsSuspect | null; copies: Entry[] };

type Index = { gen: number; at: number; entries: Entry[]; pluginSize: Map<string, number>; visible: Map<string, { cards: Card[]; hidden: Hidden }> };
/** Left out under the limits, one entry per SKILL.md not shown through another copy: counted per view. */
type Hidden = { risky: Entry[]; low: Entry[]; unknown: Entry[] };

const indexes = new WeakMap<Store, Index>();

type Row = Pick<SkillRow, 'id' | 'name' | 'repo' | 'dir_path' | 'plugin_id' | 'origin' | 'description' | 'when_to_use' | 'risk_level' | 'installs' | 'installs_at' | 'skill_md_sha256' | 'name_desc_sha256'> & {
  first_seen_at: string | null;
  mp: string | null;
  mp_category: string | null;
  stars: number | null;
};

/**
 * Categories by skill, kept across rebuilds while the skill's text is the same: computing them for the whole index
 * takes ~0.7 s of the ~1 s a first build costs (20K skills, measured 2026-11-05); a rebuild after a sync redoes
 * only the skills it changed.
 */
const categoryMemo = new WeakMap<Store, Map<string, { sig: string; cats: Category[] }>>();
function categoriesOf(store: Store, r: Row): Category[] {
  let memo = categoryMemo.get(store);
  if (!memo) categoryMemo.set(store, (memo = new Map()));
  const sig = `${r.skill_md_sha256 ?? ''}|${r.name_desc_sha256 ?? ''}|${r.mp_category ?? ''}`;
  const hit = memo.get(r.id);
  if (hit && hit.sig === sig && r.skill_md_sha256) return hit.cats;
  const cats = categorize({ name: r.name, description: r.description, whenToUse: r.when_to_use, marketplaceCategory: r.mp_category });
  memo.set(r.id, { sig, cats });
  return cats;
}

function buildIndex(store: Store, now: number): Index {
  const rows = store.db
    .prepare(
      `SELECT s.id, s.name, s.repo, s.dir_path, s.plugin_id, s.origin, s.description, s.when_to_use, s.risk_level, s.installs,
         s.installs_at, s.skill_md_sha256, s.name_desc_sha256, s.first_seen_at, p.marketplace AS mp, p.category AS mp_category, r.stars AS stars
       FROM skills s
       LEFT JOIN plugins p ON p.id = s.plugin_id
       LEFT JOIN repos r ON r.full_name = s.repo COLLATE NOCASE
       WHERE s.origin != 'wellknown' AND s.description IS NOT NULL AND s.description != ''`,
    )
    .all() as Row[];
  const entries: Entry[] = [];
  const pluginSize = new Map<string, number>();
  for (const r of rows) {
    const plugin = r.mp ? { marketplace: r.mp } : null;
    const tier = trustTier(r, plugin);
    const fresh = freshInstalls(r, now);
    const suspect = installsSuspect(store, {
      repo: r.repo,
      name: r.name,
      nameDesc: r.name_desc_sha256,
      origin: r.origin,
      installs: fresh,
      stars: r.stars,
      exempt: tier === 'official' || tier === 'partner',
    });
    const first = r.first_seen_at ? Date.parse(r.first_seen_at) : NaN;
    if (r.plugin_id) pluginSize.set(r.plugin_id, (pluginSize.get(r.plugin_id) ?? 0) + 1);
    entries.push({
      id: r.id,
      name: r.name,
      repo: r.repo,
      repoLower: r.repo?.toLowerCase() ?? null,
      owner: r.repo?.split('/')[0]?.toLowerCase() ?? null,
      pluginId: r.plugin_id,
      marketplace: r.mp,
      tier,
      risk: (r.risk_level as RiskLevel) ?? 'low',
      installs: suspect ? null : fresh,
      suspect,
      stars: r.stars,
      mdSha: r.skill_md_sha256,
      isPlugin: r.origin === 'plugin',
      firstSeen: Number.isNaN(first) ? null : first,
      categories: categoriesOf(store, r),
    });
  }
  return { gen: indexGeneration(store), at: now, entries, pluginSize, visible: new Map() };
}

function indexOf(store: Store, now = Date.now()): Index {
  const gen = indexGeneration(store);
  const hit = indexes.get(store);
  if (hit && hit.gen === gen && now - hit.at < INDEX_MAX_AGE_MS) return hit;
  const built = buildIndex(store, now);
  indexes.set(store, built);
  return built;
}

/** Drops the in-memory index (first_seen_at filled, tests). */
export function clearBrowseCache(store: Store): void {
  indexes.delete(store);
}

const byPopularity = (a: { installs: number | null; stars: number | null }, b: { installs: number | null; stars: number | null }) =>
  (b.installs ?? -1) - (a.installs ?? -1) || (b.stars ?? -1) - (a.stars ?? -1);
const byCard = (a: Card, b: Card) =>
  byPopularity({ installs: a.installs, stars: a.rep.stars }, { installs: b.installs, stars: b.rep.stars }) || a.rep.name.localeCompare(b.rep.name) || a.rep.id.localeCompare(b.rep.id);

/**
 * What a search would show of the whole index under these limits: risk and stars first (a hidden high-risk copy
 * does not take its lower-risk copies with it, as in buildResults), then one card per SKILL.md. Kept per limits.
 */
function visibleCards(ix: Index, maxRisk: RiskLevel, minStars: number): { cards: Card[]; hidden: Hidden } {
  const key = `${maxRisk}:${minStars}`;
  const hit = ix.visible.get(key);
  if (hit) return hit;
  const exempt = (e: Entry) => e.tier === 'official' || e.tier === 'partner';
  const starsPass = (e: Entry) => minStars <= 0 || exempt(e) || (e.stars != null && e.stars >= minStars);
  const risky: Array<{ k: string; e: Entry }> = [];
  const low: Array<{ k: string; e: Entry }> = [];
  const unknown: Array<{ k: string; e: Entry }> = [];
  const groups = new Map<string, Entry[]>();
  const order: Entry[][] = [];
  for (const e of ix.entries) {
    const k = e.mdSha ?? `id:${e.id}`;
    if (RISK_ORDER[e.risk] > RISK_ORDER[maxRisk]) {
      if (starsPass(e)) risky.push({ k, e });
      continue;
    }
    if (!starsPass(e)) {
      (e.stars == null ? unknown : low).push({ k, e });
      continue;
    }
    const g = groups.get(k);
    if (g) g.push(e);
    else {
      const list = [e];
      groups.set(k, list);
      order.push(list);
    }
  }
  const cards: Card[] = order.map((g) => {
    // the representative as in search's dedupeByContent: trust, then a marketplace plugin, then downloads
    const rep = g.length === 1 ? g[0] : [...g].sort((a, b) => TRUST_SCORE[b.tier] - TRUST_SCORE[a.tier] || Number(b.isPlugin) - Number(a.isPlugin) || (b.installs ?? 0) - (a.installs ?? 0))[0];
    const known = g.filter((x) => x.installs != null);
    const installs = known.length ? known.reduce((n, x) => n + x.installs!, 0) : null;
    return { rep, installs, suspect: installs == null ? (rep.suspect ?? g.find((x) => x.suspect)?.suspect ?? null) : null, copies: g };
  });
  cards.sort(byCard);
  // a SKILL.md shown under another copy is not counted as hidden; one per SKILL.md otherwise
  const shown = new Set(groups.keys());
  const only = (list: Array<{ k: string; e: Entry }>) => {
    const seen = new Set<string>();
    return list.filter((x) => !shown.has(x.k) && !seen.has(x.k) && (seen.add(x.k), true)).map((x) => x.e);
  };
  const out = { cards, hidden: { risky: only(risky), low: only(low), unknown: only(unknown) } };
  ix.visible.set(key, out);
  return out;
}

/** The time after which a first-seen skill counts as new: a week ago, or a day after tracking began if later. */
export function newSince(store: Store, now = Date.now()): number {
  const since = store.getSetting<string>(FIRST_SEEN_SINCE_KEY);
  const tracked = since ? Date.parse(since) : NaN;
  // before the first fill nothing is known to be new
  if (Number.isNaN(tracked)) return Infinity;
  return Math.max(now - NEW_DAYS * DAY_MS, tracked + FIRST_SEEN_GRACE_MS);
}

function matches(q: BrowseQuery, e: Entry, since: number, pluginSize: Map<string, number>): boolean {
  if (q.cat && !e.categories.includes(q.cat)) return false;
  if (q.trust && e.tier !== q.trust) return false;
  if (q.marketplace && e.marketplace !== q.marketplace) return false;
  if (q.repo && e.repoLower !== q.repo.toLowerCase()) return false;
  if (q.owner && e.owner !== q.owner.toLowerCase()) return false;
  if (q.section === 'anthropic' && e.repoLower !== ANTHROPIC_COLLECTION) return false;
  if (q.section === 'new' && !(e.firstSeen != null && e.firstSeen >= since)) return false;
  if (q.section === 'plugins' && !(e.pluginId && (pluginSize.get(e.pluginId) ?? 0) >= 2)) return false;
  return true;
}

export type BrowseOverview = {
  section: 'overview';
  minStars: number;
  categories: Array<{ key: Category; count: number }>;
  trust: Array<{ key: BrowseTrust; count: number }>;
  marketplaces: Array<{ name: string; count: number }>;
  anthropic: number;
  newThisWeek: number;
  plugins: number;
  total: number;
};

export type BrowseList = {
  section: Exclude<BrowseSection, 'overview'>;
  items: ResultItem[];
  /** Cards matching, over every page. */
  total: number;
  page: number;
  pageSize: number;
  hiddenHighRisk: number;
  hiddenLowStars: number;
  hiddenUnknownStars: number;
  minStars: number;
};

export function browse(store: Store, q: BrowseQuery, now = Date.now()): BrowseOverview | BrowseList {
  const settings = getSettings(store);
  const minStars = q.minStars ?? settings.minStars;
  const maxRisk = q.maxRisk ?? 'medium';
  const ix = indexOf(store, now);
  const { cards, hidden } = visibleCards(ix, maxRisk, minStars);
  const since = newSince(store, now);
  if (q.section === 'overview') {
    const cats = new Map<Category, number>(CATEGORIES.map((c) => [c, 0]));
    const trust = new Map<BrowseTrust, number>(BROWSE_TRUST.map((t) => [t, 0]));
    const mps = new Map<string, number>();
    const plugins = new Set<string>();
    let anthropic = 0;
    let fresh = 0;
    for (const c of cards) {
      const e = c.rep;
      for (const cat of e.categories) cats.set(cat, (cats.get(cat) ?? 0) + 1);
      if (e.tier !== 'other') trust.set(e.tier, (trust.get(e.tier) ?? 0) + 1);
      if (e.marketplace) mps.set(e.marketplace, (mps.get(e.marketplace) ?? 0) + 1);
      if (e.repoLower === ANTHROPIC_COLLECTION) anthropic++;
      if (e.firstSeen != null && e.firstSeen >= since) fresh++;
      if (e.pluginId && (ix.pluginSize.get(e.pluginId) ?? 0) >= 2) plugins.add(e.pluginId);
    }
    return {
      section: 'overview',
      minStars,
      categories: CATEGORIES.map((key) => ({ key, count: cats.get(key) ?? 0 })),
      trust: BROWSE_TRUST.map((key) => ({ key, count: trust.get(key) ?? 0 })),
      marketplaces: [...mps].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      anthropic,
      newThisWeek: fresh,
      plugins: plugins.size,
      total: cards.length,
    };
  }
  let picked = cards.filter((c) => matches(q, c.rep, since, ix.pluginSize));
  if (q.section === 'plugins') {
    // one card per plugin: its most popular skill stands for the bundle (the card says how many skills come along)
    const seen = new Set<string>();
    picked = picked.filter((c) => !seen.has(c.rep.pluginId!) && (seen.add(c.rep.pluginId!), true));
  }
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const slice = picked.slice((page - 1) * BROWSE_PAGE_SIZE, page * BROWSE_PAGE_SIZE);
  const lookup = storeLookup(store);
  const items: ResultItem[] = [];
  for (const c of slice) {
    const skill = store.getSkill(c.rep.id);
    if (!skill) continue; // removed since the index was built
    const plugin = lookup.plugin(skill.plugin_id);
    const own = plugin ? marketplaceSource(skill, plugin) : githubSource(skill);
    const copySources = c.copies.filter((x) => x !== c.rep && x.repo && x.repoLower !== c.rep.repoLower).map((x) => ({ kind: 'github' as const, label: 'GitHub', url: `https://github.com/${x.repo}` }));
    const item = buildResultItem({
      skill,
      lookup,
      sources: [...(own ? [own] : []), ...copySources],
      installs: c.installs,
      stars: c.rep.stars,
      breakdown: { R: 0, P: 0, F: freshness(skill.last_commit_at, now), T: TRUST_SCORE[c.rep.tier] },
      score: 0,
    });
    items.push(c.suspect ? { ...item, installsSuspect: c.suspect } : item);
  }
  const count = (list: Entry[]) => list.filter((e) => matches(q, e, since, ix.pluginSize)).length;
  return {
    section: q.section,
    items,
    total: picked.length,
    page,
    pageSize: BROWSE_PAGE_SIZE,
    hiddenHighRisk: count(hidden.risky),
    hiddenLowStars: count(hidden.low),
    hiddenUnknownStars: count(hidden.unknown),
    minStars,
  };
}

/**
 * Fills skills.first_seen_at for rows written since the last run (the indexer inserts them with NULL; stage-2
 * migration filled older rows with their fetch time). The first run also records when tracking began, so a new
 * install's whole first index does not show as "new this week". For the scheduler: after a sync, and hourly.
 */
export async function runFirstSeenFill(ctx: Pick<AppContext, 'store'>, now = new Date()): Promise<{ counts: Record<string, number> }> {
  const { store } = ctx;
  const at = now.toISOString();
  if (!store.getSetting<string>(FIRST_SEEN_SINCE_KEY)) store.setSetting(FIRST_SEEN_SINCE_KEY, at);
  const filled = Number(store.db.prepare('UPDATE skills SET first_seen_at = ? WHERE first_seen_at IS NULL').run(at).changes);
  if (filled > 0) clearBrowseCache(store);
  return { counts: { filled } };
}

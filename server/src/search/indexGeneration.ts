import { AsyncLocalStorage } from 'node:async_hooks';
import type { Store } from '../db/store.ts';

/**
 * The search index's generation (B1, feature review 2026-11-04): a number in the settings that goes up once per
 * piece of work (a sync, a collection, a risk re-check) that changed what a search can return. Cached searches
 * carry the generation they were made in; one from an older generation is shown first as "이전 결과" and searched
 * again. Before, every sync emptied the search cache whether or not anything had changed, and the sync runs at
 * every start, so the cache was nearly always empty.
 */
export const INDEX_GENERATION_KEY = 'indexGeneration';

export function indexGeneration(store: Store): number {
  const n = store.getSetting<number>(INDEX_GENERATION_KEY);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** In-memory caches built from the index (spelling dictionary, download-count facts) are keyed by it too. */
export function bumpIndexGeneration(store: Store): number {
  const next = indexGeneration(store) + 1;
  store.setSetting(INDEX_GENERATION_KEY, next);
  return next;
}

type Unit = { changed: boolean };
const units = new AsyncLocalStorage<Unit>();
const watched = new WeakSet<Store>();

/** Fields of a skill row that a search result does not show or rank on (rewritten on every read of the repo). */
const SKILL_SKIP = new Set(['fetched_at', 'installs', 'installs_at', 'risk_rules']);

const norm = (v: unknown) => (v === undefined ? null : v);
/** Whether `next` would change any of `prev`'s fields it sets (ignoring `skip`). A missing row is a change. */
function differs(prev: object | undefined, next: object, skip: Set<string> = new Set()): boolean {
  if (!prev) return true;
  const p = prev as Record<string, unknown>;
  return Object.entries(next).some(([k, v]) => !skip.has(k) && norm(p[k]) !== norm(v));
}

/**
 * Wraps the store's writers that change what a search returns (skills, plugins, marketplaces) so that work run
 * through {@link trackIndexChanges} knows whether it changed anything: a write of the same values (a plugin read
 * again at the same commit) is not a change. Writes outside such work (a search indexing a repo it found) are
 * not counted, as before (they were never cleared for). Idempotent per store.
 */
export function watchIndexWrites(store: Store): void {
  if (watched.has(store)) return;
  watched.add(store);
  const unit = () => {
    const u = units.getStore();
    return u && !u.changed ? u : null;
  };
  const upsertSkill = store.upsertSkill.bind(store);
  store.upsertSkill = (s, pluginText) => {
    const u = unit();
    if (u && differs(store.getSkill(s.id), s, SKILL_SKIP)) u.changed = true;
    upsertSkill(s, pluginText);
  };
  const deleteSkill = store.deleteSkill.bind(store);
  store.deleteSkill = (id) => {
    const u = unit();
    if (u && store.getSkill(id)) u.changed = true;
    deleteSkill(id);
  };
  const upsertPlugin = store.upsertPlugin.bind(store);
  store.upsertPlugin = (p) => {
    const u = unit();
    if (u && differs(store.getPlugin(p.id), p)) u.changed = true;
    upsertPlugin(p);
  };
  const deletePlugin = store.deletePlugin.bind(store);
  store.deletePlugin = (id) => {
    const u = unit();
    if (u && store.getPlugin(id)) u.changed = true;
    deletePlugin(id);
  };
  const upsertMarketplace = store.upsertMarketplace.bind(store);
  store.upsertMarketplace = (m) => {
    const u = unit();
    const prev = store.getMarketplace(m.name);
    if (u && (!prev || prev.repo !== m.repo || prev.enabled !== (m.enabled ? 1 : 0) || prev.index_mode !== m.index_mode)) u.changed = true;
    upsertMarketplace(m);
  };
  const deleteMarketplace = store.deleteMarketplace.bind(store);
  store.deleteMarketplace = (name) => {
    const u = unit();
    if (u && store.getMarketplace(name)) u.changed = true;
    deleteMarketplace(name);
  };
}

/**
 * Runs `fn` as one piece of work: when it has changed the index, the generation goes up once at the end.
 * `flush()` bumps early for what changed so far (the first-run sync after each marketplace, D#323b, so its skills
 * show up in searches as soon as they are in) and returns whether it did.
 */
export async function trackIndexChanges<T>(store: Store, fn: (flush: () => boolean) => Promise<T>): Promise<T> {
  watchIndexWrites(store);
  const u: Unit = { changed: false };
  const flush = () => {
    if (!u.changed) return false;
    u.changed = false;
    bumpIndexGeneration(store);
    return true;
  };
  try {
    return await units.run(u, () => fn(flush));
  } finally {
    flush();
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Age-only clean-up of the search cache, in place of emptying it: cached searches are read for a day at most
 * (older ones are never shown), the external answers kept in the same table (`skillssh:`, `ghcode:`, `miss:`, …)
 * for a week. Same rule as Store.clearSearchCache's second half, without dropping the current searches.
 */
export function pruneSearchCache(store: Store, now = Date.now()): void {
  store.db.prepare("DELETE FROM search_cache WHERE key LIKE 'search:%' AND created_at < ?").run(new Date(now - DAY_MS).toISOString());
  store.db.prepare("DELETE FROM search_cache WHERE key NOT LIKE 'search:%' AND created_at < ?").run(new Date(now - 7 * DAY_MS).toISOString());
}

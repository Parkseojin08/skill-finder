import { randomUUID } from 'node:crypto';
import type { Store } from '../db/store.ts';
import type { SearchEvent, SearchFilters } from './pipeline.ts';

/** The hidden minigame's query (docs/arasaka-game.md) is never logged: the screen opens it without searching. */
const NOT_LOGGED = new Set(['arasaka_in']);

/**
 * Watches one search's events and, at `done`, writes one search-log entry (U5-2, user decision): the query, how
 * many results and hidden ones, how long the first and final results took, failed sources and the filters.
 * Only on this PC, never sent anywhere; the result list itself is not kept. Returns events to send (done gets `sid`).
 */
export function searchLogger(store: Store, query: string, filters: SearchFilters, started: number): (e: SearchEvent) => SearchEvent {
  if (NOT_LOGGED.has(query.trim().toLowerCase())) return (e) => e;
  const sid = randomUUID();
  let firstMs: number | null = null;
  let results: Extract<SearchEvent, { type: 'results' }> | null = null;
  const srcFail: string[] = [];
  let logged = false;
  return (e) => {
    if ((e.type === 'candidates' || e.type === 'results') && firstMs == null) firstMs = Date.now() - started;
    if (e.type === 'results') results = e;
    if (e.type === 'source' && (e.state === 'failed' || e.state === 'timeout')) srcFail.push(`${e.source}:${e.state}`);
    if (e.type !== 'done' || logged) return e;
    logged = true;
    try {
      write(e);
    } catch (err) {
      console.error('[search log]', err); // the search itself must not fail over its log entry
    }
    return { ...e, sid };
  };

  function write(e: Extract<SearchEvent, { type: 'done' }>) {
    store.logEvent('search', null, query, {
      sid,
      n: results?.items.length ?? 0,
      hidLow: results?.hiddenLowStars ?? 0,
      // since 2026-11-02 hidLow counts only known star counts below the minimum; unknown ones are here
      hidUnknown: results?.hiddenUnknownStars ?? 0,
      hidNoMatch: results?.hiddenNoMatch ?? 0,
      hidRisk: results?.hiddenHighRisk ?? 0,
      firstMs,
      finalMs: e.elapsedMs,
      cached: e.cached,
      srcFail,
      minStars: results?.minStars ?? null,
      maxRisk: filters.maxRisk ?? 'medium',
      lift: filters.minStars != null,
    });
  }
}

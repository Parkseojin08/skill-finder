import type { Store } from '../db/store.ts';
import { getSettings } from '../settings.ts';

/**
 * Recent searches from the local search log (F16; U5-2's events table, kind 'search'): each query once, the latest
 * first, with when it was last searched and how many results it had then. With the log turned off nothing is read
 * (an empty list), as nothing new is written either.
 */
export type RecentSearch = { query: string; at: string; results: number | null };

export const HISTORY_MAX = 50;

export function recentSearches(store: Store, limit = 10): RecentSearch[] {
  if (!getSettings(store).searchLog) return [];
  const n = Math.max(1, Math.min(HISTORY_MAX, Math.floor(limit) || 10));
  // the latest entries (the index on (kind, created_at) reads them in order), each query kept once below: case and
  // spacing folded. A few hundred cover the distinct ones asked for even when one query was searched many times.
  const rows = store.db
    .prepare(
      `SELECT query, created_at AS at, meta_json FROM events
       WHERE kind = 'search' AND query IS NOT NULL AND trim(query) != ''
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(n * 20) as Array<{ query: string; at: string; meta_json: string | null }>;
  const seen = new Set<string>();
  const out: RecentSearch[] = [];
  for (const r of rows) {
    const k = r.query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(k)) continue;
    seen.add(k);
    let results: number | null = null;
    try {
      const m = r.meta_json ? (JSON.parse(r.meta_json) as { n?: unknown }) : null;
      results = typeof m?.n === 'number' ? m.n : null;
    } catch {
      // an entry from an older shape
    }
    out.push({ query: r.query.trim(), at: r.at, results });
    if (out.length >= n) break;
  }
  return out;
}

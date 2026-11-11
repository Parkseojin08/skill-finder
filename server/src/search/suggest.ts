import type { Store } from '../db/store.ts';
import { ownerFilter } from '../prefs/ownerPrefs.ts';
import { indexGeneration } from './indexGeneration.ts';
import { ratioSuspect } from './installsSuspect.ts';
import { freshInstalls } from './rank.ts';

/**
 * Search-box suggestions (F16, feature review 2026-11-04): names in the local index that the typed text starts,
 * at the start of the name or of a word in it ("pdf" → "pdf", "pdf-tools", "anthropics/pdf-…"; "tools" →
 * "pdf-tools"). Kinds: skill names, plugins, `owner/repo` and owners. Most stars first, then downloads. Picking one
 * is the only way it changes the query (user decision E: the query stays as typed).
 *
 * Built once per index generation (and at most an hour old) as one array of word starts sorted by text, so a
 * keystroke is a binary search plus a sort of the matches, never a scan of the index.
 */

export type SuggestKind = 'skill' | 'plugin' | 'repo' | 'owner';
export type Suggestion = {
  kind: SuggestKind;
  /** What is shown and, for a skill or plugin, what the query becomes. */
  text: string;
  stars: number | null;
  installs: number | null;
  /** Skills of this name (skill), of the plugin (plugin), of the repo or of the owner's repos (repo, owner). */
  count: number;
  /** plugin: its marketplace. */
  marketplace?: string;
};

export const SUGGEST_LIMIT = 10;
/** Longer input is no name prefix (and keeps a keystroke's work bounded). */
export const SUGGEST_MAX_QUERY = 100;
const MAX_AGE_MS = 60 * 60 * 1000;
/** Matches gathered before sorting: a one-letter prefix can match a third of the index (the page asks from two). */
const MAX_GATHER = 30_000;

type Entry = Suggestion & { key: string };
type Index = { gen: number; at: number; entries: Entry[]; starts: Array<{ key: string; entry: number }> };
const indexes = new WeakMap<Store, Index>();

/** Where words start in a name: the start, and after "-", "_", ".", "/", ":", "@" and spaces. */
function wordStarts(key: string): number[] {
  const out = [0];
  for (let i = 1; i < key.length; i++) if (/[-_./:@\s]/.test(key[i - 1]) && !/[-_./:@\s]/.test(key[i])) out.push(i);
  return out;
}

const better = (a: { stars: number | null; installs: number | null }, b: { stars: number | null; installs: number | null }) =>
  (b.stars ?? -1) - (a.stars ?? -1) || (b.installs ?? -1) - (a.installs ?? -1);

function build(store: Store, now: number): Index {
  const rows = store.db
    .prepare(
      `SELECT s.name AS name, s.repo AS repo, s.plugin_id AS plugin_id, s.installs AS installs, s.installs_at AS installs_at, r.stars AS stars
       FROM skills s LEFT JOIN repos r ON r.full_name = s.repo COLLATE NOCASE
       WHERE s.origin != 'wellknown' AND s.description IS NOT NULL AND s.description != ''`,
    )
    .all() as Array<{ name: string; repo: string | null; plugin_id: string | null; installs: number | null; installs_at: string | null; stars: number | null }>;
  const byKey = new Map<string, Entry>();
  const add = (kind: SuggestKind, text: string, stars: number | null, installs: number | null, extra: Partial<Entry> = {}) => {
    const key = `${kind}:${text.toLowerCase()}`;
    const e = byKey.get(key);
    if (!e) {
      byKey.set(key, { kind, text, key: text.toLowerCase(), stars, installs, count: 1, ...extra });
      return;
    }
    e.count++;
    // the best-known copy decides where a name sorts
    if (better({ stars, installs }, e) < 0) {
      e.stars = stars;
      e.installs = installs;
    }
  };
  for (const r of rows) {
    const fresh = freshInstalls(r, now);
    // a download count that looks inflated (F18's ratio rule; the others need the whole index) is not used to sort
    const installs = ratioSuspect(fresh, r.stars) ? null : fresh;
    add('skill', r.name, r.stars, installs);
    if (r.repo) {
      add('repo', r.repo, r.stars, installs);
      add('owner', r.repo.split('/')[0], r.stars, installs);
    }
  }
  // owner and repo entries count skills; the star count is the best repo's, downloads its best skill's
  const plugins = store.db
    .prepare(
      `SELECT p.name AS name, p.marketplace AS marketplace, COUNT(s.id) AS n, MAX(r.stars) AS stars, MAX(s.installs) AS installs
       FROM plugins p LEFT JOIN skills s ON s.plugin_id = p.id LEFT JOIN repos r ON r.full_name = p.repo COLLATE NOCASE
       GROUP BY p.id`,
    )
    .all() as Array<{ name: string; marketplace: string; n: number; stars: number | null; installs: number | null }>;
  for (const p of plugins) {
    const key = `plugin:${p.name.toLowerCase()}`;
    const e = byKey.get(key);
    if (e) {
      e.count += p.n;
      continue;
    }
    byKey.set(key, { kind: 'plugin', text: p.name, key: p.name.toLowerCase(), stars: p.stars, installs: p.installs, count: p.n, marketplace: p.marketplace });
  }
  const entries = [...byKey.values()];
  const starts: Index['starts'] = [];
  entries.forEach((e, i) => {
    for (const at of wordStarts(e.key)) starts.push({ key: e.key.slice(at), entry: i });
  });
  starts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.entry - b.entry));
  return { gen: indexGeneration(store), at: now, entries, starts };
}

function indexOf(store: Store, now = Date.now()): Index {
  const gen = indexGeneration(store);
  const hit = indexes.get(store);
  if (hit && hit.gen === gen && now - hit.at < MAX_AGE_MS) return hit;
  const ix = build(store, now);
  indexes.set(store, ix);
  return ix;
}

export function clearSuggestCache(store: Store): void {
  indexes.delete(store);
}

/** First index whose key is ≥ q (keys sorted). */
function lowerBound(starts: Index['starts'], q: string): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid].key < q) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Up to `limit` names the text starts (whole name first, then a word in it); an exact name leads, then most stars,
 * then downloads. Text is matched in lowercase after trimming; empty or too long gives nothing.
 */
export function suggest(store: Store, text: string, limit = SUGGEST_LIMIT, now = Date.now()): Suggestion[] {
  const q = text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q || q.length > SUGGEST_MAX_QUERY) return [];
  const ix = indexOf(store, now);
  // a hidden repository or owner (F20) is not offered by name either; a skill name stays (other repos may have it)
  const owners = ownerFilter(store);
  const found = new Map<number, number>(); // entry → 0 exact, 1 name starts with q, 2 a word in it does
  for (let i = lowerBound(ix.starts, q); i < ix.starts.length && found.size < MAX_GATHER; i++) {
    const s = ix.starts[i];
    if (!s.key.startsWith(q)) break;
    const e = ix.entries[s.entry];
    if (owners.anyHidden && ((e.kind === 'repo' && owners.hidden(e.text)) || (e.kind === 'owner' && owners.hidden(`${e.text}/-`)))) continue;
    const rank = e.key === q ? 0 : e.key.startsWith(q) ? 1 : 2;
    const prev = found.get(s.entry);
    if (prev == null || rank < prev) found.set(s.entry, rank);
  }
  return [...found]
    .sort(([a, ra], [b, rb]) => Number(ra > 0) - Number(rb > 0) || better(ix.entries[a], ix.entries[b]) || ra - rb || ix.entries[a].key.localeCompare(ix.entries[b].key))
    .slice(0, Math.max(1, Math.min(limit, 20)))
    .map(([i]) => {
      const { key: _key, ...s } = ix.entries[i];
      return s;
    });
}

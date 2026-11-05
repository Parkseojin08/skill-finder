import type { Store } from '../db/store.ts';
import { indexGeneration } from './indexGeneration.ts';

/**
 * Spelling suggestion for two swapped letters only (B4 / perf debate D2, user decision 6): offered as a button
 * ("design으로 찾기"), never applied by itself. The dictionary is the index's own words (skill and plugin names and
 * descriptions, as written). A query word the index never uses, of 4+ letters, whose adjacent-swap neighbour is an
 * index word seen 3+ times, is replaced by the most common such neighbour. Measured: the real typos seen (dosc,
 * desing, docekr, reveiw, extrcat, tabel) 6/6; a wrong button on 0.03–0.06% of correctly spelled owner and repo
 * names (general edit distance had 9.6–22.8%, so it is not used).
 */
const STOPWORDS = new Set(
  'a an the and or for to of in on with from by using use uses skill skills claude code tool tools that this is are be my your how what into as at it its via any can will should'.split(' '),
);
const MIN_WORD = 4;
/** Times an index word must appear to be offered (rare words are often typos themselves). */
const MIN_DF = 3;
const DICT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

type Dict = { df: Map<string, number> };
const dicts = new WeakMap<Store, { gen: number; at: number; dict: Dict }>();

const words = (t: string | null) => t?.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];

/** Word → in how many skills and plugins it appears (~0.4 s on 20K skills; kept per index generation). */
function dictOf(store: Store, now = Date.now()): Dict {
  const gen = indexGeneration(store);
  const hit = dicts.get(store);
  if (hit && hit.gen === gen && now - hit.at < DICT_MAX_AGE_MS) return hit.dict;
  const df = new Map<string, number>();
  const add = (name: string, description: string | null) => {
    for (const w of new Set([...words(name.replace(/[-_.]+/g, ' ')), ...words(description)])) df.set(w, (df.get(w) ?? 0) + 1);
  };
  for (const r of store.db.prepare("SELECT name, description FROM skills WHERE origin != 'wellknown'").iterate() as Iterable<{ name: string; description: string | null }>) add(r.name, r.description);
  for (const r of store.db.prepare('SELECT name, description FROM plugins').iterate() as Iterable<{ name: string; description: string | null }>) add(r.name, r.description);
  const dict = { df };
  dicts.set(store, { gen, at: now, dict });
  return dict;
}

/** The most common index word that is `w` with two adjacent letters swapped, or null. */
export function swapCorrection(w: string, df: ReadonlyMap<string, number>): string | null {
  if (w.length < MIN_WORD || !/^[a-z]+$/.test(w) || STOPWORDS.has(w) || (df.get(w) ?? 0) > 0) return null;
  let best: { w: string; n: number } | null = null;
  for (let i = 0; i + 1 < w.length; i++) {
    if (w[i] === w[i + 1]) continue;
    const c = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
    const n = df.get(c) ?? 0;
    if (n >= MIN_DF && (!best || n > best.n)) best = { w: c, n };
  }
  return best?.w ?? null;
}

export type SpellingSuggestion = { query: string; words: Array<{ from: string; to: string }> };

/** The query with its swapped-letter words fixed, or null when none is. The rest stays as typed (lowercased). */
export function spellingSuggestion(store: Store, query: string): SpellingSuggestion | null {
  const parts = query.toLowerCase().match(/[a-z0-9]+|[^a-z0-9]+/g) ?? [];
  if (!parts.some((p) => /^[a-z]{4,}$/.test(p))) return null;
  const { df } = dictOf(store);
  const fixed: SpellingSuggestion['words'] = [];
  const out = parts.map((p) => {
    const c = /^[a-z]+$/.test(p) ? swapCorrection(p, df) : null;
    if (!c) return p;
    fixed.push({ from: p, to: c });
    return c;
  });
  return fixed.length ? { query: out.join('').trim(), words: fixed } : null;
}

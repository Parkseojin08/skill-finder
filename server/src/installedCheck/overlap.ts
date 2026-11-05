// Installed skills that say the same thing (feature review F8): copies with the same SKILL.md, and pairs whose name
// and description share most of their words, which can make Claude pick the wrong one (a guess). The words are taken
// as the skill page's "similar skills" takes them (processTerm: stopwords, short words and numbers out; stem).
import { processTerm } from '../recommend/readme.ts';
import { stem } from '../search/rank.ts';

/** Share of words two skills must have in common (Jaccard of their word sets). */
export const OVERLAP_MIN = 0.6;
/** Fewer words than this say too little to compare ("pdf" vs "pdf"). */
export const OVERLAP_MIN_TOKENS = 3;
export const OVERLAP_MAX_PAIRS = 200;
/** Skills compared at most (the rest are left out, said in the answer). */
export const OVERLAP_MAX_SKILLS = 2000;
/** Most words kept per skill: a description is a line or two, a pasted essay is not compared whole. */
const MAX_TOKENS = 200;
const MAX_WORDS = 2000;

const WORD_SPLIT = /[\n\r\p{Z}\p{P}\p{S}]+/u;

/** The skill's words: its name (split at - _ .) and description, stemmed, each once, in order. */
export function overlapTokens(name: string, description: string): string[] {
  const out = new Set<string>();
  let words = 0;
  for (const text of [name.replace(/[-_.]+/g, ' '), description]) {
    for (const raw of text.split(WORD_SPLIT)) {
      if (!raw) continue;
      if (++words > MAX_WORDS) return [...out];
      for (const term of processTerm(raw) ?? []) {
        out.add(stem(term));
        if (out.size >= MAX_TOKENS) return [...out];
      }
    }
  }
  return [...out];
}

export type OverlapInput = { path: string; hash: string | null; tokens: string[] };
export type OverlapPair = { a: number; b: number; score: number; shared: string[] };

/**
 * Pairs at or above OVERLAP_MIN, best first, at most OVERLAP_MAX_PAIRS. Counted through the words they share (an
 * inverted index), so skills with nothing in common cost nothing. Copies with the same hash are left out: they are
 * the duplicates, said on their own.
 */
export function overlapPairs(skills: readonly OverlapInput[]): OverlapPair[] {
  const sets = skills.map((s) => (s.tokens.length >= OVERLAP_MIN_TOKENS ? new Set(s.tokens) : null));
  const postings = new Map<string, number[]>();
  sets.forEach((set, i) => {
    if (!set) return;
    for (const tok of set) {
      const list = postings.get(tok);
      if (list) list.push(i);
      else postings.set(tok, [i]);
    }
  });
  let pairs: Array<{ a: number; b: number; score: number }> = [];
  const byBest = (x: { a: number; b: number; score: number }, y: { a: number; b: number; score: number }) => y.score - x.score || x.a - y.a || x.b - y.b;
  const count = new Int32Array(sets.length);
  const touched: number[] = [];
  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    if (!set) continue;
    for (const tok of set) {
      for (const j of postings.get(tok)!) {
        if (j <= i) continue;
        if (count[j] === 0) touched.push(j);
        count[j]++;
      }
    }
    for (const j of touched) {
      const shared = count[j];
      count[j] = 0;
      const score = shared / (set.size + sets[j]!.size - shared);
      if (score < OVERLAP_MIN || (skills[i].hash && skills[i].hash === skills[j].hash)) continue;
      pairs.push({ a: i, b: j, score: Math.round(score * 100) / 100 });
    }
    touched.length = 0;
    // many skills alike (a folder of near copies): keep only the best few as we go
    if (pairs.length > OVERLAP_MAX_PAIRS * 20) pairs = pairs.sort(byBest).slice(0, OVERLAP_MAX_PAIRS);
  }
  return pairs
    .sort(byBest)
    .slice(0, OVERLAP_MAX_PAIRS)
    .map((p) => ({ ...p, shared: [...sets[p.a]!].filter((t) => sets[p.b]!.has(t)) }));
}

/** Paths sharing one SKILL.md hash, two or more to a group, in the order given. */
export function duplicateGroups(skills: readonly OverlapInput[]): Array<{ hash: string; paths: string[] }> {
  const byHash = new Map<string, string[]>();
  for (const s of skills) {
    if (!s.hash) continue;
    const list = byHash.get(s.hash);
    if (list) list.push(s.path);
    else byHash.set(s.hash, [s.path]);
  }
  return [...byHash].filter(([, paths]) => paths.length > 1).map(([hash, paths]) => ({ hash, paths }));
}

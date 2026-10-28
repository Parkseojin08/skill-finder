import type { PluginRow, SkillRow } from '../db/store.ts';
import { COMMUNITY_MARKETPLACES, PARTNER_MARKETPLACES, type Settings } from '../settings.ts';

export type Breakdown = { R: number; P: number; F: number; T: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** 1 within 90 days of the last commit, linearly down to 0 at 730 days; unknown → 0. */
export function freshness(lastCommitAt: string | null | undefined, now = Date.now()): number {
  if (!lastCommitAt) return 0;
  const t = Date.parse(lastCommitAt);
  if (Number.isNaN(t)) return 0;
  const days = (now - t) / DAY_MS;
  if (days <= 90) return 1;
  if (days >= 730) return 0;
  return clamp01(1 - (days - 90) / (730 - 90));
}

/**
 * Installs when known (skill-level), else stars × 0.6 — stars are repo-level, and one repo can hold
 * hundreds of skills, so they say little about a single skill.
 */
export function popularity(c: { installs?: number | null; stars?: number | null }, maxInstalls: number, maxStars: number): number {
  if (c.installs != null && c.installs > 0 && maxInstalls > 0) return clamp01(Math.log10(1 + c.installs) / Math.log10(1 + maxInstalls));
  if (c.stars != null && c.stars > 0 && maxStars > 0) return clamp01((0.6 * Math.log10(1 + c.stars)) / Math.log10(1 + maxStars));
  return 0;
}

export type TrustTier = 'official' | 'partner' | 'community' | 'other';

export function trustTier(skill: Pick<SkillRow, 'repo' | 'dir_path'>, plugin: Pick<PluginRow, 'marketplace'> | null): TrustTier {
  if (plugin && COMMUNITY_MARKETPLACES.has(plugin.marketplace)) return 'community';
  const owner = skill.repo?.split('/')[0]?.toLowerCase();
  if (owner === 'anthropics' && !skill.dir_path?.startsWith('external_plugins/')) return 'official';
  if (plugin && PARTNER_MARKETPLACES.has(plugin.marketplace)) return 'partner';
  return 'other';
}

export const TRUST_SCORE: Record<TrustTier, number> = { official: 1.0, partner: 0.8, community: 0.6, other: 0.4 };

export function totalScore(b: Breakdown, w: Settings['weights']): number {
  const sum = w.R + w.P + w.F + w.T;
  if (sum <= 0) return 0;
  return (w.R * b.R + w.P * b.P + w.F * b.F + w.T * b.T) / sum;
}

/** Relevance from bm25 (lower = better in SQLite) normalized against the best hit. */
export function bm25ToRelevance(bm25: number, best: number, worst: number): number {
  if (!Number.isFinite(bm25)) return 0;
  if (best === worst) return 1;
  return clamp01(0.3 + 0.7 * ((worst - bm25) / (worst - best)));
}

const MATCH_STOPWORDS = new Set(
  'a an the and or for to of in on with from by using use uses skill skills claude code tool tools that this is are be my your how what into as at it its via any can will should'.split(' '),
);

/** Crude English stem so "extracting"/"extraction"/"extracts" and "tables"/"table" line up. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  // plurals first: "boxes" → "box", "tables" → "table", "libraries" → "library"
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  for (const suffix of ['ation', 'ion', 'ing', 'er', 'ed']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

export function matchTokens(text: string): string[] {
  // A Latin word with a Korean ending attached ("pdf에서", "엑셀로") counts as the Latin word alone, as in ftsQuery.
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((t) => (/[a-z0-9]/.test(t) && /\p{Script=Hangul}/u.test(t) ? (t.match(/[a-z0-9]+/g) ?? []) : [t]));
  return words.filter((t) => t.length >= 2 && !MATCH_STOPWORDS.has(t)).map(stem);
}

/** Shares of the query words found in the name, in the description, in either; and the query as a phrase. */
export type LexicalMatch = { name: number; text: number; any: number; phrase: number };

/**
 * The query words a result is matched against:
 * - With an English word present, Korean words are left out: the descriptions are English, so they could
 *   never match and only lowered every share ("react 성능 최적화" capped at 1/3, below the tier's 0.5).
 * - A query of stopwords only ("skill", "claude code") keeps them, or nothing would be matched at all.
 */
export function queryTokens(query: string): string[] {
  const words = matchTokens(query);
  const latin = words.filter((t) => !/\p{Script=Hangul}/u.test(t));
  if (latin.length > 0) return [...new Set(latin)];
  if (words.length > 0) return [...new Set(words)];
  return [...new Set(genericWords(query))];
}

/**
 * Stopwords that still name something in this domain. Dropped from queries normally, but searched when they
 * are all there is ("skill", "claude code"); grammar words ("a the") are not.
 */
export const GENERIC_WORDS = new Set(['skill', 'skills', 'claude', 'code', 'tool', 'tools']);
const genericWords = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => GENERIC_WORDS.has(t)).map(stem);
/** Words a name or description is matched on: matchTokens plus the generic words a stopword-only query uses. */
const textWords = (text: string) => new Set([...matchTokens(text), ...genericWords(text)]);

/**
 * How directly a skill matches the query words: share of query words in the skill name, share in the
 * description/when_to_use, and whether the description contains the query as a phrase.
 */
export function lexicalMatch(query: string, name: string, text: string): LexicalMatch {
  const q = queryTokens(query);
  if (q.length === 0) return { name: 0, text: 0, any: 0, phrase: 0 };
  const nameSet = textWords(name.replace(/[-_.]+/g, ' '));
  const textSet = textWords(text);
  // a longer query word also matches as a prefix ("docker" in "dockerfile"); short ones ("pdf", "ui") must be exact
  const has = (set: Set<string>, t: string) => set.has(t) || (t.length >= 4 && [...set].some((w) => w.startsWith(t)));
  const cover = (set: Set<string>) => q.filter((t) => has(set, t)).length / q.length;
  const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const phrase = q.length >= 2 && normalize(text).includes(normalize(query)) ? 1 : 0;
  const any = q.filter((t) => has(nameSet, t) || has(textSet, t)).length / q.length;
  return { name: cover(nameSet), text: cover(textSet), any, phrase };
}

/**
 * Relevance tier (user decision): 1 when the name has a query word and at least half the words appear in the
 * name or description. Results are ordered by tier first, then downloads → stars → R as before.
 */
export function relevanceTier(m: LexicalMatch): number {
  return m.name > 0 && m.any >= 0.5 ? 1 : 0;
}

/** Final R: the search-engine signal blended with direct word matches, so fuzzy hits without the query words sink. */
export function blendRelevance(base: number, m: LexicalMatch): number {
  return clamp01(0.45 * base + 0.25 * m.text + 0.2 * m.name + 0.1 * m.phrase);
}

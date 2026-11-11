// Similar skills and alternatives on a skill's page (feature review 2026-11-04 F4). No AI: the skill's own words,
// weighted by tf-idf, are matched against the local index the way README 추천 matches a README (matchSkills).
import { Router } from 'express';
import { RISK_ORDER, type RiskLevel } from '../analyze/risk.ts';
import type { AppContext } from '../context.ts';
import type { SkillRow, Store } from '../db/store.ts';
import { ownerFilter } from '../prefs/ownerPrefs.ts';
import { CONFIG as README_CONFIG, matchSkills, processTerm, type Keyword } from '../recommend/readme.ts';
import { freshInstalls, freshness, popularity, stem, totalScore, TRUST_SCORE, trustTier } from '../search/rank.ts';
import { buildResultItem, githubSource, marketplaceSource, storeLookup, type ResultItem } from '../search/result.ts';
import { getSettings, type Settings } from '../settings.ts';

/** Words of the skill searched for. */
export const SIMILAR_TERMS = 12;
/** Cards per section. */
export const SIMILAR_MAX = 8;

export type SimilarEntry = {
  item: ResultItem;
  /** matchSkills' score (Σ log2(1 + tf) × idf over the shared words, ×2 in the name). */
  score: number;
  matchedTerms: string[];
  /** Its risk level is below the skill's own: shown as "더 낮은 위험". */
  lowerRisk: boolean;
};

export type SimilarResult = {
  /** The words searched for, strongest first. */
  terms: string[];
  /** Skills of other repos and plugins that do the same job, most downloaded first (then stars). */
  similar: SimilarEntry[];
  /** Other skills of the same plugin (when it is one), else of the same repo: the similar ones first, then by downloads. */
  siblings: SimilarEntry[];
  siblingsOf: 'plugin' | 'repo' | null;
  /** How many there are in all (high risk aside); `siblings` shows SIMILAR_MAX at most. */
  siblingsTotal: number;
  /** Similar ones left out as the search leaves them out: high risk, and below the star minimum (or unknown). */
  hidden: { highRisk: number; lowStars: number };
};

const ftsTerm = (t: string) => `"${t.replace(/"/g, '')}"`;
/** As readme.ts splits text into tokens (spaces, punctuation, symbols). */
const WORD_SPLIT = /[\n\r\p{Z}\p{P}\p{S}]+/u;

/** Document frequency per word, kept until the index changes size (one page asks for 20–60 words). */
const dfCache = { total: -1, byTerm: new Map<string, number>() };
function docFreq(store: Store, term: string, total: number): number {
  if (dfCache.total !== total || dfCache.byTerm.size > 20_000) {
    dfCache.total = total;
    dfCache.byTerm.clear();
  }
  let n = dfCache.byTerm.get(term);
  if (n === undefined) {
    n = store.countSkillsFts(ftsTerm(term));
    dfCache.byTerm.set(term, n);
  }
  return n;
}

/**
 * The skill's words by tf-idf: name (×2, as matchSkills weighs a name hit), description and when_to_use, grouped
 * by stem like README keywords; document frequency from the FTS index. The weight handed on is the term frequency,
 * since matchSkills applies the idf itself.
 */
export function skillKeywords(store: Store, skill: Pick<SkillRow, 'name' | 'description' | 'when_to_use'>, max = SIMILAR_TERMS): Keyword[] {
  const byKey = new Map<string, { tf: number; forms: Map<string, number> }>();
  const add = (text: string | null, k: number) => {
    // whole words only: camelCase pieces made "PDFs" into the rare, meaningless "pd" and "fs"
    for (const raw of (text ?? '').split(WORD_SPLIT).filter(Boolean)) {
      for (const term of processTerm(raw) ?? []) {
        const key = stem(term);
        const e = byKey.get(key) ?? { tf: 0, forms: new Map<string, number>() };
        e.tf += k;
        e.forms.set(term, (e.forms.get(term) ?? 0) + k);
        byKey.set(key, e);
      }
    }
  };
  add(skill.name.replace(/[-_.]+/g, ' '), README_CONFIG.nameBoost);
  add(skill.description, 1);
  add(skill.when_to_use, 1);
  const total = Math.max(1, store.countSkills());
  return [...byKey]
    .map(([key, e]) => {
      const term = [...e.forms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      const df = docFreq(store, term, total);
      return { key, term, weight: e.tf, tfidf: df === 0 ? 0 : e.tf * Math.log(1 + (total - df + 0.5) / (df + 0.5)) };
    })
    .filter((k) => k.tfidf > 0)
    .sort((a, b) => b.tfidf - a.tfidf || a.term.localeCompare(b.term))
    .slice(0, max)
    .map(({ key, term, weight }) => ({ key, term, weight }));
}

/**
 * Similar skills of one indexed skill, in two sections. "similar": matchSkills keeps those scoring at least 35% of the
 * best (the skill itself, usually) and orders them by downloads, then stars (D#a8a5); left out are the skill, copies
 * with the same SKILL.md (one card per text), near-copies (one card per B8 group, none of its own group) and, as in search, high risk and repos below the star minimum (unknown
 * counts too; official and partner skills pass). "siblings": the other skills of its plugin, else of its repo, the
 * similar ones first, then by downloads; high risk is left out, stars are not (it is the repo already open). Null when
 * the id is not indexed.
 */
export function findSimilar(store: Store, id: string, settings: Pick<Settings, 'weights' | 'minStars'>): SimilarResult | null {
  const skill = store.getSkill(id);
  if (!skill) return null;
  const keywords = skillKeywords(store, skill);
  const own = (skill.risk_level ?? 'low') as RiskLevel;
  const lowerRisk = (level: RiskLevel) => RISK_ORDER[level] < RISK_ORDER[own];
  const out: SimilarResult = {
    terms: keywords.map((k) => k.term),
    similar: [],
    siblings: [],
    siblingsOf: skill.plugin_id ? 'plugin' : skill.repo ? 'repo' : null,
    siblingsTotal: 0,
    hidden: { highRisk: 0, lowStars: 0 },
  };
  const seenText = new Set<string>(skill.skill_md_sha256 ? [skill.skill_md_sha256] : []);
  // B8: near-copies too (renamed or lightly edited): this skill's own group is left out, and one card per other group
  const seenCluster = new Set<string>(skill.cluster_id ? [skill.cluster_id] : []);
  const isSibling = (row: SkillRow) =>
    skill.plugin_id ? row.plugin_id === skill.plugin_id : !!skill.repo && !!row.repo && row.repo.toLowerCase() === skill.repo.toLowerCase();

  const owners = ownerFilter(store);
  const similarSiblings = new Map<string, SimilarEntry>();
  for (const m of keywords.length ? matchSkills(store, keywords, settings.weights) : []) {
    if (m.item.id === skill.id) continue;
    const row = store.getSkill(m.item.id);
    if (!row || (row.skill_md_sha256 && row.skill_md_sha256 === skill.skill_md_sha256)) continue;
    if (isSibling(row)) {
      if (m.item.riskLevel !== 'high') similarSiblings.set(row.id, { item: m.item, score: m.score, matchedTerms: m.matchedTerms, lowerRisk: lowerRisk(m.item.riskLevel) });
      continue;
    }
    // a hidden repository (F20) is not offered as an alternative either (this skill's own repo, above, still is)
    if (owners.hidden(row.repo)) continue;
    if (row.skill_md_sha256) {
      if (seenText.has(row.skill_md_sha256)) continue; // a copy of this skill, or of a card already listed
      seenText.add(row.skill_md_sha256);
    }
    if (row.cluster_id) {
      if (seenCluster.has(row.cluster_id)) continue; // a near-copy of this skill, or of a card already listed
      seenCluster.add(row.cluster_id);
    }
    if (out.similar.length >= SIMILAR_MAX) continue;
    if (m.item.riskLevel === 'high') {
      out.hidden.highRisk++;
      continue;
    }
    const starsOk = settings.minStars <= 0 || m.item.trust === 'official' || m.item.trust === 'partner' || (m.item.stars ?? -1) >= settings.minStars;
    if (!starsOk) {
      out.hidden.lowStars++;
      continue;
    }
    out.similar.push({ item: m.item, score: m.score, matchedTerms: m.matchedTerms, lowerRisk: lowerRisk(m.item.riskLevel) });
  }

  const rows = (skill.plugin_id ? store.listSkillsByPlugin(skill.plugin_id) : skill.repo ? store.findSkillsByRepo(skill.repo) : [])
    .filter((s) => s.id !== skill.id && s.description && s.origin !== 'wellknown' && (s.risk_level ?? 'low') !== 'high')
    .filter((s) => !s.skill_md_sha256 || s.skill_md_sha256 !== skill.skill_md_sha256);
  out.siblingsTotal = rows.length;
  const rest = rows
    .filter((s) => !similarSiblings.has(s.id))
    .sort((a, b) => (freshInstalls(b) ?? -1) - (freshInstalls(a) ?? -1) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, SIMILAR_MAX - similarSiblings.size));
  const lookup = storeLookup(store);
  const starsOf = (s: SkillRow) => (s.repo ? (store.getRepo(s.repo)?.stars ?? null) : null);
  const maxInstalls = Math.max(0, ...rest.map((s) => freshInstalls(s) ?? 0));
  const maxStars = Math.max(0, ...rest.map((s) => starsOf(s) ?? 0));
  out.siblings = [
    ...[...similarSiblings.values()].slice(0, SIMILAR_MAX),
    ...rest.map((s): SimilarEntry => {
      const plugin = lookup.plugin(s.plugin_id);
      const installs = freshInstalls(s);
      const stars = starsOf(s);
      const breakdown = { R: 0, P: popularity({ installs, stars }, maxInstalls, maxStars), F: freshness(s.last_commit_at), T: TRUST_SCORE[trustTier(s, plugin)] };
      const source = plugin ? marketplaceSource(s, plugin) : githubSource(s);
      const item = buildResultItem({ skill: s, lookup, sources: source ? [source] : [], installs, stars, breakdown, score: totalScore(breakdown, settings.weights) });
      return { item, score: 0, matchedTerms: [], lowerRisk: lowerRisk(item.riskLevel) };
    }),
  ].slice(0, SIMILAR_MAX);
  return out;
}

export function similarRouter(ctx: AppContext): Router {
  const r = Router();
  r.get('/skills/:id/similar', (req, res) => {
    const result = findSimilar(ctx.store, req.params.id, getSettings(ctx.store));
    if (!result) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    res.json(result);
  });
  return r;
}

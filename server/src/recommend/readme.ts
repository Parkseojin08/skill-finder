import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { Store } from '../db/store.ts';
import { freshness, matchTokens, popularity, stem, totalScore, TRUST_SCORE, trustTier } from '../search/rank.ts';
import { buildResultItem, githubSource, marketplaceSource, storeLookup, type ResultItem } from '../search/result.ts';
import type { Settings } from '../settings.ts';

/**
 * README-based skill recommendation, no AI: read the project's root README, pull out its structure,
 * weight its words by where they appear, and match them against the local skill index.
 * Same input + same index → same result.
 */

export const CONFIG = {
  maxReadmeBytes: 1024 * 1024,
  minParagraphChars: 20,
  maxFeatures: 5,
  maxQueryTerms: 40,
  weights: { title: 5, intro: 3, feature: 3, heading: 3, body: 1, lang: 1 },
  nameBoost: 2,
  /** Recommend only when the top score is this many times the runner-up… */
  confidentRatio: 1.5,
  /** …and the top skill shares at least this many words with the README. */
  minMatchedTerms: 2,
  /** FTS hits re-scored per request. */
  poolSize: 300,
  maxCandidates: 10,
};

export type ReadmeErrorCode = 'INVALID_PATH' | 'README_NOT_FOUND' | 'README_TOO_LARGE';
const STATUS: Record<ReadmeErrorCode, number> = { INVALID_PATH: 400, README_NOT_FOUND: 404, README_TOO_LARGE: 413 };

export class ReadmeError extends Error {
  readonly code: ReadmeErrorCode;
  readonly status: number;
  constructor(code: ReadmeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}

// English stopwords, skill-description filler, and README boilerplate (install/usage/license sections).
const STOP = new Set(
  `a an the and or but if then else of to in on at by for with from into onto over as is are was were be been being
  it its this that these those there here such any all each every can could should would will may might must do does
  did done not no nor so than too very just also you your we our they their them he she his her i me my mine who whom
  which what when where why how use used uses using user users skill skills claude whenever want wants trigger triggers
  task tasks etc via about out up down more most other some only own same new like make makes made get gets file files
  include includes including example examples see install installation installing usage license licensed mit apache
  contributing contribute contributors getting started quick quickstart npm yarn pnpm bun npx run running requirements
  prerequisites copyright table contents toc badge badges readme click here link links please thanks changelog
  feature features overview introduction intro about faq support`.split(/\s+/),
);

/** Korean words → English words actually used in skill descriptions. Prefix match absorbs particles (엑셀로 → 엑셀). */
export const ALIASES: Record<string, string[]> = {
  엑셀: ['spreadsheet', 'xlsx', 'excel'],
  스프레드시트: ['spreadsheet'],
  리액트: ['react'],
  워드: ['word', 'docx'],
  파워포인트: ['powerpoint', 'pptx'],
  슬라이드: ['slides'],
  테스트: ['testing'],
  브라우저: ['browser'],
  데이터베이스: ['database', 'sql'],
  배포: ['deploy', 'deployment'],
  보안: ['security'],
  디자인: ['design'],
  문서: ['document', 'documentation'],
  이미지: ['image'],
  서버: ['server'],
  깃허브: ['github'],
};

const SPLIT = /[\n\r\p{Z}\p{P}\p{S}]+/u;

/** Splits on spaces/punctuation; camelCase tokens keep the whole word and its parts (PptxMaker → PptxMaker, Pptx, Maker). */
export function tokenize(text: string): string[] {
  return text
    .split(SPLIT)
    .filter(Boolean)
    .flatMap((tok) => {
      const parts = tok
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(' ');
      return parts.length > 1 ? [tok, ...parts] : [tok];
    });
}

/** One raw token → lowercase English word(s), or null (short, number, stopword, or non-English without an alias). */
export function processTerm(raw: string): string[] | null {
  const t = raw.toLowerCase();
  if (t.length < 2 || STOP.has(t) || /^\d+$/.test(t)) return null;
  const alias = Object.keys(ALIASES).find((k) => t.startsWith(k));
  if (alias) return ALIASES[alias];
  // the skill index is English; other scripts cannot match it
  return /^[a-z][a-z0-9]*$/.test(t) ? [t] : null;
}

export function findReadme(projectPath: unknown): string {
  if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) throw new ReadmeError('INVALID_PATH', '절대 경로를 입력해야 합니다.');
  let isDir = false;
  try {
    isDir = statSync(projectPath).isDirectory();
  } catch {
    // missing path
  }
  if (!isDir) throw new ReadmeError('INVALID_PATH', '존재하는 폴더가 아닙니다.');
  const name = readdirSync(projectPath, { withFileTypes: true }).find((e) => e.isFile() && /^readme(\.(md|markdown|txt))?$/i.test(e.name))?.name;
  if (!name) throw new ReadmeError('README_NOT_FOUND', '폴더 바로 아래에 README가 없습니다.');
  const file = join(projectPath, name);
  if (statSync(file).size > CONFIG.maxReadmeBytes) throw new ReadmeError('README_TOO_LARGE', 'README가 1MB를 넘습니다.');
  return file;
}

export type ReadmeInfo = { title: string; intro: string; features: string[]; headings: string[]; body: string[]; langs: string[] };

/** Inline markdown → plain text: images (badges) and inline HTML dropped, links reduced to their text. */
function inlineText(s: string): string {
  return s
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ') // linked badge
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // image
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ') // reference image
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1') // reference link
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Title (first H1, else the folder name), intro (first paragraph of 20+ chars), features (first list under a
 * "feature/기능/특징" heading, up to 5), other headings, body text and code-block languages. Code itself is
 * dropped: README code and badges otherwise dominate any word statistics.
 */
export function extractReadme(md: string, fallbackTitle: string): ReadmeInfo {
  const out: ReadmeInfo = { title: '', intro: '', features: [], headings: [], body: [], langs: [] };
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let section = '';
  let para: string[] = [];
  let list: string[] = [];

  const addText = (raw: string, html = false) => {
    const text = html ? inlineText(raw.replace(/<[^>]*>/g, ' ')) : inlineText(raw);
    if (text.length < CONFIG.minParagraphChars) return; // badge rows and short lines
    if (!out.intro) out.intro = text;
    else out.body.push(text);
  };
  const flushPara = () => {
    if (para.length) addText(para.join(' '), para[0].trimStart().startsWith('<'));
    para = [];
  };
  const flushList = () => {
    const items = list.map(inlineText).filter(Boolean);
    if (items.length) {
      if (/feature|기능|특징/i.test(section) && out.features.length === 0) out.features = items.slice(0, CONFIG.maxFeatures);
      else out.body.push(...items);
    }
    list = [];
  };
  const heading = (depth: number, raw: string) => {
    flushPara();
    flushList();
    section = inlineText(raw);
    if (!section) return;
    if (depth === 1 && !out.title) out.title = section;
    else out.headings.push(section);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/);
    if (fence) {
      flushPara();
      flushList();
      if (fence[2]) out.langs.push(fence[2].toLowerCase());
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) {
        // code is not read
      }
      continue;
    }
    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (atx) {
      heading(atx[1].length, atx[2]);
      continue;
    }
    const next = lines[i + 1] ?? '';
    if (line.trim() && !list.length && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      heading(next.trim().startsWith('=') ? 1 : 2, line); // setext heading
      i++;
      continue;
    }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      list.push(item[1].replace(/^\[[ xX]\]\s*/, ''));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (list.length && /^\s{2,}\S/.test(line)) {
      list[list.length - 1] += ` ${line.trim()}`; // continuation of a list item
      continue;
    }
    if (/^\s*\|/.test(line)) continue; // tables
    flushList();
    para.push(line.replace(/^\s*>\s?/, ''));
  }
  flushPara();
  flushList();
  if (!out.title) out.title = fallbackTitle;
  return out;
}

export type Keyword = { key: string; term: string; weight: number };

/**
 * Word weights: title 5, intro/features/headings 3, body/code languages 1, summed per word; top 40.
 * Words are grouped by stem (`testing`/`tests` → `test`); `term` is the most weighted surface form.
 */
export function termWeights(info: ReadmeInfo): Keyword[] {
  const byKey = new Map<string, { weight: number; forms: Map<string, number> }>();
  const add = (text: string, k: number) => {
    for (const raw of tokenize(text)) {
      for (const term of processTerm(raw) ?? []) {
        const key = stem(term);
        const e = byKey.get(key) ?? { weight: 0, forms: new Map<string, number>() };
        e.weight += k;
        e.forms.set(term, (e.forms.get(term) ?? 0) + k);
        byKey.set(key, e);
      }
    }
  };
  const w = CONFIG.weights;
  add(info.title, w.title);
  add(info.intro, w.intro);
  info.features.forEach((s) => add(s, w.feature));
  info.headings.forEach((s) => add(s, w.heading));
  info.body.forEach((s) => add(s, w.body));
  info.langs.forEach((s) => add(s, w.lang));
  return [...byKey]
    .map(([key, e]) => ({ key, term: [...e.forms].sort((a, b) => b[1] - a[1])[0][0], weight: e.weight }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, CONFIG.maxQueryTerms);
}

export type SkillMatch = { item: ResultItem; score: number; matchedTerms: string[] };

export type RecommendResult = {
  readmePath: string;
  summary: { title: string; intro: string; features: string[] };
  keywords: Array<{ term: string; weight: number }>;
  status: 'recommended' | 'candidates' | 'no-match';
  recommended: SkillMatch | null;
  candidates: SkillMatch[];
};

const ftsTerm = (t: string) => `"${t.replace(/"/g, '')}"`;

/**
 * Matches README keywords against the local skill index: FTS (porter) fetches every skill that shares a word,
 * then each is scored as Σ log2(1 + weight) × idf over the shared words, doubled for words in the skill name.
 */
export function matchSkills(store: Store, keywords: Keyword[], weights: Settings['weights']): Omit<RecommendResult, 'readmePath' | 'summary' | 'keywords'> {
  if (keywords.length === 0) return { status: 'no-match', recommended: null, candidates: [] };
  const hits = store.searchSkillsFts(keywords.map((k) => ftsTerm(k.term)).join(' OR '), CONFIG.poolSize);
  const total = Math.max(1, store.countSkills());
  const idf = new Map(
    keywords.map((k) => {
      const df = store.countSkillsFts(ftsTerm(k.term));
      return [k.key, Math.log(1 + (total - df + 0.5) / (df + 0.5))];
    }),
  );

  const scored = hits
    .map(({ skill }) => skill)
    .filter((s) => s.description && s.origin !== 'wellknown')
    .map((s) => {
      const name = new Set(matchTokens(s.name.replace(/[-_.]+/g, ' ')));
      const text = new Set(matchTokens([s.description ?? '', s.when_to_use ?? ''].join(' ')));
      let score = 0;
      const matched: string[] = [];
      for (const k of keywords) {
        const inName = name.has(k.key);
        if (!inName && !text.has(k.key)) continue;
        matched.push(k.term);
        score += Math.log2(1 + k.weight) * (idf.get(k.key) ?? 0) * (inName ? CONFIG.nameBoost : 1);
      }
      return { skill: s, score, matched };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.skill.installs ?? -1) - (a.skill.installs ?? -1) || a.skill.id.localeCompare(b.skill.id));

  // The same skill is often republished in other repos (sometimes with small edits). A copy is not a rival:
  // keep the best one per name, or "pdf" vs "pdf" would never be a confident recommendation.
  const seen = new Set<string>();
  const unique = scored.filter((x) => {
    const k = x.skill.name.toLowerCase().replace(/[\s_]+/g, '-');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) return { status: 'no-match', recommended: null, candidates: [] };

  const lookup = storeLookup(store);
  const top = unique.slice(0, CONFIG.maxCandidates);
  const maxInstalls = Math.max(0, ...top.map((x) => x.skill.installs ?? 0));
  const starsOf = (repo: string | null) => (repo ? (store.getRepo(repo)?.stars ?? null) : null);
  const maxStars = Math.max(0, ...top.map((x) => starsOf(x.skill.repo) ?? 0));
  const toMatch = (x: (typeof unique)[number]): SkillMatch => {
    const s = x.skill;
    const plugin = lookup.plugin(s.plugin_id);
    const stars = starsOf(s.repo);
    const breakdown = {
      R: x.score / unique[0].score,
      P: popularity({ installs: s.installs, stars }, maxInstalls, maxStars),
      F: freshness(s.last_commit_at),
      T: TRUST_SCORE[trustTier(s, plugin)],
    };
    const source = plugin ? marketplaceSource(s, plugin) : githubSource(s);
    const item = buildResultItem({
      skill: s,
      lookup,
      sources: source ? [source] : [],
      installs: s.installs,
      stars,
      breakdown,
      score: totalScore(breakdown, weights),
    });
    return { item, score: Math.round(x.score * 100) / 100, matchedTerms: x.matched };
  };

  const [first, second] = unique;
  const confident = first.score >= CONFIG.confidentRatio * (second?.score ?? 0) && first.matched.length >= CONFIG.minMatchedTerms;
  const candidates = top.map(toMatch);
  return { status: confident ? 'recommended' : 'candidates', recommended: confident ? candidates[0] : null, candidates };
}

export function recommendForProject(store: Store, projectPath: unknown, weights: Settings['weights']): RecommendResult {
  const readmePath = findReadme(projectPath);
  const info = extractReadme(readFileSync(readmePath, 'utf8'), basename(projectPath as string));
  const keywords = termWeights(info);
  return {
    readmePath,
    summary: { title: info.title, intro: info.intro, features: info.features },
    keywords: keywords.slice(0, 10).map(({ term, weight }) => ({ term, weight })),
    ...matchSkills(store, keywords, weights),
  };
}

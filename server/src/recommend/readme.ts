import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { Store } from '../db/store.ts';
import { koreanTerm } from '../search/koreanTerms.ts';
import { freshInstalls, freshness, matchTokens, popularity, stem, totalScore, TRUST_SCORE, trustTier } from '../search/rank.ts';
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
  /** A skill counts as similar when its score is at least this share of the best match… */
  similarFloor: 0.35,
  /** …and it shares at least this many words with the README (fewer only if the best match does). */
  minSharedWords: 2,
  /** FTS hits re-scored per request. */
  poolSize: 300,
  maxResults: 50,
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
  feature features overview introduction intro about faq support through within without`.split(/\s+/),
);

/** Code-block languages of install/run snippets: every README has them, they say nothing about the project. */
const SHELL_LANGS = new Set('bash sh shell zsh fish console terminal cmd bat powershell ps ps1 pwsh shellsession sh-session text txt plaintext output log diff'.split(' '));

/** Established names that are written in camelCase but are one word ("TypeScript" is not about "type"/"script"). */
const COMPOUND_NAMES = new Set(
  `javascript typescript github gitlab bitbucket postgresql mysql mongodb graphql nodejs nextjs nuxtjs webpack youtube
  linkedin openai chatgpt powerpoint wordpress macos ios ipados iphone ipad vscode devops fastapi pytorch tensorflow
  numpy jupyter dynamodb firebase supabase tailwindcss sveltekit sqlite mariadb redis elasticsearch kubernetes
  cloudflare netlify vercel figma oauth jsonschema openapi markdown`.split(/\s+/),
);

/** camelCase pieces count half: they help (PptxMaker → pptx) but are often noise. */
const PART_FACTOR = 0.5;

const SPLIT = /[\n\r\p{Z}\p{P}\p{S}]+/u;

/** Each token with its weight factor: the whole token 1, camelCase pieces {@link PART_FACTOR}. */
function weightedTokens(text: string): Array<[string, number]> {
  return text
    .split(SPLIT)
    .filter(Boolean)
    .flatMap((tok): Array<[string, number]> => {
      if (COMPOUND_NAMES.has(tok.toLowerCase())) return [[tok, 1]];
      const parts = tok
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ') // XMLParser → XML Parser (a lookahead: `[A-Z]+` rescanned every capital)
        .split(' ');
      return parts.length > 1 ? [[tok, 1], ...parts.map((p): [string, number] => [p, PART_FACTOR])] : [[tok, 1]];
    });
}

/** Splits on spaces/punctuation; camelCase tokens keep the whole word and its parts (PptxMaker → PptxMaker, Pptx, Maker). */
export function tokenize(text: string): string[] {
  return weightedTokens(text).map(([t]) => t);
}

/** One raw token → lowercase English word(s), or null (short, number, stopword, or non-English without an alias). */
export function processTerm(raw: string): string[] | null {
  const t = raw.toLowerCase();
  if (t.length < 2 || STOP.has(t) || /^\d+$/.test(t)) return null;
  const alias = koreanTerm(t, true);
  if (alias) return alias;
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

const TAG = /<[^<>]*>/g;
// the closing #s are trimmed by atxText: `(.*?)\s*#*\s*$` backtracked over long runs of spaces and #s
const ATX = /^\s{0,3}(#{1,6})\s+(.*)$/;

/** An ATX heading's text without its closing #s ("## Setup ##" → "Setup"). */
function atxText(s: string): string {
  let end = s.trimEnd().length;
  while (end > 0 && s[end - 1] === '#') end--;
  return s.slice(0, end).trimEnd();
}

/**
 * Drops `<!-- … -->` comments; an unclosed one stays, as with the regex this replaces. A regex had to rescan
 * the rest of the file from every unclosed "<!--" (quadratic); indexOf moves forward only.
 */
function stripHtmlComments(s: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = s.indexOf('<!--', from);
    const close = open < 0 ? -1 : s.indexOf('-->', open + 4);
    if (close < 0) return out + s.slice(from);
    out += s.slice(from, open);
    from = close + 3;
  }
}

export type ReadmeInfo = { title: string; intro: string; features: string[]; headings: string[]; body: string[]; langs: string[] };

/**
 * Inline markdown → plain text: images (badges) and inline HTML dropped, links reduced to their text.
 * Bracket and tag contents exclude their own opening character, so a match that fails stops at the next
 * opener: with `[^\]]*` a README of "[" or "<" repeated (no closers) took quadratic time. A link target may
 * hold one level of parentheses (`wiki/Foo_(bar)`, `a_(1).svg`), each pair scanned once.
 */
function inlineText(s: string): string {
  return s
    .replace(/\[!\[[^[\]]*\]\((?:[^()]|\([^()]*\))*\)\]\((?:[^()]|\([^()]*\))*\)/g, ' ') // linked badge
    .replace(/!\[[^[\]]*\]\((?:[^()]|\([^()]*\))*\)/g, ' ') // image
    .replace(/!\[[^[\]]*\]\[[^[\]]*\]/g, ' ') // reference image
    .replace(/\[([^[\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1') // link
    .replace(/\[([^[\]]*)\]\[[^[\]]*\]/g, '$1') // reference link
    .replace(TAG, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ') // bare URLs ("https", "github", "com" are not topics)
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
  // HTML comments are maintainer notes, not content (one became the "intro" of react-markdown's README).
  const lines = stripHtmlComments(md.replace(/\r\n?/g, '\n')).split('\n');
  let section = '';
  let para: string[] = [];
  let list: string[] = [];

  const addText = (raw: string, html = false) => {
    const text = html ? inlineText(raw.replace(TAG, ' ')) : inlineText(raw);
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
      const lang = fence[2].toLowerCase();
      if (lang && !SHELL_LANGS.has(lang)) out.langs.push(lang);
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) {
        // code is not read
      }
      continue;
    }
    const atx = line.match(ATX);
    if (atx) {
      heading(atx[1].length, atxText(atx[2]));
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
    if (/^\s{0,3}\[[^\]]+\]:\s*\S/.test(line)) continue; // link reference definitions (badge URL lists)
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
    for (const [raw, factor] of weightedTokens(text)) {
      for (const term of processTerm(raw) ?? []) {
        const key = stem(term);
        const e = byKey.get(key) ?? { weight: 0, forms: new Map<string, number>() };
        e.weight += k * factor;
        e.forms.set(term, (e.forms.get(term) ?? 0) + k * factor);
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
  /** Other files read along with it (an agent file next to package.json, when there is no README). */
  alsoRead?: string[];
  summary: { title: string; intro: string; features: string[] };
  keywords: Array<{ term: string; weight: number }>;
  /** Skills similar to the README, most downloaded first (then stars). Empty when nothing is similar. */
  skills: SkillMatch[];
};

const ftsTerm = (t: string) => `"${t.replace(/"/g, '')}"`;
const byPopularity = (a: { installs: number | null; stars: number | null }, b: { installs: number | null; stars: number | null }) =>
  (b.installs ?? -1) - (a.installs ?? -1) || (b.stars ?? -1) - (a.stars ?? -1);

/**
 * README keywords → similar skills in the local index, ordered by popularity (user decision: downloads,
 * then stars; how closely a skill matches only decides whether it is "similar" at all).
 * FTS (porter) fetches every skill that shares a word; each gets Σ log2(1 + weight) × idf over the shared
 * words (×2 in the name). Similar = at least {@link CONFIG.similarFloor} of the best score and sharing
 * {@link CONFIG.minSharedWords} words, so a lone common word ("api") does not let a popular unrelated skill in.
 */
export function matchSkills(store: Store, keywords: Keyword[], weights: Settings['weights']): SkillMatch[] {
  if (keywords.length === 0) return [];
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
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  if (scored.length === 0) return [];

  const best = scored[0];
  const minShared = Math.min(CONFIG.minSharedWords, best.matched.length);
  const similar = scored.filter((x) => x.score >= CONFIG.similarFloor * best.score && x.matched.length >= minShared);

  // One entry per skill name: the same skill is often republished elsewhere. Keep the trusted, most
  // installed copy.
  const lookup = storeLookup(store);
  const starsOf = (repo: string | null) => (repo ? (store.getRepo(repo)?.stars ?? null) : null);
  const trustOf = (s: (typeof scored)[number]['skill']) => TRUST_SCORE[trustTier(s, lookup.plugin(s.plugin_id))];
  const groups = new Map<string, typeof similar>();
  for (const x of similar) {
    const k = x.skill.name.toLowerCase().replace(/[\s_]+/g, '-');
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const unique = [...groups.values()]
    .map((g) => g.sort((a, b) => trustOf(b.skill) - trustOf(a.skill) || (freshInstalls(b.skill) ?? -1) - (freshInstalls(a.skill) ?? -1) || b.score - a.score)[0])
    .map((x) => ({ ...x, installs: freshInstalls(x.skill), stars: starsOf(x.skill.repo) }))
    .sort((a, b) => byPopularity(a, b) || b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, CONFIG.maxResults);

  const maxInstalls = Math.max(0, ...unique.map((x) => x.installs ?? 0));
  const maxStars = Math.max(0, ...unique.map((x) => x.stars ?? 0));
  return unique.map((x) => {
    const s = x.skill;
    const plugin = lookup.plugin(s.plugin_id);
    const breakdown = {
      R: x.score / best.score,
      P: popularity({ installs: x.installs, stars: x.stars }, maxInstalls, maxStars),
      F: freshness(s.last_commit_at),
      T: TRUST_SCORE[trustTier(s, plugin)],
    };
    const source = plugin ? marketplaceSource(s, plugin) : githubSource(s);
    const item = buildResultItem({
      skill: s,
      lookup,
      sources: source ? [source] : [],
      installs: x.installs,
      stars: x.stars,
      breakdown,
      score: totalScore(breakdown, weights),
    });
    return { item, score: Math.round(x.score * 100) / 100, matchedTerms: x.matched };
  });
}

/** Project description files read when there is no README, in this order (project review 2026-11-02). */
const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml'];

/** First `key = "value"` / `key = [ "a", "b" ]` of a TOML file; enough for a description and keywords. */
function tomlValue(text: string, key: string): string | string[] | null {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"\\n]*)"|\\[([^\\]]*)\\])`, 'm'));
  if (!m) return null;
  return m[1] ?? [...(m[2] ?? '').matchAll(/"([^"\n]*)"/g)].map((x) => x[1]);
}

/**
 * A project without a README: its name, description and keywords from package.json, pyproject.toml or
 * Cargo.toml, as a small markdown the README reader understands. Null when none has a description or keywords.
 */
export function manifestAsReadme(projectPath: string): { path: string; md: string } | null {
  for (const name of MANIFESTS) {
    const path = join(projectPath, name);
    let text: string;
    try {
      if (statSync(path).size > CONFIG.maxReadmeBytes) continue;
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let title: unknown;
    let description: unknown;
    let keywords: unknown;
    if (name.endsWith('.json')) {
      try {
        ({ name: title, description, keywords } = JSON.parse(text) as Record<string, unknown>);
      } catch {
        continue;
      }
    } else {
      title = tomlValue(text, 'name');
      description = tomlValue(text, 'description');
      keywords = tomlValue(text, 'keywords');
    }
    const words = Array.isArray(keywords) ? keywords.filter((k): k is string => typeof k === 'string') : [];
    if (typeof description !== 'string' && !words.length) continue;
    const md = [`# ${typeof title === 'string' ? title : basename(projectPath)}`, '', typeof description === 'string' ? description : '', '', ...(words.length ? ['## Features', ...words.map((k) => `- ${k}`)] : [])].join('\n');
    return { path, md };
  }
  return null;
}

/** Agent instruction files, read when there is no README (user decision 2026-11-02). */
const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md', join('.claude', 'CLAUDE.md')];
// the first line `/init` writes: "This file provides guidance to Claude Code (claude.ai/code) when working with…"
const BOILERPLATE = /^.*\bthis file provides guidance to\b.*$/gim;
const GENERIC_TITLE = /^(?:claude|agents)(?:\.md)?$|^(?:repository|project|contributor|agent)s?\s+(?:guidelines|guide|instructions)$|^instructions$/i;

/**
 * An agent instructions file as README text. It is mostly commands, paths and rules, so inline code, `/init`'s
 * first line and the headings ("Build, Test, and Development Commands", "Commit & Pull Request Guidelines", which
 * as headings would weigh 3 and bring in git skills) are left out, and what is left counts as plain text. Its
 * title is kept when it names the project, not the file ("# CLAUDE.md", "# Repository Guidelines").
 */
export function agentFileAsReadme(projectPath: string): { path: string; md: string; title: string | null } | null {
  for (const name of AGENT_FILES) {
    const path = join(projectPath, name);
    let text: string;
    try {
      if (statSync(path).size > CONFIG.maxReadmeBytes) continue;
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let title: string | null = null;
    const md = text
      .replace(/\r\n?/g, '\n')
      .replace(BOILERPLATE, '')
      .replace(/`[^`\n]*`/g, ' ')
      .split('\n')
      .map((line) => {
        const h = line.match(ATX);
        if (!h) return line;
        const t = atxText(h[2]).trim();
        if (h[1].length === 1 && title == null && t && !GENERIC_TITLE.test(t)) title = t;
        return ''; // a heading still ends the paragraph above it
      })
      .join('\n')
      .trim();
    if (md) return { path, md, title };
  }
  return null;
}

/**
 * `exclude`: keywords turned off on the page (their surface form); `extra`: words added there, weighted like the
 * strongest keyword so they count (project review 2026-11-02).
 */
export function recommendForProject(store: Store, projectPath: unknown, weights: Settings['weights'], opts: { exclude?: string[]; extra?: string[] } = {}): RecommendResult {
  let source: { path: string; md: string; also?: string[] };
  try {
    const readmePath = findReadme(projectPath);
    source = { path: readmePath, md: readFileSync(readmePath, 'utf8') };
  } catch (err) {
    if (!(err instanceof ReadmeError) || err.code !== 'README_NOT_FOUND') throw err;
    // no README: the manifest's name, description and keywords lead, the agent file adds the rest as plain text
    const manifest = manifestAsReadme(projectPath as string);
    const agent = agentFileAsReadme(projectPath as string);
    if (manifest && agent) source = { path: manifest.path, md: `${manifest.md}\n\n${agent.md}`, also: [agent.path] };
    else if (manifest) source = manifest;
    else if (agent) source = { path: agent.path, md: agent.title ? `# ${agent.title}\n\n${agent.md}` : agent.md };
    // nothing to read: the words typed on the page are the whole description (readmePath '' says so)
    else if (opts.extra?.length) source = { path: '', md: '' };
    else throw new ReadmeError('README_NOT_FOUND', '폴더 바로 아래에 README도, 설명이 있는 package.json·pyproject.toml·Cargo.toml도, CLAUDE.md·AGENTS.md도 없습니다.');
  }
  const info = extractReadme(source.md, basename(projectPath as string));
  const off = new Set((opts.exclude ?? []).map((t) => t.toLowerCase()));
  // words only: the folder name shown as the title is not a keyword ("skill finder" made "finder" one)
  let keywords = termWeights(source.path ? info : { ...info, title: '' }).filter((k) => !off.has(k.term.toLowerCase()));
  const top = keywords[0]?.weight ?? CONFIG.weights.title;
  for (const word of opts.extra ?? []) {
    for (const term of processTerm(word.trim()) ?? []) {
      const key = stem(term);
      // an added word switched off on the page is left out like any other
      if (off.has(term.toLowerCase()) || off.has(word.trim().toLowerCase())) continue;
      if (!keywords.some((k) => k.key === key)) keywords = [{ key, term, weight: top }, ...keywords];
    }
  }
  keywords = keywords.slice(0, CONFIG.maxQueryTerms);
  return {
    readmePath: source.path,
    ...(source.also ? { alsoRead: source.also } : {}),
    summary: { title: info.title, intro: info.intro, features: info.features },
    keywords: keywords.slice(0, 10).map(({ term, weight }) => ({ term, weight })),
    skills: matchSkills(store, keywords, weights),
  };
}

import { matchTokens, stem } from './rank.ts';

/** Result categories for the search sidebar. Korean labels live in the web app (labels.ts). */
export const CATEGORIES = ['testing', 'review', 'git', 'ops', 'security', 'data', 'docs', 'design', 'ai', 'productivity', 'business', 'dev', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Keyword rules, no AI: a strong keyword scores 1, a weak one (common in unrelated descriptions) 0.5,
 * doubled when it is in the skill name. Words are stemmed with the search stemmer so "tests"/"testing"
 * and "test" line up.
 */
const RULES: Array<{ cat: Category; strong: string; weak?: string }> = [
  { cat: 'testing', strong: 'test testing tests e2e playwright cypress jest vitest pytest mocha unittest coverage qa tdd mock mocks', weak: 'assertion fixture' },
  { cat: 'review', strong: 'review reviewer lint linter eslint refactor refactoring smell smells', weak: 'quality clean cleanup readability' },
  { cat: 'git', strong: 'git github gitlab commit commits branch branches merge rebase pr changelog worktree', weak: 'release issue issues' },
  {
    cat: 'ops',
    strong:
      'deploy deployment docker dockerfile container kubernetes k8s helm aws gcp azure terraform ansible ci cd devops infrastructure infra serverless vercel netlify cloudflare monitoring observability sentry datadog grafana prometheus incident sre nginx',
    weak: 'cloud pipeline server log logs logging',
  },
  {
    cat: 'security',
    strong: 'security secure vulnerability vulnerabilities owasp cve authentication oauth secret secrets encryption threat pentest penetration exploit malware xss csrf compliance',
    weak: 'auth audit',
  },
  {
    cat: 'data',
    strong: 'database sql postgres postgresql mysql sqlite mongodb redis supabase prisma migration migrations analytics csv pandas etl warehouse bigquery snowflake dbt dashboard visualization statistics',
    weak: 'data query queries schema chart charts analysis',
  },
  {
    cat: 'docs',
    strong: 'pdf docx document documents documentation readme excel xlsx pptx powerpoint slide slides presentation markdown blog article copywriting spreadsheet translate translation resume',
    weak: 'writing write content report reports docs',
  },
  {
    cat: 'design',
    // "design" is weak: "designed to …" (same stem) is common filler in descriptions.
    strong: 'ui ux figma css tailwind styling theme accessibility a11y brand branding logo typography illustration animation canva responsive frontend landing',
    weak: 'design designer style layout component components color colors icon icons',
  },
  { cat: 'ai', strong: 'llm llms subagent subagents prompt prompts mcp rag embedding embeddings openai anthropic gpt gemini chatbot eval evals', weak: 'agent agents ai model models' },
  {
    cat: 'productivity',
    strong: 'productivity email gmail calendar meeting meetings notion obsidian slack jira linear asana todo standup',
    weak: 'note notes task tasks project planning plan schedule workflow automation organize',
  },
  {
    cat: 'business',
    strong: 'seo marketing sales crm finance financial accounting legal contract contracts ecommerce shopify stripe payment payments pricing invoice recruiting',
    weak: 'customer customers support ads growth product startup',
  },
  {
    cat: 'dev',
    strong:
      'typescript javascript python rust golang java kotlin swift ruby php node nodejs react vue angular svelte nextjs django flask rails spring api apis backend debug debugging bug bugs cli sdk mobile ios android flutter',
    weak: 'library framework architecture implement implementation function',
  },
];

const KEYWORDS = new Map<string, Array<{ cat: Category; w: number }>>();
for (const r of RULES) {
  for (const [words, w] of [
    [r.strong, 1],
    [r.weak ?? '', 0.5],
  ] as const) {
    for (const word of words.split(' ').filter(Boolean)) {
      const key = stem(word);
      const list = KEYWORDS.get(key) ?? [];
      if (!list.some((x) => x.cat === r.cat)) list.push({ cat: r.cat, w });
      KEYWORDS.set(key, list);
    }
  }
}

/** Marketplace `category` values seen in the index. Generic ones only count when no keyword matches. */
const MARKETPLACE_SPECIFIC: Record<string, Category> = {
  productivity: 'productivity',
  automation: 'productivity',
  database: 'data',
  math: 'data',
  migration: 'data',
  monitoring: 'ops',
  deployment: 'ops',
  security: 'security',
  design: 'design',
  testing: 'testing',
  finance: 'business',
};
const MARKETPLACE_GENERIC: Record<string, Category> = { development: 'dev', 'developer tools': 'dev' };

const MAX_CATEGORIES = 2;

type CategorizeInput = { name: string; description?: string | null; whenToUse?: string | null; marketplaceCategory?: string | null };

/**
 * categorize for a skill row, remembered while the row lives: one search builds the same skill's card on every
 * early-cards pass and in each results pass. Worked out again when any input differs from the remembered one.
 */
const byRow = new WeakMap<object, { input: CategorizeInput; out: Category[] }>();
export function categorizeRow(row: object, skill: CategorizeInput): Category[] {
  const hit = byRow.get(row);
  if (hit) {
    const was = hit.input;
    if (was.name === skill.name && was.description === skill.description && was.whenToUse === skill.whenToUse && was.marketplaceCategory === skill.marketplaceCategory) {
      return [...hit.out];
    }
  }
  const out = categorize(skill);
  byRow.set(row, { input: { ...skill }, out });
  return [...out];
}

export function categorize(skill: CategorizeInput): Category[] {
  const scores = new Map<Category, number>();
  const name = new Set(matchTokens(skill.name.replace(/[-_.]+/g, ' ')));
  const text = new Set(matchTokens([skill.description ?? '', skill.whenToUse ?? ''].join(' ')));
  for (const token of new Set([...name, ...text])) {
    for (const { cat, w } of KEYWORDS.get(token) ?? []) scores.set(cat, (scores.get(cat) ?? 0) + w * (name.has(token) ? 2 : 1));
  }

  const mp = skill.marketplaceCategory?.trim().toLowerCase() ?? '';
  const out: Category[] = [];
  if (MARKETPLACE_SPECIFIC[mp]) out.push(MARKETPLACE_SPECIFIC[mp]);
  const ranked = [...scores].filter(([, s]) => s >= 1).sort((a, b) => b[1] - a[1] || CATEGORIES.indexOf(a[0]) - CATEGORIES.indexOf(b[0]));
  // A second category must be more than half as strong as the first: one stray word in the
  // description ("encrypting" in the pdf skill) should not add 보안 next to a name match.
  const top = ranked[0]?.[1] ?? 0;
  for (const [c, s] of ranked) if (out.length < MAX_CATEGORIES && !out.includes(c) && (s === top || s > top / 2)) out.push(c);
  if (out.length === 0) out.push(MARKETPLACE_GENERIC[mp] ?? 'other');
  return out;
}

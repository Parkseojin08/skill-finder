import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * Technology stack of a project (F21, feature review 2026-11-04), from its manifest files and a few marker files,
 * no AI and nothing sent anywhere: the README recommendation matched README words only, so a project whose README
 * never says "Next.js" or "Prisma" got no skills for them although its package.json lists both.
 *
 * Read: the project folder and its direct subfolders (a monorepo's web/ and server/), regular files only (no
 * symlinks, so nothing outside the project), each up to {@link MAX_FILE_BYTES}. Every parser is a single pass over
 * lines with patterns that cannot backtrack across a line (D#4de9).
 */

export const MAX_FILE_BYTES = 512 * 1024;
/** Subfolders looked into at most (the first ones by name). */
const MAX_SUBDIRS = 40;
/** Tags returned at most (libraries and tools before languages, then most evidence first). */
export const MAX_TAGS = 20;
/** Folders that hold other people's code or build output, never the project's own manifests. */
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', 'venv', '.venv', 'env', '__pycache__', 'site-packages', 'bower_components', 'tmp', 'temp']);

export type StackTag = {
  /** Shown on the chip ("Next.js"). */
  tag: string;
  /** Where it was seen ("web/package.json: next", "Dockerfile"). */
  evidence: string[];
};

/** A dictionary entry: the tag, the words a skill description uses for it (a space = a phrase), and how it is found. */
type Tech = { tag: string; terms: string[]; deps?: string[]; broad?: boolean };

/**
 * About 150 dependency names → tags. A name ending in "/" is a scope or module-path prefix ("@aws-sdk/",
 * "github.com/aws/aws-sdk-go"). The same name in two ecosystems (redis in npm and PyPI) is one tag.
 */
const TECH: Tech[] = [
  // JavaScript and TypeScript frameworks
  { tag: 'React', terms: ['react'], deps: ['react', 'react-dom', 'preact'] },
  { tag: 'Next.js', terms: ['nextjs', 'next js'], deps: ['next'] },
  { tag: 'Vue', terms: ['vue', 'vuejs'], deps: ['vue'] },
  { tag: 'Nuxt', terms: ['nuxt'], deps: ['nuxt'] },
  { tag: 'Svelte', terms: ['svelte', 'sveltekit'], deps: ['svelte', '@sveltejs/kit'] },
  { tag: 'Angular', terms: ['angular'], deps: ['@angular/core'] },
  { tag: 'Astro', terms: ['astro'], deps: ['astro'] },
  { tag: 'Remix', terms: ['remix'], deps: ['@remix-run/react', '@remix-run/node', '@react-router/dev'] },
  { tag: 'SolidJS', terms: ['solidjs'], deps: ['solid-js'] },
  { tag: 'Express', terms: ['expressjs', 'express js'], deps: ['express'] },
  { tag: 'Fastify', terms: ['fastify'], deps: ['fastify'] },
  { tag: 'NestJS', terms: ['nestjs'], deps: ['@nestjs/core'] },
  { tag: 'Hono', terms: ['hono'], deps: ['hono'] },
  { tag: 'Koa', terms: ['koa'], deps: ['koa'] },
  { tag: 'React Native', terms: ['react native'], deps: ['react-native'] },
  { tag: 'Expo', terms: ['expo'], deps: ['expo'] },
  { tag: 'Electron', terms: ['electron'], deps: ['electron'] },
  { tag: 'Tauri', terms: ['tauri'], deps: ['@tauri-apps/api', '@tauri-apps/cli', 'tauri'] },
  { tag: 'Three.js', terms: ['threejs', 'three js'], deps: ['three', '@react-three/fiber'] },
  { tag: 'D3', terms: ['d3'], deps: ['d3'] },
  { tag: 'Charts', terms: ['chartjs', 'recharts', 'echarts'], deps: ['chart.js', 'recharts', 'echarts', 'apexcharts'] },
  { tag: 'Redux', terms: ['redux'], deps: ['redux', '@reduxjs/toolkit'] },
  { tag: 'TanStack Query', terms: ['tanstack', 'react query'], deps: ['@tanstack/react-query'] },
  { tag: 'jQuery', terms: ['jquery'], deps: ['jquery'] },
  // styling and UI kits
  { tag: 'Tailwind CSS', terms: ['tailwind', 'tailwindcss'], deps: ['tailwindcss', '@tailwindcss/vite', '@tailwindcss/postcss'] },
  { tag: 'shadcn/ui', terms: ['shadcn'], deps: ['shadcn', 'shadcn-ui'] },
  { tag: 'Radix UI', terms: ['radix'], deps: ['@radix-ui/'] },
  { tag: 'Material UI', terms: ['mui', 'material ui'], deps: ['@mui/material'] },
  { tag: 'Chakra UI', terms: ['chakra'], deps: ['@chakra-ui/react'] },
  { tag: 'styled-components', terms: ['styled components'], deps: ['styled-components', '@emotion/react'] },
  { tag: 'Sass', terms: ['sass', 'scss'], deps: ['sass', 'node-sass'] },
  // build and tooling
  { tag: 'TypeScript', terms: ['typescript'], deps: ['typescript'], broad: true },
  { tag: 'Vite', terms: ['vite'], deps: ['vite'] },
  { tag: 'webpack', terms: ['webpack'], deps: ['webpack'] },
  { tag: 'esbuild', terms: ['esbuild'], deps: ['esbuild'] },
  { tag: 'Turborepo', terms: ['turborepo', 'monorepo'], deps: ['turbo'] },
  { tag: 'Nx', terms: ['nx', 'monorepo'], deps: ['nx'] },
  { tag: 'ESLint', terms: ['eslint'], deps: ['eslint'] },
  { tag: 'Prettier', terms: ['prettier'], deps: ['prettier'] },
  { tag: 'Biome', terms: ['biome'], deps: ['@biomejs/biome'] },
  // testing
  { tag: 'Jest', terms: ['jest'], deps: ['jest', 'ts-jest'] },
  { tag: 'Vitest', terms: ['vitest'], deps: ['vitest'] },
  { tag: 'Mocha', terms: ['mocha'], deps: ['mocha'] },
  { tag: 'Playwright', terms: ['playwright'], deps: ['playwright', '@playwright/test', 'pytest-playwright'] },
  { tag: 'Cypress', terms: ['cypress'], deps: ['cypress'] },
  { tag: 'Testing Library', terms: ['testing library'], deps: ['@testing-library/react', '@testing-library/vue', '@testing-library/dom'] },
  { tag: 'Storybook', terms: ['storybook'], deps: ['storybook', '@storybook/'] },
  { tag: 'Puppeteer', terms: ['puppeteer'], deps: ['puppeteer'] },
  { tag: 'Selenium', terms: ['selenium'], deps: ['selenium-webdriver', 'selenium'] },
  { tag: 'pytest', terms: ['pytest'], deps: ['pytest'] },
  { tag: 'RSpec', terms: ['rspec'], deps: ['rspec', 'rspec-rails'] },
  // data
  { tag: 'Prisma', terms: ['prisma'], deps: ['prisma', '@prisma/client'] },
  { tag: 'Drizzle', terms: ['drizzle'], deps: ['drizzle-orm', 'drizzle-kit'] },
  { tag: 'TypeORM', terms: ['typeorm'], deps: ['typeorm'] },
  { tag: 'Sequelize', terms: ['sequelize'], deps: ['sequelize'] },
  { tag: 'Knex', terms: ['knex'], deps: ['knex'] },
  { tag: 'MongoDB', terms: ['mongodb', 'mongoose'], deps: ['mongodb', 'mongoose', 'pymongo', 'motor'] },
  { tag: 'PostgreSQL', terms: ['postgres', 'postgresql'], deps: ['pg', 'postgres', 'psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'github.com/lib/pq', 'github.com/jackc/pgx/'] },
  { tag: 'MySQL', terms: ['mysql'], deps: ['mysql', 'mysql2', 'pymysql', 'mysqlclient', 'github.com/go-sql-driver/mysql'] },
  { tag: 'SQLite', terms: ['sqlite'], deps: ['sqlite3', 'better-sqlite3', 'sqlite', 'rusqlite'] },
  { tag: 'Redis', terms: ['redis'], deps: ['redis', 'ioredis', 'github.com/redis/go-redis/', 'github.com/go-redis/redis/'] },
  { tag: 'Supabase', terms: ['supabase'], deps: ['@supabase/supabase-js', 'supabase'] },
  { tag: 'Firebase', terms: ['firebase'], deps: ['firebase', 'firebase-admin'] },
  { tag: 'GraphQL', terms: ['graphql'], deps: ['graphql', '@apollo/client', '@apollo/server', 'graphene', 'strawberry-graphql'] },
  { tag: 'tRPC', terms: ['trpc'], deps: ['@trpc/server', '@trpc/client'] },
  { tag: 'SQLAlchemy', terms: ['sqlalchemy'], deps: ['sqlalchemy'] },
  { tag: 'Alembic', terms: ['alembic'], deps: ['alembic'] },
  { tag: 'pandas', terms: ['pandas'], deps: ['pandas'] },
  { tag: 'Polars', terms: ['polars'], deps: ['polars'] },
  { tag: 'NumPy', terms: ['numpy'], deps: ['numpy'] },
  { tag: 'SciPy', terms: ['scipy'], deps: ['scipy'] },
  { tag: 'Jupyter', terms: ['jupyter'], deps: ['jupyter', 'jupyterlab', 'notebook', 'ipykernel'] },
  { tag: 'matplotlib', terms: ['matplotlib', 'seaborn'], deps: ['matplotlib', 'seaborn'] },
  { tag: 'Plotly', terms: ['plotly'], deps: ['plotly'] },
  { tag: 'Streamlit', terms: ['streamlit'], deps: ['streamlit'] },
  { tag: 'Gradio', terms: ['gradio'], deps: ['gradio'] },
  { tag: 'dbt', terms: ['dbt'], deps: ['dbt-core'] },
  { tag: 'Airflow', terms: ['airflow'], deps: ['apache-airflow'] },
  { tag: 'Spark', terms: ['spark', 'pyspark'], deps: ['pyspark'] },
  { tag: 'Excel', terms: ['excel', 'xlsx'], deps: ['exceljs', 'xlsx', 'openpyxl', 'xlsxwriter'] },
  { tag: 'PDF', terms: ['pdf'], deps: ['pdf-lib', 'pdfkit', 'pdfjs-dist', 'pypdf', 'pypdf2', 'pdfplumber', 'reportlab'] },
  { tag: 'Word', terms: ['docx'], deps: ['docx', 'python-docx'] },
  // AI
  { tag: 'OpenAI API', terms: ['openai'], deps: ['openai'] },
  { tag: 'Claude API', terms: ['anthropic', 'claude api'], deps: ['@anthropic-ai/sdk', 'anthropic', '@anthropic-ai/claude-agent-sdk', 'claude-agent-sdk'] },
  { tag: 'LangChain', terms: ['langchain'], deps: ['langchain', '@langchain/', 'langchain-core', 'langgraph', '@langchain/langgraph'] },
  { tag: 'LlamaIndex', terms: ['llamaindex'], deps: ['llamaindex', 'llama-index'] },
  { tag: 'AI SDK', terms: ['ai sdk'], deps: ['ai', '@ai-sdk/'] },
  { tag: 'MCP', terms: ['mcp'], deps: ['@modelcontextprotocol/sdk', 'mcp', 'fastmcp'] },
  { tag: 'PyTorch', terms: ['pytorch'], deps: ['torch', 'pytorch-lightning', 'lightning'] },
  { tag: 'TensorFlow', terms: ['tensorflow'], deps: ['tensorflow', 'keras', '@tensorflow/tfjs'] },
  { tag: 'Hugging Face', terms: ['huggingface', 'hugging face'], deps: ['transformers', 'datasets', '@huggingface/inference', 'huggingface-hub'] },
  { tag: 'scikit-learn', terms: ['scikit', 'sklearn'], deps: ['scikit-learn', 'sklearn'] },
  { tag: 'MLflow', terms: ['mlflow'], deps: ['mlflow'] },
  { tag: 'OpenCV', terms: ['opencv'], deps: ['opencv-python', 'opencv-python-headless', 'opencv4nodejs'] },
  // Python web
  { tag: 'Django', terms: ['django'], deps: ['django', 'djangorestframework'] },
  { tag: 'Flask', terms: ['flask'], deps: ['flask'] },
  { tag: 'FastAPI', terms: ['fastapi'], deps: ['fastapi'] },
  { tag: 'Pydantic', terms: ['pydantic'], deps: ['pydantic'] },
  { tag: 'Celery', terms: ['celery'], deps: ['celery'] },
  { tag: 'Web scraping', terms: ['scraping', 'scraper'], deps: ['beautifulsoup4', 'scrapy', 'cheerio', 'crawlee'] },
  { tag: 'Ruff', terms: ['ruff'], deps: ['ruff'] },
  { tag: 'mypy', terms: ['mypy'], deps: ['mypy'] },
  // Go
  { tag: 'Gin', terms: ['gin'], deps: ['github.com/gin-gonic/gin'] },
  { tag: 'Echo', terms: ['echo framework'], deps: ['github.com/labstack/echo/'] },
  { tag: 'Fiber', terms: ['gofiber', 'fiber framework'], deps: ['github.com/gofiber/fiber/'] },
  { tag: 'GORM', terms: ['gorm'], deps: ['gorm.io/gorm'] },
  { tag: 'Cobra', terms: ['cobra'], deps: ['github.com/spf13/cobra'] },
  { tag: 'gRPC', terms: ['grpc'], deps: ['google.golang.org/grpc', 'grpcio', '@grpc/grpc-js', 'tonic'] },
  { tag: 'Kubernetes', terms: ['kubernetes', 'k8s'], deps: ['k8s.io/client-go', '@kubernetes/client-node', 'kubernetes'] },
  // Rust
  { tag: 'Tokio', terms: ['tokio'], deps: ['tokio'] },
  { tag: 'Axum', terms: ['axum'], deps: ['axum'] },
  { tag: 'Actix', terms: ['actix'], deps: ['actix-web'] },
  { tag: 'clap', terms: ['clap'], deps: ['clap'] },
  { tag: 'Bevy', terms: ['bevy'], deps: ['bevy'] },
  { tag: 'Diesel', terms: ['diesel'], deps: ['diesel'] },
  { tag: 'SQLx', terms: ['sqlx'], deps: ['sqlx'] },
  { tag: 'WebAssembly', terms: ['wasm', 'webassembly'], deps: ['wasm-bindgen', 'wasm-pack'] },
  // Ruby
  { tag: 'Ruby on Rails', terms: ['rails'], deps: ['rails'] },
  { tag: 'Sidekiq', terms: ['sidekiq'], deps: ['sidekiq'] },
  { tag: 'Devise', terms: ['devise'], deps: ['devise'] },
  // cloud and services
  { tag: 'AWS', terms: ['aws'], deps: ['aws-sdk', '@aws-sdk/', 'boto3', 'aws-cdk-lib', 'github.com/aws/aws-sdk-go', 'github.com/aws/aws-sdk-go-v2', 'aws-config'] },
  { tag: 'Google Cloud', terms: ['gcp', 'google cloud'], deps: ['@google-cloud/', 'google-cloud-storage', 'google-cloud-bigquery', 'cloud.google.com/go/'] },
  { tag: 'Azure', terms: ['azure'], deps: ['@azure/', 'azure-identity', 'azure-storage-blob'] },
  { tag: 'Vercel', terms: ['vercel'], deps: ['vercel', '@vercel/'] },
  { tag: 'Cloudflare', terms: ['cloudflare'], deps: ['wrangler', '@cloudflare/workers-types', '@cloudflare/'] },
  { tag: 'Stripe', terms: ['stripe'], deps: ['stripe', '@stripe/stripe-js'] },
  { tag: 'Sentry', terms: ['sentry'], deps: ['@sentry/', 'sentry-sdk'] },
  { tag: 'Slack', terms: ['slack'], deps: ['@slack/bolt', '@slack/web-api', 'slack-sdk', 'slack-bolt'] },
  { tag: 'Discord', terms: ['discord'], deps: ['discord.js', 'discord.py'] },
  { tag: 'WebSocket', terms: ['websocket'], deps: ['socket.io', 'ws', 'websockets'] },
  { tag: 'i18n', terms: ['i18n', 'localization'], deps: ['i18next', 'react-i18next', 'vue-i18n', 'next-intl'] },
  { tag: 'Auth', terms: ['authentication', 'oauth'], deps: ['next-auth', '@auth/core', 'passport', 'better-auth', '@clerk/nextjs'] },
  { tag: 'Zod', terms: ['zod'], deps: ['zod'] },
];

/** Tags found from files rather than dependencies, and the languages a manifest stands for. */
const FILE_TECH = {
  docker: { tag: 'Docker', terms: ['docker', 'dockerfile'] },
  compose: { tag: 'Docker Compose', terms: ['docker compose', 'docker'] },
  actions: { tag: 'GitHub Actions', terms: ['github actions'] },
  terraform: { tag: 'Terraform', terms: ['terraform'] },
  prisma: TECH.find((t) => t.tag === 'Prisma')!,
  typescript: TECH.find((t) => t.tag === 'TypeScript')!,
  node: { tag: 'Node.js', terms: ['nodejs', 'node js'], broad: true },
  python: { tag: 'Python', terms: ['python'], broad: true },
  go: { tag: 'Go', terms: ['golang'], broad: true },
  rust: { tag: 'Rust', terms: ['rust'], broad: true },
  ruby: { tag: 'Ruby', terms: ['ruby'], broad: true },
} satisfies Record<string, Tech> as Record<'docker' | 'compose' | 'actions' | 'terraform' | 'prisma' | 'typescript' | 'node' | 'python' | 'go' | 'rust' | 'ruby', Tech>;

const EXACT = new Map<string, Tech>();
const PREFIX: Array<[string, Tech]> = [];
for (const t of TECH) {
  for (const d of t.deps ?? []) {
    if (d.endsWith('/')) PREFIX.push([d, t]);
    else EXACT.set(d, t);
  }
}

/** The dictionary entry for a dependency name (case and PyPI's `_`/`.` folded), or null. */
export function techOf(dep: string): Tech | null {
  const d = dep.trim().toLowerCase();
  const py = d.replace(/[_.]+/g, '-');
  const hit = EXACT.get(d) ?? EXACT.get(py);
  if (hit) return hit;
  // a Go module path's major version suffix ("github.com/labstack/echo/v4") and scoped npm packages
  for (const [p, t] of PREFIX) if (d.startsWith(p) || `${d}/` === p) return t;
  return null;
}

/** Search words for a tag, by the tag shown ("Next.js" → nextjs, "next js"). */
export function stackTerms(tag: string): { terms: string[]; broad: boolean } | null {
  const t = TECH.find((x) => x.tag === tag) ?? Object.values(FILE_TECH).find((x) => x.tag === tag);
  return t ? { terms: t.terms, broad: !!t.broad } : null;
}

export const STACK_DICTIONARY_SIZE = TECH.length;

// ── parsers: line by line, nothing that backtracks over a long line ────────────────────────────────────────────

function packageJsonDeps(text: string): string[] {
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  if (!pkg || typeof pkg !== 'object') return [];
  const out: string[] = [];
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const v = (pkg as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...Object.keys(v));
  }
  return out;
}

const lines = (text: string) => text.split(/\r?\n/);
/** The package name at the start of a requirement ("Django>=4", "uvicorn[standard]", "pkg @ https://…"). */
const NAME = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;

function requirementsDeps(text: string): string[] {
  const out: string[] = [];
  for (const line of lines(text)) {
    const s = line.trimStart();
    if (!s || s.startsWith('#') || s.startsWith('-')) continue; // comments, -r other.txt, -e .
    const m = s.match(NAME);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Quoted strings of one line ("a>=1", 'b'); each quote starts one scan, so the line is read once. */
function quoted(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) out.push(m[1] ?? m[2]);
  return out;
}

function pyprojectDeps(text: string): string[] {
  const out: string[] = [];
  let section = '';
  let inArray = false;
  for (const line of lines(text)) {
    const header = line.match(/^\s*\[\[?([^\]\n]*)\]/);
    if (header && !inArray) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const keyed = section.startsWith('tool.poetry') && section.endsWith('dependencies');
    if (inArray || (!keyed && /^\s*[A-Za-z0-9_-]+\s*=\s*\[/.test(line) && /^(project|project\.optional-dependencies|dependency-groups)$/.test(section))) {
      // project.dependencies = ["a>=1", …], optional-dependencies and dependency groups, over one or more lines
      const key = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1]?.toLowerCase();
      if (inArray || section !== 'project' || key === 'dependencies') {
        const body: string = inArray ? line : line.slice(line.indexOf('[') + 1);
        for (const q of quoted(body)) {
          const m = q.match(NAME);
          if (m) out.push(m[1]);
        }
        inArray = !body.includes(']');
      }
      continue;
    }
    if (keyed) {
      const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (m && m[1].toLowerCase() !== 'python') out.push(m[1]);
    }
  }
  return out;
}

function goModDeps(text: string): string[] {
  const out: string[] = [];
  let block = false;
  for (const line of lines(text)) {
    const s = line.trim();
    if (block) {
      if (s.startsWith(')')) block = false;
      else if (s && !s.startsWith('//')) out.push(s.split(/\s+/)[0]);
      continue;
    }
    if (/^require\s*\($/.test(s)) block = true;
    else if (s.startsWith('require ')) out.push(s.slice(8).trim().split(/\s+/)[0]);
  }
  return out;
}

function cargoDeps(text: string): string[] {
  const out: string[] = [];
  let section = '';
  for (const line of lines(text)) {
    const header = line.match(/^\s*\[([^\]\n]*)\]/);
    if (header) {
      section = header[1].trim().toLowerCase();
      // [dependencies.tokio]
      const dotted = section.match(/(?:^|\.)(?:dev-|build-)?dependencies\.([a-z0-9_-]+)$/);
      if (dotted) out.push(dotted[1]);
      continue;
    }
    if (!/(?:^|\.)(?:dev-|build-)?dependencies$/.test(section)) continue;
    const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/);
    if (m) out.push(m[1]);
  }
  return out;
}

function gemfileDeps(text: string): string[] {
  const out: string[] = [];
  for (const line of lines(text)) {
    const m = line.match(/^\s*gem\s+["']([^"'\n]+)["']/);
    if (m) out.push(m[1]);
  }
  return out;
}

// ── reading the folder ───────────────────────────────────────────────────────────────────────────────────────

function readSmall(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const MANIFESTS: Array<{ test: (name: string) => boolean; parse: (text: string) => string[]; lang?: keyof typeof FILE_TECH }> = [
  { test: (n) => n === 'package.json', parse: packageJsonDeps, lang: 'node' },
  { test: (n) => /^requirements(?:[-_.][a-z0-9_-]+)?\.txt$/i.test(n), parse: requirementsDeps, lang: 'python' },
  { test: (n) => n === 'pyproject.toml', parse: pyprojectDeps, lang: 'python' },
  { test: (n) => n === 'go.mod', parse: goModDeps, lang: 'go' },
  { test: (n) => n === 'Cargo.toml', parse: cargoDeps, lang: 'rust' },
  { test: (n) => n === 'Gemfile', parse: gemfileDeps, lang: 'ruby' },
];

/**
 * The project's stack: tags with where each was seen, most evidence first (at most {@link MAX_TAGS}). `projectPath`
 * must already be checked to be an existing absolute folder (recommendForProject does).
 */
export function detectStack(projectPath: string): StackTag[] {
  const found = new Map<string, { tech: Tech; evidence: string[]; order: number }>();
  const note = (tech: Tech, evidence: string) => {
    const e = found.get(tech.tag) ?? { tech, evidence: [], order: found.size };
    if (!e.evidence.includes(evidence) && e.evidence.length < 6) e.evidence.push(evidence);
    found.set(tech.tag, e);
  };
  const root = entries(projectPath);
  const subdirs = root
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name.toLowerCase()) && (!e.name.startsWith('.') || e.name === '.github'))
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_SUBDIRS);

  const scan = (rel: string, list: Dirent[]) => {
    const at = (name: string) => (rel ? `${rel}/${name}` : name);
    for (const e of list) {
      if (!e.isFile()) continue; // symlinks and folders are not followed
      const name = e.name;
      const manifest = MANIFESTS.find((m) => m.test(name));
      if (manifest) {
        const text = readSmall(join(projectPath, rel, name));
        if (text == null) continue;
        const deps = [...new Set(manifest.parse(text))];
        const hits = deps.map((d) => [d, techOf(d)] as const).filter((x): x is readonly [string, Tech] => x[1] != null);
        for (const [d, tech] of hits) note(tech, `${at(name)}: ${d}`);
        if (manifest.lang) note(FILE_TECH[manifest.lang], at(name));
        continue;
      }
      if (/^Dockerfile(?:\..+)?$/i.test(name) || /\.dockerfile$/i.test(name)) note(FILE_TECH.docker, at(name));
      else if (/^(?:docker-)?compose(?:\.[a-z0-9_-]+)?\.ya?ml$/i.test(name)) note(FILE_TECH.compose, at(name));
      else if (/\.tf$/i.test(name)) note(FILE_TECH.terraform, at(name));
      else if (name === 'schema.prisma') note(FILE_TECH.prisma, at(name));
      else if (name === 'tsconfig.json') note(FILE_TECH.typescript, at(name));
    }
  };
  scan('', root);
  for (const d of subdirs) {
    if (d === '.github') {
      const wf = entries(join(projectPath, '.github', 'workflows')).filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name));
      if (wf.length) note(FILE_TECH.actions, `.github/workflows/${wf[0].name}${wf.length > 1 ? ` (+${wf.length - 1})` : ''}`);
      continue;
    }
    scan(d, entries(join(projectPath, d)));
  }
  return [...found.values()]
    // a language ("Python") says the least: it goes last, and is the first left out past the cap
    .sort((a, b) => Number(!!a.tech.broad) - Number(!!b.tech.broad) || b.evidence.length - a.evidence.length || a.order - b.order)
    .slice(0, MAX_TAGS)
    .map((e) => ({ tag: e.tech.tag, evidence: e.evidence }));
}

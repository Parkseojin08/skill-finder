// Feature review 2026-11-04, stage 2, the search and recommendation bundle (2-C): F16 (suggestions, recent searches),
// F17 (browsing the index on the first screen, first_seen_at), F21 (tech stack from manifests) and F23 (a) (the
// CLI's appUrl and `open`).
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import express from 'express';
import { createContext } from '../src/bootstrap.ts';
import type { AppContext } from '../src/context.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { recommendForProject } from '../src/recommend/readme.ts';
import { detectStack, MAX_FILE_BYTES, STACK_DICTIONARY_SIZE, techOf } from '../src/recommend/stack.ts';
import { browseRouter } from '../src/routes/browse.ts';
import { historyRouter } from '../src/routes/history.ts';
import { suggestRouter } from '../src/routes/suggest.ts';
import { browse, clearBrowseCache, FIRST_SEEN_SINCE_KEY, runFirstSeenFill, type BrowseList, type BrowseOverview } from '../src/search/browse.ts';
import { recentSearches } from '../src/search/history.ts';
import { bumpIndexGeneration } from '../src/search/indexGeneration.ts';
import { suggest } from '../src/search/suggest.ts';
import { securityMiddleware } from '../src/security.ts';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../src/settings.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sf-s2-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function newCtx(minStars = 0): AppContext {
  const ctx = createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmp, 'd-')), githubToken: null }, ':memory:');
  saveSettings(ctx.store, { ...getSettings(ctx.store), minStars });
  return ctx;
}

type SkillOpts = { body?: string; origin?: 'plugin' | 'generic'; pluginId?: string | null; installs?: number };
function addSkill(ctx: AppContext, repo: string, dir: string, name: string, description: string, o: SkillOpts = {}): string {
  const row = buildSkillRow({
    repo,
    sha: 'a'.repeat(40),
    dirPath: dir,
    raw: `---\nname: ${name}\ndescription: ${description}\n---\n${o.body ?? `Body of ${name}`}\n`,
    tree: new TreeIndex([]),
    origin: o.origin ?? 'generic',
    pluginId: o.pluginId ?? null,
    extraFlags: [],
    install: null,
    lastCommitAt: null,
  });
  ctx.store.upsertSkill(o.installs != null ? { ...row, installs: o.installs } : row, '');
  return row.id;
}
function stars(ctx: AppContext, full_name: string, n: number) {
  ctx.store.upsertRepo({ full_name, stars: n, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: new Date().toISOString() });
}
function plugin(ctx: AppContext, id: string, marketplace: string, repo: string) {
  const [name] = id.split('@');
  ctx.store.upsertPlugin({ id, marketplace, name, display_name: null, description: null, category: null, keywords: null, source_json: '"./"', source_kind: 'relative', repo, path: null, ref: null, sha: null, strict: null, entry_json: null });
}

/** The routes as app.ts will mount them (header and origin checks included). */
async function serve(ctx: AppContext) {
  const app = express();
  app.use(securityMiddleware(ctx.config));
  app.use('/api', suggestRouter(ctx), historyRouter(ctx), browseRouter(ctx));
  const server: Server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => done(s));
  });
  const port = (server.address() as AddressInfo).port;
  ctx.config.port = port;
  const get = async (path: string, header = true) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { headers: header ? { 'X-Skill-Finder': '1' } : {} });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { get, close: () => new Promise<void>((done) => server.close(() => done())) };
}

describe('F16 자동완성', () => {
  it('이름 앞부분과 낱말 경계로 찾고, 같은 이름이면 앞에, 그다음 별·다운로드 순', () => {
    const ctx = newCtx();
    addSkill(ctx, 'big/skills', 'pdf-tools', 'pdf-tools', 'Work with PDF files.');
    addSkill(ctx, 'small/kit', 'pdf', 'pdf', 'Read PDF files.');
    addSkill(ctx, 'mid/repo', 'nano-pdf', 'nano-pdf', 'Tiny PDF edits.');
    addSkill(ctx, 'mid/repo', 'xpdfx', 'xpdfx', 'Not a word start.');
    stars(ctx, 'big/skills', 50_000);
    stars(ctx, 'small/kit', 10);
    stars(ctx, 'mid/repo', 900);
    const got = suggest(ctx.store, 'PDF');
    assert.deepEqual(
      got.map((s) => `${s.kind}:${s.text}`),
      ['skill:pdf', 'skill:pdf-tools', 'skill:nano-pdf'],
      '정확히 같은 이름 먼저, 나머지는 별 순, 낱말 중간(xpdfx)은 아님',
    );
    assert.deepEqual(
      suggest(ctx.store, 'mid').map((s) => `${s.kind}:${s.text}:${s.count}`),
      ['owner:mid:2', 'repo:mid/repo:2'],
      '소유자와 owner/repo, 스킬 수',
    );
    assert.deepEqual(suggest(ctx.store, 'repo').map((s) => s.text), ['mid/repo'], '저장소 이름도 낱말 경계');
    assert.deepEqual(suggest(ctx.store, ''), []);
    assert.deepEqual(suggest(ctx.store, 'x'.repeat(101)), [], '너무 긴 입력');
  });

  it('최대 10개, 색인 세대가 바뀌면 다시 만든다', () => {
    const ctx = newCtx();
    for (let i = 0; i < 15; i++) addSkill(ctx, `o${i}/r`, `s${i}`, `alpha-${i}`, 'Alpha skill.');
    assert.equal(suggest(ctx.store, 'alpha').length, 10);
    addSkill(ctx, 'o/r', 'beta', 'beta-new', 'Beta.');
    assert.deepEqual(suggest(ctx.store, 'beta'), [], '같은 세대 안에서는 메모리 배열 그대로');
    bumpIndexGeneration(ctx.store);
    assert.equal(suggest(ctx.store, 'beta')[0]?.text, 'beta-new');
  });

  it('플러그인 이름도 제안한다', () => {
    const ctx = newCtx();
    plugin(ctx, 'commit-tools@claude-plugins-official', 'claude-plugins-official', 'acme/plugins');
    addSkill(ctx, 'acme/plugins', 'commit', 'commit-message', 'Write commit messages.', { origin: 'plugin', pluginId: 'commit-tools@claude-plugins-official' });
    const got = suggest(ctx.store, 'commit');
    assert.ok(got.some((s) => s.kind === 'plugin' && s.text === 'commit-tools' && s.marketplace === 'claude-plugins-official'));
  });

  it('512KB 입력도 바로 끝난다 (낱말 경계 계산은 길이에 비례)', () => {
    const ctx = newCtx();
    addSkill(ctx, 'o/r', 's', `${'a-'.repeat(30)}x`, 'Many word starts.');
    const t = Date.now();
    suggest(ctx.store, '-'.repeat(512 * 1024));
    suggest(ctx.store, 'a-'.repeat(50));
    assert.ok(Date.now() - t < 1000, `${Date.now() - t}ms`);
  });
});

describe('F16 최근 검색', () => {
  it('검색어마다 한 번, 최근 것 먼저; 기록을 끄면 빈 배열', () => {
    const ctx = newCtx();
    const log = (q: string, n: number) => ctx.store.logEvent('search', null, q, { n });
    log('pdf', 3);
    log('react performance', 12);
    log('PDF ', 5);
    ctx.store.logEvent('view', 'gh:o/r:s', 'pdf');
    const got = recentSearches(ctx.store, 5);
    assert.deepEqual(
      got.map((r) => [r.query, r.results]),
      [
        ['PDF', 5],
        ['react performance', 12],
      ],
    );
    saveSettings(ctx.store, { ...getSettings(ctx.store), searchLog: false });
    assert.deepEqual(recentSearches(ctx.store, 5), []);
  });

  it('GET /api/history·/api/suggest: 헤더가 필요하고, kind는 search만', async () => {
    const ctx = newCtx();
    ctx.store.logEvent('search', null, 'commit message', { n: 7 });
    addSkill(ctx, 'o/r', 's', 'commit-helper', 'Commits.');
    const srv = await serve(ctx);
    try {
      assert.equal((await srv.get('/history?kind=search', false)).status, 403);
      const h = await srv.get('/history?kind=search&limit=5');
      assert.equal(h.status, 200);
      assert.deepEqual(h.body.items.map((x: { query: string }) => x.query), ['commit message']);
      assert.equal((await srv.get('/history?kind=view')).status, 400);
      const s = await srv.get('/suggest?q=comm');
      assert.deepEqual(s.body.items.map((x: { text: string }) => x.text), ['commit-helper']);
      assert.deepEqual((await srv.get(`/suggest?q=${'a'.repeat(400)}`)).body.items, []);
    } finally {
      await srv.close();
    }
  });
});

describe('F17 둘러보기', () => {
  /** An index with each kind of card the first screen has. */
  function sample() {
    const ctx = newCtx(1000);
    plugin(ctx, 'testkit@claude-plugins-official', 'claude-plugins-official', 'partner/testkit');
    addSkill(ctx, 'partner/testkit', 'unit', 'unit-tests', 'Write unit tests with vitest.', { origin: 'plugin', pluginId: 'testkit@claude-plugins-official' });
    addSkill(ctx, 'partner/testkit', 'e2e', 'e2e-tests', 'End-to-end tests with playwright.', { origin: 'plugin', pluginId: 'testkit@claude-plugins-official' });
    addSkill(ctx, 'anthropics/skills', 'skills/pdf', 'pdf', 'Extract tables from PDF documents.');
    addSkill(ctx, 'popular/tests', 'jest', 'jest-helper', 'Jest test coverage reports.', { installs: 500 });
    addSkill(ctx, 'tiny/tests', 'mocha', 'mocha-runner', 'Mocha test runner.', { installs: 900_000 });
    addSkill(ctx, 'unknown/tests', 'tdd', 'tdd-coach', 'TDD testing coach.');
    // a copy of jest-helper's SKILL.md elsewhere: one card, downloads added
    addSkill(ctx, 'fork/tests', 'jest', 'jest-helper', 'Jest test coverage reports.', { installs: 100 });
    const risky = addSkill(ctx, 'popular/tests', 'danger', 'danger-test', 'Testing with remote scripts.');
    ctx.store.setSkillRiskLevel(risky, 'high');
    stars(ctx, 'popular/tests', 20_000);
    stars(ctx, 'fork/tests', 300);
    stars(ctx, 'tiny/tests', 3);
    stars(ctx, 'anthropics/skills', 100_000);
    return ctx;
  }

  it('첫 화면 칸: 카테고리 13개와 출처별·공식 컬렉션·플러그인 개수 (검색과 같은 별·위험 조건)', () => {
    const ctx = sample();
    const o = browse(ctx.store, { section: 'overview' }) as BrowseOverview;
    assert.equal(o.categories.length, 13);
    // unit-tests, e2e-tests (partner, stars exempt), jest-helper (one card for both copies); mocha (3 stars),
    // tdd-coach (stars unknown) and danger-test (high risk) are hidden
    assert.equal(o.categories.find((c) => c.key === 'testing')?.count, 3);
    assert.deepEqual(o.trust, [
      { key: 'official', count: 1 },
      { key: 'partner', count: 2 },
      { key: 'community', count: 0 },
    ]);
    assert.equal(o.anthropic, 1);
    assert.equal(o.plugins, 1);
    assert.equal(o.total, 4);
  });

  it('카테고리 목록: 다운로드 → 별 순, 사본은 한 장(다운로드 합), 숨긴 수', () => {
    const ctx = sample();
    const r = browse(ctx.store, { section: 'list', cat: 'testing' }) as BrowseList;
    assert.deepEqual(
      r.items.map((i) => i.name),
      ['jest-helper', 'e2e-tests', 'unit-tests'],
    );
    assert.equal(r.items[0].installs, 500, '별 기준 미만 사본(fork, 별 300)은 숨김이라 더하지 않음');
    assert.equal(r.hiddenHighRisk, 1);
    assert.equal(r.hiddenLowStars, 1, 'mocha(별 3); 같은 SKILL.md가 보이는 fork 사본은 세지 않음');
    assert.equal(r.hiddenUnknownStars, 1);
    assert.equal(r.total, 3);
    // without the star minimum: the copy adds its downloads, the suspicious count (900K with 3 stars) is unknown
    const lifted = browse(ctx.store, { section: 'list', cat: 'testing', minStars: 0 }) as BrowseList;
    const jest = lifted.items.find((i) => i.name === 'jest-helper')!;
    assert.equal(jest.installs, 600);
    const mocha = lifted.items.find((i) => i.name === 'mocha-runner')!;
    assert.equal(mocha.installs, undefined);
    assert.equal(mocha.installsSuspect?.installs, 900_000);
    assert.equal(lifted.items[0].name, 'jest-helper', '의심 다운로드는 정렬에서 모름');
    // the risk limit as in search
    const all = browse(ctx.store, { section: 'list', cat: 'testing', maxRisk: 'high' }) as BrowseList;
    assert.ok(all.items.some((i) => i.name === 'danger-test'));
  });

  it('출처·컬렉션·플러그인·저장소·소유자', () => {
    const ctx = sample();
    const names = (q: Parameters<typeof browse>[1]) => (browse(ctx.store, q) as BrowseList).items.map((i) => i.name);
    assert.deepEqual(names({ section: 'list', trust: 'partner' }).sort(), ['e2e-tests', 'unit-tests']);
    assert.deepEqual(names({ section: 'list', marketplace: 'claude-plugins-official' }).sort(), ['e2e-tests', 'unit-tests']);
    assert.deepEqual(names({ section: 'anthropic' }), ['pdf']);
    assert.equal(names({ section: 'plugins' }).length, 1, '플러그인마다 한 장');
    assert.equal((browse(ctx.store, { section: 'plugins' }) as BrowseList).items[0].plugin?.skillCount, 2);
    assert.deepEqual(names({ section: 'list', repo: 'Popular/Tests' }), ['jest-helper']);
    assert.deepEqual(names({ section: 'list', owner: 'tiny', minStars: 0 }), ['mocha-runner']);
  });

  it('페이지는 50개씩', () => {
    const ctx = newCtx(0);
    for (let i = 0; i < 120; i++) addSkill(ctx, `o/r${i}`, 's', `lint-${String(i).padStart(3, '0')}`, 'Lint and review code.');
    const p1 = browse(ctx.store, { section: 'list', cat: 'review' }) as BrowseList;
    const p3 = browse(ctx.store, { section: 'list', cat: 'review', page: 3 }) as BrowseList;
    assert.equal(p1.total, 120);
    assert.equal(p1.items.length, 50);
    assert.equal(p3.items.length, 20);
    assert.equal(p1.items[0].name, 'lint-000');
  });

  it('이번 주 새로 들어온: first_seen_at을 채우고, 추적 시작 하루 안(첫 색인)은 새것이 아니다', async () => {
    const ctx = newCtx(0);
    const firstSeen = (id: string) => (ctx.store.getSkill(id) as unknown as { first_seen_at: string | null }).first_seen_at;
    const old = addSkill(ctx, 'o/r', 'old', 'old-skill', 'An old skill.');
    const t0 = new Date('2026-11-01T00:00:00Z');
    // the first run: everything indexed so far is the first index
    assert.deepEqual((await runFirstSeenFill(ctx, t0)).counts, { filled: 1 });
    assert.equal(ctx.store.getSetting(FIRST_SEEN_SINCE_KEY), t0.toISOString());
    const fresh = addSkill(ctx, 'o/r', 'new', 'new-skill', 'A new skill.');
    assert.equal(firstSeen(fresh), null, '새 행은 NULL로 들어온다');
    const t1 = new Date('2026-11-03T00:00:00Z');
    assert.deepEqual((await runFirstSeenFill(ctx, t1)).counts, { filled: 1 });
    assert.deepEqual((await runFirstSeenFill(ctx, t1)).counts, { filled: 0 }, '다시 돌면 할 일 없음');
    // upsert keeps it (the column is not written by the store)
    addSkill(ctx, 'o/r', 'new', 'new-skill', 'A new skill, edited.');
    assert.equal(firstSeen(fresh), t1.toISOString());
    const at = Date.parse('2026-11-04T00:00:00Z');
    clearBrowseCache(ctx.store);
    const r = browse(ctx.store, { section: 'new' }, at) as BrowseList;
    assert.deepEqual(r.items.map((i) => i.id), [fresh]);
    assert.ok(!r.items.some((i) => i.id === old));
    assert.equal((browse(ctx.store, { section: 'overview' }, at) as BrowseOverview).newThisWeek, 1);
    // a week later it is no longer new
    clearBrowseCache(ctx.store);
    assert.equal((browse(ctx.store, { section: 'new' }, Date.parse('2026-11-11T00:00:00Z')) as BrowseList).total, 0);
  });

  it('GET /api/browse: 조건 검사, 조건 없으면 첫 화면', async () => {
    const ctx = sample();
    const srv = await serve(ctx);
    try {
      const o = await srv.get('/browse');
      assert.equal(o.body.section, 'overview');
      const c = await srv.get('/browse?cat=testing&page=1');
      assert.equal(c.body.section, 'list');
      assert.equal(c.body.items.length, 3);
      assert.equal((await srv.get('/browse?cat=nope')).status, 400);
      assert.equal((await srv.get('/browse?repo=a/b/c')).status, 400);
      assert.equal((await srv.get('/browse?minStars=5')).status, 400, '별 기준은 끄기(0)만');
      assert.equal((await srv.get('/browse?section=anthropic')).body.items[0].name, 'pdf');
      assert.equal((await srv.get('/browse?owner=tiny&minStars=0')).body.items[0].name, 'mocha-runner');
    } finally {
      await srv.close();
    }
  });
});

describe('F21 기술 스택 감지', () => {
  function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmp, 'proj-'));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return dir;
  }

  it('manifest·표지 파일에서 태그와 근거를 찾고, node_modules와 크기 넘는 파일은 읽지 않는다', () => {
    const dir = project({
      'package.json': JSON.stringify({ dependencies: { next: '15', '@prisma/client': '6' }, devDependencies: { '@playwright/test': '1', typescript: '5' } }),
      'web/package.json': JSON.stringify({ dependencies: { react: '19', '@aws-sdk/client-s3': '3' } }),
      'api/requirements.txt': '# deps\nDjango>=4.2\n-r base.txt\nuvicorn[standard]==0.30\n',
      'ml/pyproject.toml': '[project]\nname = "x"\ndependencies = [\n  "pandas>=2",\n  "torch",\n]\n[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = "^0.1"\n',
      'svc/go.mod': 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/labstack/echo/v4 v4.11.0\n)\n',
      'cli/Cargo.toml': '[package]\nname = "x"\n[dependencies]\ntokio = { version = "1" }\n[dependencies.axum]\nversion = "0.7"\n',
      'rb/Gemfile': "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n",
      Dockerfile: 'FROM node:22\n',
      'docker-compose.yml': 'services: {}\n',
      '.github/workflows/ci.yml': 'on: push\n',
      'infra/main.tf': 'terraform {}\n',
      'node_modules/vue/package.json': JSON.stringify({ dependencies: { vue: '3' } }),
      'big/package.json': JSON.stringify({ dependencies: { svelte: '5' }, pad: 'x'.repeat(MAX_FILE_BYTES) }),
    });
    const tags = detectStack(dir);
    const by = new Map(tags.map((t) => [t.tag, t.evidence]));
    for (const t of ['Next.js', 'Prisma', 'Playwright', 'React', 'AWS', 'Django', 'pandas', 'PyTorch', 'FastAPI', 'Gin', 'Echo', 'Tokio', 'Axum', 'Ruby on Rails', 'Docker', 'Docker Compose', 'GitHub Actions', 'Terraform']) {
      assert.ok(by.has(t), `${t} 없음: ${[...by.keys()].join(', ')}`);
    }
    assert.ok(tags.length <= 20);
    // languages (TypeScript, Node.js, Python, Go, Rust, Ruby) go last and are the ones the 20-tag cap drops
    assert.deepEqual(tags.slice(-2).map((t) => t.tag), ['Node.js', 'Python']);
    assert.deepEqual(by.get('Next.js'), ['package.json: next']);
    assert.deepEqual(by.get('React'), ['web/package.json: react']);
    assert.deepEqual(by.get('GitHub Actions'), ['.github/workflows/ci.yml']);
    assert.ok(!by.has('Vue'), 'node_modules는 건너뜀');
    assert.ok(!by.has('Svelte'), '크기 상한');
    assert.ok(!by.has('Uvicorn'));
    assert.ok(STACK_DICTIONARY_SIZE >= 120, `사전 ${STACK_DICTIONARY_SIZE}`);
    assert.equal(techOf('github.com/labstack/echo/v4')?.tag, 'Echo');
    assert.equal(techOf('scikit_learn')?.tag, 'scikit-learn');
    assert.equal(techOf('left-pad'), null);
  });

  it('README에 없는 의존성(Next.js)으로도 추천하고, 칩을 끄면 뺀다', () => {
    const ctx = newCtx(0);
    addSkill(ctx, 'o/r', 'next', 'app-router-guide', 'Best practices for Next.js app router pages.');
    addSkill(ctx, 'o/r', 'dash', 'dashboard-builder', 'Build an analytics dashboard with charts.');
    const dir = project({
      'README.md': '# Board\n\nA dashboard for the team.\n',
      'package.json': JSON.stringify({ dependencies: { next: '15' } }),
    });
    const r = recommendForProject(ctx.store, dir, DEFAULT_SETTINGS.weights);
    assert.deepEqual(
      r.stack.map((s) => s.tag),
      ['Next.js', 'Node.js'],
    );
    assert.ok(!r.keywords.some((k) => k.term === 'Next.js'), '스택은 키워드 칩에 따로 나오지 않음');
    const next = r.skills.find((m) => m.item.name === 'app-router-guide');
    assert.ok(next, r.skills.map((m) => m.item.name).join(','));
    assert.deepEqual(next.matchedTerms, ['Next.js']);
    const off = recommendForProject(ctx.store, dir, DEFAULT_SETTINGS.weights, { exclude: ['stack:next.js'] });
    assert.ok(!off.skills.some((m) => m.item.name === 'app-router-guide'));
    assert.equal(off.stack.find((s) => s.tag === 'Next.js')?.off, true);
  });

  it('README·설명 파일이 없어도 스택만으로 추천한다', () => {
    const ctx = newCtx(0);
    addSkill(ctx, 'o/r', 'tf', 'terraform-review', 'Review Terraform plans before apply.');
    const dir = project({ 'main.tf': 'terraform {}\n' });
    const r = recommendForProject(ctx.store, dir, DEFAULT_SETTINGS.weights);
    assert.equal(r.readmePath, '');
    assert.equal(r.skills[0]?.item.name, 'terraform-review');
  });

  it('512KB 악성 manifest도 바로 끝난다 (줄 단위, 되짚기 없음)', () => {
    const n = 512 * 1024 - 1024;
    const evil = {
      'requirements.txt': ' '.repeat(n),
      'pyproject.toml': `[project]\ndependencies = [${'"'.repeat(n / 2)}${"'".repeat(n / 2)}`,
      'a/pyproject.toml': `${'['.repeat(n)}\n${' '.repeat(n / 2)}x = [`,
      'go.mod': `require (\n${'\t'.repeat(n)}`,
      'Cargo.toml': `[${'dependencies.'.repeat(Math.floor(n / 13))}\n${'dependencies.'.repeat(Math.floor(n / 13))}`,
      'b/Cargo.toml': `[dependencies]\n${'a'.repeat(n)}`,
      Gemfile: `gem ${'"'.repeat(n)}`,
      'c/requirements.txt': `${'a-'.repeat(n / 2)}`,
    };
    const dir = project(evil);
    const t = Date.now();
    detectStack(dir);
    assert.ok(Date.now() - t < 2000, `${Date.now() - t}ms`);
    // and the phrase check of the matcher on a long description
    const ctx = newCtx(0);
    addSkill(ctx, 'o/r', 's', 'long', `Next.js ${'next js '.repeat(60_000)}`);
    const t2 = Date.now();
    recommendForProject(ctx.store, project({ 'package.json': '{"dependencies":{"next":"1"}}' }), DEFAULT_SETTINGS.weights);
    assert.ok(Date.now() - t2 < 2000, `${Date.now() - t2}ms`);
  });
});

describe('F23 (a) CLI appUrl·open', () => {
  const BIN = join(import.meta.dirname, '..', '..', 'bin', 'skill-finder.mjs');
  const dataDir = mkdtempSync(join(tmp, 'cli-'));
  const cli = (args: string[], cwd = tmp) =>
    new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, PORT: '', SKILL_FINDER_LANG: 'en', SKILL_FINDER_DATA_DIR: dataDir }, timeout: 20_000 }, (error, out, err) =>
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err }),
      );
    });
  /**
   * A folder as a process started in it sees it: the CLI's "this folder" is its process.cwd(). The OS answers with
   * links resolved on macOS and Linux (macOS keeps the temp folder under /var, a link to /private/var) and with the
   * path as it was given on Windows (an 8.3 short name or a junction stays), so neither the path mkdtemp returns nor
   * its realpath is the expected one on every OS.
   */
  const cwdIn = (dir: string) => execFileSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir, encoding: 'utf8' });
  const item = { id: 'gh:o/r:skills/pdf', name: 'pdf', description: 'PDF', riskLevel: 'low', riskFlags: [], install: { method: 'skills-cli', command: 'npx skills add' }, sources: [] };
  async function fakeApp() {
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url}`);
        const send = (b: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(b));
        if (req.url === '/api/health') return send({ app: 'skill-finder', pid: process.pid });
        if (req.url === '/api/search') return res.writeHead(200).end(`${JSON.stringify({ type: 'results', items: [item] })}\n${JSON.stringify({ type: 'done' })}\n`);
        if (req.url === `/api/skills/${encodeURIComponent(item.id)}`) return send(item);
        if (req.url === '/api/readme-skills')
          return send({ readmePath: 'C:/p/README.md', keywords: [{ term: 'pdf', weight: 3 }], stack: [{ tag: 'Next.js', evidence: ['package.json: next'] }], skills: [{ item, score: 1, matchedTerms: ['pdf'] }] });
        send({ error: '없는 스킬입니다' }, 404);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise<void>((done) => server.close(() => done())) };
  }

  it('결과마다 appUrl(설치 탭·프로젝트), open은 확인 창 주소만 열고 설치하지 않는다', async () => {
    const app = await fakeApp();
    const proj = mkdtempSync(join(tmp, 'here-'));
    try {
      // run in proj, the CLI names it as its own process sees it; a folder given as an argument stays as written
      const here = cwdIn(proj);
      const url = (project: string) => `http://127.0.0.1:${app.port}/skill?${new URLSearchParams({ id: item.id, tab: 'install', project })}`;
      const s = await cli(['search', 'pdf', '--port', String(app.port), '--json'], proj);
      assert.equal(s.code, 0, s.err);
      assert.equal(JSON.parse(s.out)[0].appUrl, url(here), '기본은 지금 폴더');
      const other = join(tmp, 'other');
      assert.equal(JSON.parse((await cli(['show', item.id, '--port', String(app.port), '--json', '--project', other])).out).appUrl, url(other));
      const text = await cli(['search', 'pdf', '--port', String(app.port)], proj);
      assert.ok(text.out.includes(`Install in the app: ${url(here)}`), text.out);

      const rec = JSON.parse((await cli(['recommend', proj, '--port', String(app.port), '--json'])).out);
      assert.deepEqual(rec.stack, [{ tag: 'Next.js', evidence: ['package.json: next'] }]);
      assert.equal(rec.skills[0].appUrl, url(proj));
      assert.match((await cli(['recommend', proj, '--port', String(app.port)])).out, /Detected stack: Next\.js/);

      const open = await cli(['open', item.id, '--port', String(app.port), '--no-open', '--json', '--project'], proj);
      assert.equal(open.code, 0, open.err);
      assert.deepEqual(JSON.parse(open.out), { id: item.id, appUrl: url(here), opened: false });
      const bare = JSON.parse((await cli(['open', item.id, '--port', String(app.port), '--no-open', '--json'], proj)).out);
      assert.equal(bare.appUrl, `http://127.0.0.1:${app.port}/skill?${new URLSearchParams({ id: item.id, tab: 'install' })}`, '--project 없으면 프로젝트 없이');
      const missing = await cli(['open', 'gh:o/r:nope', '--port', String(app.port), '--no-open']);
      assert.equal(missing.code, 1);
      assert.match(missing.err, /없는 스킬/);
      // only reads: no install or other state-changing call was made
      assert.ok(app.seen.every((x) => x.startsWith('GET ') || x === 'POST /api/search' || x === 'POST /api/readme-skills'), app.seen.join(', '));
    } finally {
      await app.close();
    }
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { extractReadme, findReadme, matchSkills, processTerm, recommendForProject, termWeights, tokenize, type RecommendResult } from '../src/recommend/readme.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { rawRequest, startTestServer, type TestServer } from './helpers.ts';

const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'readme-skills');
const project = (name: string) => join(F, 'projects', name);

let srv: TestServer;
const run = (name: string): RecommendResult => recommendForProject(srv.ctx.store, project(name), DEFAULT_SETTINGS.weights);

before(async () => {
  srv = await startTestServer();
  // The fixture skills go into the index the same way real skills do.
  for (const dir of readdirSync(join(F, 'skills'))) {
    const raw = readFileSync(join(F, 'skills', dir, 'SKILL.md'), 'utf8');
    const row = buildSkillRow({
      repo: 'fixture/skills',
      sha: '0'.repeat(40),
      dirPath: `skills/${dir}`,
      raw,
      tree: new TreeIndex([]),
      origin: 'generic',
      pluginId: null,
      extraFlags: [],
      install: null,
      lastCommitAt: null,
    });
    srv.ctx.store.upsertSkill(row, '');
  }
});
after(() => srv.close());

describe('README 기반 스킬 추천', () => {
  it('배지·HTML·코드 블록이 섞인 README에서 구조를 뽑는다', () => {
    const r = run('pdf-reader');
    assert.equal(r.summary.title, 'pdf-reader');
    assert.equal(r.summary.intro, 'Extract tables and text from PDF files in Node.js.');
    assert.deepEqual(r.summary.features, ['Extract tables from PDF pages', 'Read text with page numbers', 'Fill simple PDF forms']);
    assert.ok(!r.keywords.some((k) => k.term === 'blank'), '코드 주석 단어가 키워드에 들어가면 안 됨');
        assert.equal(r.skills[0]?.item.name, 'pdf-tools');
  });

  it('H1이 없으면 폴더명이 제목', () => {
    const r = run('sheet-kit');
    assert.equal(r.summary.title, 'sheet-kit');
    assert.equal(r.skills[0]?.item.name, 'spreadsheet-tools');
  });

  it('한국어 README: 사전으로 엑셀로 → spreadsheet, xlsx', () => {
    const r = run('budget-ko');
    assert.equal(r.summary.title, '가계부 정리 도구');
        assert.equal(r.skills[0]?.item.name, 'spreadsheet-tools');
    assert.deepEqual([...r.skills[0].matchedTerms].sort(), ['spreadsheet', 'xlsx']);
  });

  it('camelCase 분리: PptxMaker → pptx', () => {
    assert.deepEqual(tokenize('PptxMaker'), ['PptxMaker', 'Pptx', 'Maker']);
    const r = run('pptx-maker');
    assert.ok(r.keywords.some((k) => k.term === 'pptx'));
    assert.equal(r.skills[0]?.item.name, 'slide-decks');
  });

  it('단어 처리: 불용어·숫자·짧은 단어 제외, 한국어 사전', () => {
    assert.deepEqual(processTerm('Testing'), ['testing']);
    assert.equal(processTerm('the'), null);
    assert.equal(processTerm('2024'), null);
    assert.equal(processTerm('install'), null);
    assert.deepEqual([...(processTerm('엑셀로') ?? [])].sort(), ['excel', 'spreadsheet', 'xlsx']);
  });

  it('겹친 단어가 1개뿐이어도 비슷한 스킬로 보여 준다', () => {
    const r = run('colorlog');
    assert.equal(r.skills[0]?.item.name, 'brand-styling');
  });

  it('겹치는 단어가 없으면 빈 목록', () => {
    const r = run('kvstore');
    assert.deepEqual(r.skills, []);
  });

  it('setext 제목과 HTML 문단', () => {
    const info = extractReadme('Title Here\n==========\n\n<div>A paragraph inside an HTML block that is long enough.</div>\n', 'x');
    assert.equal(info.title, 'Title Here');
    assert.equal(info.intro, 'A paragraph inside an HTML block that is long enough.');
  });

  it('주소·링크 정의·HTML 주석·셸 코드 언어는 단어가 되지 않는다', () => {
    const md = [
      '<!--',
      '  Notes for maintaining this document: keep it short please.',
      '-->',
      '# fastlog',
      '',
      'Structured logging for services, see https://github.com/example/fastlog for docs.',
      '',
      '```bash',
      'npm i fastlog',
      '```',
      '',
      '[npm-url]: https://www.npmjs.com/package/fastlog',
    ].join('\n');
    const info = extractReadme(md, 'x');
    assert.equal(info.intro, 'Structured logging for services, see for docs.');
    assert.deepEqual(info.langs, []);
    const terms = termWeights(info).map((k) => k.term);
    for (const noise of ['https', 'github', 'com', 'www', 'npmjs', 'bash', 'notes', 'maintaining']) assert.ok(!terms.includes(noise), noise);
  });

  it('굳은 이름은 쪼개지 않고, camelCase 조각은 절반 가중치', () => {
    const ts = termWeights(extractReadme('# TypeScript\n', 'x'));
    assert.deepEqual(ts.map((k) => k.term), ['typescript']);
    const pm = termWeights(extractReadme('# PptxMaker\n', 'x'));
    assert.deepEqual(
      pm.map((k) => [k.term, k.weight]),
      [['pptxmaker', 5], ['maker', 2.5], ['pptx', 2.5]],
    );
  });

  it('1MB 가까운 악성 README도 바로 처리한다 (정규식 회귀)', () => {
    const N = 1024 * 1024 - 16;
    for (const [label, md] of [
      ['[ x', '['.repeat(N)],
      ['![ x', '!['.repeat(N / 2)],
      ['[a]( x', '[a]('.repeat(N / 4)],
      ['[a](( x', '[a](('.repeat(N / 5)],
      ['[a](b(c) x', '[a](b(c)'.repeat(N / 8)],
      ['< x', '<'.repeat(N)],
      ['<!-- x', '<!--'.repeat(N / 4)],
      ['# + spaces', '# a' + ' '.repeat(N) + 'b'],
      ['# + #s', '# a ' + '#'.repeat(N) + 'b'],
      ['CAPS', 'A'.repeat(N)],
    ] as const) {
      const t = performance.now();
      termWeights(extractReadme(md, 'x'));
      const ms = performance.now() - t;
      assert.ok(ms < 1000, `${label}: ${ms.toFixed(0)}ms`);
    }
  });

  it('제목 끝 #, 닫히지 않은 주석, 대문자 약어 분리는 예전과 같다', () => {
    const info = extractReadme('# Setup ##\n\n## C#\n\n<!-- note -->Intro paragraph that is long enough here.\n\n<!-- an open comment, long enough to count\n', 'x');
    assert.equal(info.title, 'Setup');
    assert.deepEqual(info.headings, ['C']);
    assert.equal(info.intro, 'Intro paragraph that is long enough here.');
    assert.deepEqual(info.body, ['<!-- an open comment, long enough to count'], '닫히지 않은 주석은 지우지 않음');
    assert.deepEqual(tokenize('XMLParser'), ['XMLParser', 'XML', 'Parser']);
    const paren = extractReadme('# t\n\n![Build](https://x/a_(1).svg) See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) for the background story.\n', 'x');
    assert.equal(paren.intro, 'See Foo for the background story.', '괄호가 든 주소도 링크·이미지로 처리');
  });

  it('오류: 상대 경로, 파일 경로, README 없음, 1MB 초과', () => {
    assert.throws(() => findReadme('relative/path'), { code: 'INVALID_PATH' });
    assert.throws(() => findReadme(join(project('kvstore'), 'README.md')), { code: 'INVALID_PATH' });
    assert.throws(() => findReadme(project('no-readme')), { code: 'README_NOT_FOUND' });
    const big = mkdtempSync(join(tmpdir(), 'big-readme-'));
    try {
      writeFileSync(join(big, 'README.md'), 'a'.repeat(1024 * 1024 + 1));
      assert.throws(() => findReadme(big), { code: 'README_TOO_LARGE' });
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });

  it('같은 이름의 사본 중 비슷하게 맞으면 공식판을 고른다', () => {
    const add = (repo: string, desc: string) =>
      srv.ctx.store.upsertSkill(
        buildSkillRow({
          repo,
          sha: '0'.repeat(40),
          dirPath: 'skills/invoice-maker',
          raw: `---\nname: invoice-maker\ndescription: ${desc}\n---\n`,
          tree: new TreeIndex([]),
          origin: 'generic',
          pluginId: null,
          extraFlags: [],
          install: null,
          lastCommitAt: null,
        }),
        '',
      );
    add('anthropics/skills', 'Create invoices as PDF.');
    add('someone/copies', 'Create invoices as PDF documents, invoices with totals.');
    const r = matchSkills(srv.ctx.store, termWeights(extractReadme('# Invoice tool\n\nCreate invoices and export them as PDF files quickly.\n', 'x')), DEFAULT_SETTINGS.weights);
    const inv = r.filter((c) => c.item.name === 'invoice-maker');
    assert.equal(inv.length, 1);
    assert.ok(inv[0].item.id.startsWith('gh:anthropics/skills:'), inv[0].item.id);
  });

  it('비슷한 스킬은 다운로드 수 순서로, 관련 없는 인기 스킬은 빠진다', () => {
    const add = (dir: string, desc: string, installs: number) => {
      srv.ctx.store.upsertSkill(
        buildSkillRow({
          repo: 'pop/skills',
          sha: '0'.repeat(40),
          dirPath: `skills/${dir}`,
          raw: `---\nname: ${dir}\ndescription: ${desc}\n---\n`,
          tree: new TreeIndex([]),
          origin: 'generic',
          pluginId: null,
          extraFlags: [],
          install: null,
          lastCommitAt: null,
        }),
        '',
      );
      srv.ctx.store.setSkillInstalls(`gh:pop/skills:skills/${dir}`, installs);
    };
    add('chart-exact', 'Render bar charts and line charts from CSV data.', 10);
    add('chart-popular', 'Draw charts from CSV files.', 5000);
    add('popular-unrelated', 'Manage calendar events and CSV-free meetings.', 999999);
    const r = matchSkills(srv.ctx.store, termWeights(extractReadme('# chartkit\n\nRender bar charts and line charts from CSV data.\n', 'x')), DEFAULT_SETTINGS.weights);
    const names = r.map((m) => m.item.name);
    assert.ok(names.indexOf('chart-popular') < names.indexOf('chart-exact'), names.join(','));
    assert.ok(!names.includes('popular-unrelated'), names.join(','));
  });

  it('API: 200 추천, 400 상대 경로, 404 README 없음', async () => {
    const post = (projectPath: string) =>
      rawRequest({
        port: srv.port,
        method: 'POST',
        path: '/api/readme-skills',
        headers: { 'Content-Type': 'application/json', 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${srv.port}` },
        body: JSON.stringify({ projectPath }),
      });
    const ok = await post(project('pdf-reader'));
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body) as RecommendResult;
    assert.equal(body.skills[0]?.item.name, 'pdf-tools');
    const rel = await post('relative/path');
    assert.equal(rel.status, 400);
    assert.equal(JSON.parse(rel.body).code, 'INVALID_PATH');
    const none = await post(project('no-readme'));
    assert.equal(none.status, 404);
    assert.equal(JSON.parse(none.body).code, 'README_NOT_FOUND');
  });
});

describe('README 추천 단어 조절·README 없는 프로젝트 (전체 점검 2026-11-02)', () => {
  it('끈 단어는 빼고, 더한 단어는 넣어 다시 계산한다', () => {
    const base = run('pdf-reader');
    assert.ok(base.keywords.some((k) => k.term === 'pdf'));
    const off = recommendForProject(srv.ctx.store, project('pdf-reader'), DEFAULT_SETTINGS.weights, { exclude: ['pdf'] });
    assert.ok(!off.keywords.some((k) => k.term === 'pdf'), '끈 단어는 키워드에 없음');
    const added = recommendForProject(srv.ctx.store, project('pdf-reader'), DEFAULT_SETTINGS.weights, { extra: ['spreadsheet'] });
    assert.equal(added.keywords[0].term, 'spreadsheet', '더한 단어는 가장 무겁게');
  });

  it('README가 없으면 package.json의 설명·키워드로 추천한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-manifest-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pdf-lab', description: 'Extract tables and text from PDF files.', keywords: ['pdf', 'tables'] }));
    const r = recommendForProject(srv.ctx.store, dir, DEFAULT_SETTINGS.weights);
    assert.equal(r.readmePath, join(dir, 'package.json'));
    assert.equal(r.summary.title, 'pdf-lab');
    assert.equal(r.skills[0]?.item.name, 'pdf-tools');
    rmSync(dir, { recursive: true, force: true });
  });

  it('pyproject.toml도 읽고, 설명 파일이 하나도 없으면 그렇게 말한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-manifest-'));
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "sheets"\ndescription = "Spreadsheet reports with formulas"\nkeywords = ["excel", "spreadsheet"]\n');
    assert.equal(recommendForProject(srv.ctx.store, dir, DEFAULT_SETTINGS.weights).summary.title, 'sheets');
    rmSync(join(dir, 'pyproject.toml'));
    assert.throws(() => recommendForProject(srv.ctx.store, dir, DEFAULT_SETTINGS.weights), /package\.json/);
    // nothing to read, but words typed on the page: those words alone
    const typed = recommendForProject(srv.ctx.store, dir, DEFAULT_SETTINGS.weights, { extra: ['pdf', 'tables'] });
    assert.equal(typed.readmePath, '');
    assert.equal(typed.skills[0]?.item.name, 'pdf-tools');
    rmSync(dir, { recursive: true, force: true });
  });
});

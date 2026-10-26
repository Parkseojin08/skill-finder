import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { extractReadme, findReadme, processTerm, recommendForProject, tokenize, type RecommendResult } from '../src/recommend/readme.ts';
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
    assert.equal(r.status, 'recommended');
    assert.equal(r.recommended?.item.name, 'pdf-tools');
  });

  it('H1이 없으면 폴더명이 제목', () => {
    const r = run('sheet-kit');
    assert.equal(r.summary.title, 'sheet-kit');
    assert.equal(r.recommended?.item.name, 'spreadsheet-tools');
  });

  it('한국어 README: 사전으로 엑셀로 → spreadsheet, xlsx', () => {
    const r = run('budget-ko');
    assert.equal(r.summary.title, '가계부 정리 도구');
    assert.equal(r.status, 'recommended');
    assert.equal(r.recommended?.item.name, 'spreadsheet-tools');
    assert.deepEqual([...r.recommended!.matchedTerms].sort(), ['spreadsheet', 'xlsx']);
  });

  it('camelCase 분리: PptxMaker → pptx', () => {
    assert.deepEqual(tokenize('PptxMaker'), ['PptxMaker', 'Pptx', 'Maker']);
    const r = run('pptx-maker');
    assert.ok(r.keywords.some((k) => k.term === 'pptx'));
    assert.equal(r.recommended?.item.name, 'slide-decks');
  });

  it('단어 처리: 불용어·숫자·짧은 단어 제외, 한국어 사전', () => {
    assert.deepEqual(processTerm('Testing'), ['testing']);
    assert.equal(processTerm('the'), null);
    assert.equal(processTerm('2024'), null);
    assert.equal(processTerm('install'), null);
    assert.deepEqual(processTerm('엑셀로'), ['spreadsheet', 'xlsx', 'excel']);
  });

  it('겹친 단어가 1개뿐이면 후보로만', () => {
    const r = run('colorlog');
    assert.equal(r.status, 'candidates');
    assert.equal(r.recommended, null);
    assert.equal(r.candidates[0].item.name, 'brand-styling');
  });

  it('겹치는 단어가 없으면 no-match', () => {
    const r = run('kvstore');
    assert.equal(r.status, 'no-match');
    assert.deepEqual(r.candidates, []);
  });

  it('setext 제목과 HTML 문단', () => {
    const info = extractReadme('Title Here\n==========\n\n<div>A paragraph inside an HTML block that is long enough.</div>\n', 'x');
    assert.equal(info.title, 'Title Here');
    assert.equal(info.intro, 'A paragraph inside an HTML block that is long enough.');
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
    assert.equal(body.status, 'recommended');
    assert.equal(body.recommended?.item.name, 'pdf-tools');
    const rel = await post('relative/path');
    assert.equal(rel.status, 400);
    assert.equal(JSON.parse(rel.body).code, 'INVALID_PATH');
    const none = await post(project('no-readme'));
    assert.equal(none.status, 404);
    assert.equal(JSON.parse(none.body).code, 'README_NOT_FOUND');
  });
});

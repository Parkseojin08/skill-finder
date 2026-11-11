// Feature review 2026-11-04, stage 3, bundle D (search): F19 "이 조건으로 전체에서 다시 찾기" (facets applied before
// the cut, facetCounts over every candidate) and F20 hidden repositories and trusted owners (owner_prefs).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import express from 'express';
import { createContext } from '../src/bootstrap.ts';
import type { AppContext } from '../src/context.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { deleteOwnerPref, listOwnerPrefs, normalizeOwnerKey, ownerFilter, setOwnerPref } from '../src/prefs/ownerPrefs.ts';
import { recommendForProject } from '../src/recommend/readme.ts';
import { prefsRouter } from '../src/routes/prefs.ts';
import { searchRouter } from '../src/routes/search.ts';
import { browse, clearBrowseCache, type BrowseList, type BrowseOverview } from '../src/search/browse.ts';
import { countFacets, matchFacetValues, normalizeFacets, runFeatures } from '../src/search/facets.ts';
import { runSearch, type SearchDeps, type SearchEvent, type SearchFilters } from '../src/search/pipeline.ts';
import { securityMiddleware } from '../src/security.ts';
import { getSettings, saveSettings } from '../src/settings.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sf-s3d-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function newCtx(minStars = 0): AppContext {
  const ctx = createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmp, 'd-')), githubToken: null }, ':memory:');
  ctx.github.getRepoMeta = async () => null; // offline
  ctx.github.searchRepos = async () => [];
  saveSettings(ctx.store, { ...getSettings(ctx.store), minStars });
  return ctx;
}

type SkillOpts = { frontmatter?: string; body?: string; installs?: number; lastCommitAt?: string | null };
function addSkill(ctx: AppContext, repo: string, dir: string, name: string, description: string, o: SkillOpts = {}): string {
  const row = buildSkillRow({
    repo,
    sha: 'a'.repeat(40),
    dirPath: dir,
    raw: `---\nname: ${name}\ndescription: ${description}\n${o.frontmatter ?? ''}---\n${o.body ?? `Body of ${name}`}\n`,
    tree: new TreeIndex([]),
    origin: 'generic',
    pluginId: null,
    extraFlags: [],
    install: null,
    lastCommitAt: o.lastCommitAt === undefined ? new Date().toISOString() : o.lastCommitAt,
  });
  ctx.store.upsertSkill(o.installs != null ? { ...row, installs: o.installs } : row, '');
  return row.id;
}
function repoRow(ctx: AppContext, full_name: string, stars: number | null, license: string | null = null) {
  ctx.store.upsertRepo({ full_name, stars, pushed_at: null, archived: 0, fork: 0, license, default_branch: 'main', etag: null, fetched_at: new Date().toISOString() });
}

const deps = (ctx: AppContext, patch: Partial<SearchDeps> = {}): SearchDeps => ({ ctx, skillsSh: async () => [], githubWaitMs: 0, ...patch });
async function search(d: SearchDeps, q: string, filters: SearchFilters = {}) {
  const events: SearchEvent[] = [];
  await runSearch(d, q, filters, (e) => events.push(e));
  const results = events.filter((e) => e.type === 'results').at(-1) as Extract<SearchEvent, { type: 'results' }>;
  const done = events.find((e) => e.type === 'done') as Extract<SearchEvent, { type: 'done' }>;
  return { events, results, cached: done.cached, names: results.items.map((i) => i.name).sort() };
}
const searchKeys = (ctx: AppContext) => (ctx.store.db.prepare("SELECT key FROM search_cache WHERE key LIKE 'search:%'").all() as Array<{ key: string }>).map((r) => r.key);

describe('F20 owner_prefs 저장', () => {
  it('키는 소문자 owner/repo 또는 owner, 설치 명령과 같은 수준으로 검사한다', () => {
    assert.equal(normalizeOwnerKey('Acme/PDF-Tools', 'repo'), 'acme/pdf-tools');
    assert.equal(normalizeOwnerKey(' Acme ', 'owner'), 'acme');
    for (const bad of ['acme', 'a/b/c', '../etc', 'a/..', 'a b/c', 'a/b c', '', 'x'.repeat(40) + '/y']) assert.equal(normalizeOwnerKey(bad, 'repo'), null, bad);
    for (const bad of ['a/b', 'a_b', 'a.b', '', 'x'.repeat(40)]) assert.equal(normalizeOwnerKey(bad, 'owner'), null, bad);
    assert.equal(normalizeOwnerKey('a/b', 'team'), null);
  });

  it('추가·바꾸기·지우기, 한 키는 숨김이나 믿음 중 하나', () => {
    const ctx = newCtx();
    setOwnerPref(ctx.store, 'Evil/Copies', 'repo', 'hide');
    setOwnerPref(ctx.store, 'obra', 'owner', 'trust');
    assert.deepEqual(
      listOwnerPrefs(ctx.store).map((p) => [p.key, p.kind, p.pref]).sort(),
      [
        ['evil/copies', 'repo', 'hide'],
        ['obra', 'owner', 'trust'],
      ],
    );
    setOwnerPref(ctx.store, 'evil/copies', 'repo', 'trust');
    assert.equal(listOwnerPrefs(ctx.store).find((p) => p.key === 'evil/copies')?.pref, 'trust', '같은 키는 바꿈');
    assert.throws(() => setOwnerPref(ctx.store, 'a/b', 'owner', 'hide'), /제작자 이름/);
    assert.throws(() => setOwnerPref(ctx.store, 'a/b', 'repo', 'block'), /hide 또는 trust/);
    assert.equal(deleteOwnerPref(ctx.store, 'EVIL/copies'), true);
    assert.equal(deleteOwnerPref(ctx.store, 'evil/copies'), false);
    assert.deepEqual(listOwnerPrefs(ctx.store).map((p) => p.key), ['obra']);
  });

  it('owner를 숨기면 그 owner의 모든 저장소가 숨고, 믿음은 숨김과 따로', () => {
    const ctx = newCtx();
    setOwnerPref(ctx.store, 'spam', 'owner', 'hide');
    setOwnerPref(ctx.store, 'good/one', 'repo', 'trust');
    const f = ownerFilter(ctx.store);
    assert.equal(f.hidden('Spam/anything'), true);
    assert.equal(f.hidden('good/one'), false);
    assert.equal(f.trusted('GOOD/one'), true);
    assert.equal(f.trusted('good/two'), false);
    assert.equal(ownerFilter(ctx.store, { showHidden: true }).hidden('spam/x'), false, '이번만 보기');
    assert.equal(ownerFilter(ctx.store, { showHidden: true }).hideHash, '');
  });

  it('512KB 키도 바로 거절한다 (길이를 먼저 본다)', () => {
    const t = performance.now();
    assert.equal(normalizeOwnerKey('a'.repeat(512 * 1024) + '/b', 'repo'), null);
    assert.equal(normalizeOwnerKey('-'.repeat(512 * 1024), 'owner'), null);
    assert.ok(performance.now() - t < 50);
  });
});

async function serve(ctx: AppContext, d?: SearchDeps) {
  const app = express();
  app.use(securityMiddleware(ctx.config));
  app.use('/api', express.json({ limit: '64kb' }));
  app.use('/api', prefsRouter(ctx), searchRouter(ctx, d ?? deps(ctx)));
  const server: Server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => done(s));
  });
  const port = (server.address() as AddressInfo).port;
  ctx.config.port = port;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${port}` }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
  return { call, close: () => new Promise<void>((done) => server.close(() => done())) };
}

describe('F20 /api/prefs/owners', () => {
  it('헤더·같은 출처가 필요하고, 키를 검사하며, 지울 때 owner/repo는 %2F로', async () => {
    const ctx = newCtx();
    const srv = await serve(ctx);
    try {
      assert.equal((await srv.call('GET', '/prefs/owners', undefined, {})).status, 403);
      assert.equal((await srv.call('POST', '/prefs/owners', { key: 'a/b', kind: 'repo', pref: 'hide' }, { 'X-Skill-Finder': '1', Origin: 'https://evil.example' })).status, 403);
      const ok = await srv.call('POST', '/prefs/owners', { key: 'Acme/Copies', kind: 'repo', pref: 'hide' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.saved.key, 'acme/copies');
      assert.equal((await srv.call('POST', '/prefs/owners', { key: '../x', kind: 'repo', pref: 'hide' })).status, 400);
      assert.equal((await srv.call('POST', '/prefs/owners', { key: 'a/b', kind: 'repo', pref: 'mute' })).status, 400);
      assert.equal((await srv.call('POST', '/prefs/owners', { key: 'x'.repeat(5000), kind: 'owner', pref: 'trust' })).status, 400);
      assert.equal((await srv.call('POST', '/prefs/owners', { key: 'obra', kind: 'owner', pref: 'trust' })).status, 200);
      const list = await srv.call('GET', '/prefs/owners');
      assert.deepEqual(list.body.items.map((p: { key: string }) => p.key).sort(), ['acme/copies', 'obra']);
      assert.equal((await srv.call('DELETE', '/prefs/owners/..%2Fetc')).status, 400);
      const del = await srv.call('DELETE', '/prefs/owners/ACME%2Fcopies');
      assert.equal(del.status, 200);
      assert.equal(del.body.removed, true);
      assert.deepEqual(del.body.items.map((p: { key: string }) => p.key), ['obra']);
      assert.equal((await srv.call('DELETE', '/prefs/owners/obra')).body.removed, true);
    } finally {
      await srv.close();
    }
  });
});

describe('F20 검색에서 숨김', () => {
  function sample() {
    const ctx = newCtx();
    addSkill(ctx, 'good/pdf', 'skills/pdf-good', 'pdf-good', 'Extract PDF tables quickly.', { installs: 10 });
    addSkill(ctx, 'copy/pdf', 'skills/pdf-copy', 'pdf-copy', 'Extract PDF tables, a copied skill.', { installs: 900 });
    addSkill(ctx, 'copy/other', 'skills/pdf-other', 'pdf-other', 'PDF tables from the same owner.', { installs: 5 });
    return ctx;
  }

  it('숨긴 저장소는 자르기 전에 빠지고, 숨긴 수가 오며, 캐시 키가 바뀐다', async () => {
    const ctx = sample();
    const plain = await search(deps(ctx), 'pdf tables');
    assert.deepEqual(plain.names, ['pdf-copy', 'pdf-good', 'pdf-other']);
    assert.equal(plain.results.hiddenByPrefs, undefined, '숨긴 것이 없으면 필드도 없음');

    setOwnerPref(ctx.store, 'copy/pdf', 'repo', 'hide');
    const hidden = await search(deps(ctx), 'pdf tables');
    assert.equal(hidden.cached, false, '숨김이 바뀌면 저장된 결과를 쓰지 않음');
    assert.deepEqual(hidden.names, ['pdf-good', 'pdf-other']);
    assert.equal(hidden.results.hiddenByPrefs, 1);
    assert.equal(hidden.results.hiddenRepos, 1);
    const early = hidden.events.filter((e) => e.type === 'candidates') as Array<Extract<SearchEvent, { type: 'candidates' }>>;
    assert.ok(early.every((e) => e.items.every((i) => i.name !== 'pdf-copy')), '임시 카드에도 없음');
    assert.equal((await search(deps(ctx), 'pdf tables')).cached, true, '같은 숨김 목록이면 저장된 결과');

    // "숨긴 저장소 N개 · 보기": this search only, and it is the plain search's own key
    const shown = await search(deps(ctx), 'pdf tables', { showHidden: true });
    assert.equal(shown.cached, true, '숨김 해제 검색은 숨긴 것이 없을 때와 같은 캐시 키');
    assert.deepEqual(shown.names, plain.names);

    setOwnerPref(ctx.store, 'copy', 'owner', 'hide');
    const owner = await search(deps(ctx), 'pdf tables');
    assert.equal(owner.cached, false);
    assert.deepEqual(owner.names, ['pdf-good']);
    assert.equal(owner.results.hiddenRepos, 2);

    deleteOwnerPref(ctx.store, 'copy');
    deleteOwnerPref(ctx.store, 'copy/pdf');
    const back = await search(deps(ctx), 'pdf tables');
    assert.equal(back.cached, true, '목록을 비우면 처음 키로 돌아감');
    assert.deepEqual(back.names, plain.names);
    assert.equal(searchKeys(ctx).length, 3, '숨김 없음·저장소 숨김·제작자 숨김 세 가지');
  });

  it('skills.sh·GitHub 후보도 숨긴 저장소면 읽지 않는다', async () => {
    const ctx = sample();
    setOwnerPref(ctx.store, 'spam', 'owner', 'hide');
    const looked: string[] = [];
    ctx.indexer.findInRepo = async (r) => (looked.push(r), null);
    const r = await search(
      deps(ctx, {
        skillsSh: async () => [
          { id: 'spam/pdf/pdf-tables', source: 'spam/pdf', skillId: 'pdf-tables', name: 'pdf-tables', installs: 99_999 },
          { id: 'fine/pdf/pdf-tables', source: 'fine/pdf', skillId: 'pdf-tables', name: 'pdf-tables', installs: 5 },
        ],
      }),
      'pdf tables',
    );
    assert.deepEqual(looked, ['fine/pdf'], '숨긴 저장소는 조회하지 않음');
    assert.equal(r.results.hiddenByPrefs, 1);
  });

  it('믿는 제작자는 정렬·결과를 바꾸지 않고, 그 필터를 쓴 검색만 캐시 키가 바뀐다', async () => {
    const ctx = sample();
    const plain = await search(deps(ctx), 'pdf tables');
    setOwnerPref(ctx.store, 'good', 'owner', 'trust');
    const again = await search(deps(ctx), 'pdf tables');
    assert.equal(again.cached, true, '믿음은 기본 검색의 키에 들어가지 않음');
    assert.deepEqual(again.results.items.map((i) => i.id), plain.results.items.map((i) => i.id), '순서 그대로');
    assert.deepEqual(
      again.results.items.map((i) => [i.riskLevel, i.score]),
      plain.results.items.map((i) => [i.riskLevel, i.score]),
      '위험·점수 그대로',
    );

    const trusted = await search(deps(ctx), 'pdf tables', { facets: { trusted: true } });
    assert.equal(trusted.cached, false);
    assert.deepEqual(trusted.names, ['pdf-good']);
    assert.equal(trusted.results.facetCounts?.trusted, 1);
    assert.equal((await search(deps(ctx), 'pdf tables', { facets: { trusted: true } })).cached, true);
    setOwnerPref(ctx.store, 'copy', 'owner', 'trust');
    const more = await search(deps(ctx), 'pdf tables', { facets: { trusted: true } });
    assert.equal(more.cached, false, '믿는 목록이 바뀌면 그 필터의 검색만 다시');
    assert.deepEqual(more.names, ['pdf-copy', 'pdf-good', 'pdf-other']);
    assert.equal((await search(deps(ctx), 'pdf tables')).cached, true);
  });

  it('POST /api/search: showHidden·facets 검사', async () => {
    const ctx = sample();
    setOwnerPref(ctx.store, 'copy', 'owner', 'hide');
    const srv = await serve(ctx);
    try {
      const run = async (filters: unknown) => {
        const res = await srv.call('POST', '/search', { query: 'pdf tables', filters });
        if (res.status !== 200) return { status: res.status, results: null };
        const lines = String(res.body)
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        return { status: 200, results: lines.filter((e) => e.type === 'results').at(-1) };
      };
      assert.deepEqual((await run({})).results.items.map((i: { name: string }) => i.name), ['pdf-good']);
      assert.equal((await run({ showHidden: true })).results.items.length, 3);
      assert.equal((await run({ facets: { owner: ['good'] } })).results.items.length, 1);
      assert.equal((await run({ facets: { owner: ['../x'] } })).status, 400);
      assert.equal((await run({ facets: { run: ['rm'] } })).status, 400);
      assert.equal((await run({ facets: { nope: true } })).status, 400);
      assert.equal((await run({ showHidden: 'yes' })).status, 400);
    } finally {
      await srv.close();
    }
  });
});

describe('F19 이 조건으로 전체에서 다시 찾기', () => {
  it('패싯이 없으면 같은 결과·같은 캐시 키', async () => {
    const ctx = newCtx();
    addSkill(ctx, 'a/one', 'skills/pdf', 'pdf-one', 'PDF tables tool.');
    const first = await search(deps(ctx), 'pdf tables');
    for (const facets of [undefined, {}, { trust: [], owner: [] }, { run: [] }]) {
      const r = await search(deps(ctx), 'pdf tables', { facets });
      assert.equal(r.cached, true, JSON.stringify(facets));
      assert.deepEqual(r.results, first.results);
    }
    assert.equal(searchKeys(ctx).length, 1);
    assert.equal(first.results.facets, undefined);
    assert.equal(first.results.facetCounts, undefined);
  });

  it('50개로 자르기 전에 적용하고, facetCounts는 후보 전체 기준', async () => {
    const ctx = newCtx();
    // 60 popular skills from one owner fill the 50 results; three small ones from another come after them
    for (let i = 0; i < 60; i++) addSkill(ctx, `big/w${i}`, 'skills/widget', `widget-big-${i}`, 'Widget builder for dashboards.', { installs: 1000 + i });
    for (let i = 0; i < 3; i++) addSkill(ctx, 'tiny/widgets', `skills/w${i}`, `widget-tiny-${i}`, 'Widget builder for dashboards, small.', { installs: 0 });
    repoRow(ctx, 'tiny/widgets', null, 'MIT');
    const plain = await search(deps(ctx), 'widget builder');
    assert.equal(plain.results.items.length, 50);
    assert.ok(plain.results.items.every((i) => !i.name.startsWith('widget-tiny')), '기본: 상위 50개에 없음');

    const owner = await search(deps(ctx), 'widget builder', { facets: { owner: ['Tiny'] } });
    assert.deepEqual(owner.names, ['widget-tiny-0', 'widget-tiny-1', 'widget-tiny-2']);
    assert.deepEqual(owner.results.facets, { owner: ['tiny'] }, '정리한 패싯을 돌려줌');
    const counts = owner.results.facetCounts!;
    assert.equal(counts.total, 3);
    assert.equal(counts.owner.big, 60, '자기 묶음은 빼고 센다 (다른 값을 골랐을 때의 수)');
    assert.equal(counts.owner.tiny, 3);
    assert.equal(counts.license.MIT, 3);
    assert.equal(counts.license.unknown, undefined, '다른 묶음(owner)이 걸린 채로 센다');

    const lic = await search(deps(ctx), 'widget builder', { facets: { license: ['MIT'] } });
    assert.equal(lic.results.items.length, 3);
    assert.ok(lic.results.items.every((i) => i.license === 'MIT'));
    assert.equal(lic.results.facetCounts!.license.unknown, 60);
  });

  it('실행 특성·업데이트·카테고리', async () => {
    const ctx = newCtx();
    addSkill(ctx, 'a/r', 'skills/plain', 'deploy-plain', 'Deploy helper plain.');
    addSkill(ctx, 'a/r', 'skills/bash', 'deploy-bash', 'Deploy helper with bash.', { frontmatter: 'allowed-tools: Bash\n' });
    addSkill(ctx, 'a/r', 'skills/manual', 'deploy-manual', 'Deploy helper run by hand.', { frontmatter: 'disable-model-invocation: true\n' });
    addSkill(ctx, 'a/r', 'skills/old', 'deploy-old', 'Deploy helper, old.', { lastCommitAt: '2023-01-01T00:00:00Z' });
    const noBash = await search(deps(ctx), 'deploy helper', { facets: { run: ['noBashPreapproved'] } });
    assert.ok(!noBash.names.includes('deploy-bash'));
    assert.equal(noBash.names.length, 3);
    const manual = await search(deps(ctx), 'deploy helper', { facets: { run: ['manualOnly', 'noHooksMcp'] } });
    assert.deepEqual(manual.names, ['deploy-manual']);
    assert.equal(manual.results.items[0].manualOnly, true);
    assert.equal(manual.results.facetCounts!.run.noBashPreapproved, 1, '실행 특성은 함께 거는 조건');
    const recent = await search(deps(ctx), 'deploy helper', { facets: { updated: '1y' } });
    assert.ok(!recent.names.includes('deploy-old'));
    assert.equal(recent.results.facetCounts!.updated['1y'], 3);
    const plain = await search(deps(ctx), 'deploy helper');
    assert.equal(plain.results.items.find((i) => i.name === 'deploy-plain')!.manualOnly, undefined, '기본 결과 모양 그대로');
  });

  it('패싯 판정 함수: 묶음 안은 OR, 묶음 사이는 AND, run은 모두', () => {
    const v = { trust: 'community', category: ['testing'], method: 'skills-cli', license: 'MIT', run: runFeatures(['preapprovedBash'], false), updatedAt: Date.now(), owner: 'o', trusted: false };
    assert.deepEqual(v.run, ['noHooksMcp']);
    assert.equal(matchFacetValues(v, { license: ['MIT', 'Apache-2.0'], trust: ['community'] }), true);
    assert.equal(matchFacetValues(v, { license: ['Apache-2.0'] }), false);
    assert.equal(matchFacetValues(v, { run: ['noHooksMcp', 'noBashPreapproved'] }), false);
    assert.equal(matchFacetValues(v, { trusted: true }), false);
    assert.deepEqual(normalizeFacets({ owner: ['B', 'a', 'b'], trust: [], run: [] }), { owner: ['a', 'b'] });
    assert.equal(normalizeFacets({ trust: [], updated: undefined }), null);
    const c = countFacets([v, { ...v, license: 'other', owner: 'p' }], { license: ['MIT'] });
    assert.equal(c.total, 1);
    assert.deepEqual(c.license, { MIT: 1, other: 1 });
    assert.deepEqual(c.owner, { o: 1 });
  });

  it('결과 항목: 라이선스(알 때만)·직접 부를 때만·근사 사본 묶음(cluster_id)', async () => {
    const ctx = newCtx();
    const id = addSkill(ctx, 'lic/repo', 'skills/x', 'lint-x', 'Lint helper x.');
    addSkill(ctx, 'nolic/repo', 'skills/y', 'lint-y', 'Lint helper y.');
    repoRow(ctx, 'lic/repo', null, 'Apache-2.0');
    ctx.store.db.prepare('UPDATE skills SET cluster_id = ? WHERE id = ?').run('c-123', id);
    const r = await search(deps(ctx), 'lint helper');
    const x = r.results.items.find((i) => i.name === 'lint-x')!;
    const y = r.results.items.find((i) => i.name === 'lint-y')!;
    assert.equal(x.license, 'Apache-2.0');
    assert.equal(x.clusterId, 'c-123');
    assert.ok(!('license' in y) && !('clusterId' in y) && !('manualOnly' in y));
  });
});

describe('F20 둘러보기·README 추천에서 숨김', () => {
  it('둘러보기: 숨긴 저장소 카드가 빠지고 숨긴 수, showHidden으로 이번만 보기', () => {
    const ctx = newCtx();
    addSkill(ctx, 'keep/r', 'skills/a', 'test-a', 'Write unit tests with jest.', { installs: 5 });
    addSkill(ctx, 'drop/r', 'skills/b', 'test-b', 'Write unit tests with mocha.', { installs: 50 });
    clearBrowseCache(ctx.store);
    const before = browse(ctx.store, { section: 'overview' }) as BrowseOverview;
    setOwnerPref(ctx.store, 'drop/r', 'repo', 'hide');
    const after = browse(ctx.store, { section: 'overview' }) as BrowseOverview;
    assert.equal(after.total, before.total - 1, '같은 색인 세대에서도 숨김 목록이 바뀌면 다시 셈');
    const list = browse(ctx.store, { section: 'list', owner: 'drop' }) as BrowseList;
    assert.equal(list.items.length, 0);
    assert.equal(list.hiddenByPrefs, 1);
    const shown = browse(ctx.store, { section: 'list', owner: 'drop', showHidden: true }) as BrowseList;
    assert.deepEqual(shown.items.map((i) => i.name), ['test-b']);
    assert.equal(shown.hiddenByPrefs, undefined);
    assert.equal((browse(ctx.store, { section: 'list', owner: 'keep' }) as BrowseList).hiddenByPrefs, undefined, '이 목록에 해당하는 숨김이 없으면 필드 없음');
  });

  it('README 추천: 비슷함 기준·50개 자르기 전에 빼고 숨긴 수를 준다', () => {
    const ctx = newCtx();
    addSkill(ctx, 'keep/r', 'skills/a', 'pdf-table-extractor', 'Extract tables from PDF documents into CSV.', { installs: 5 });
    addSkill(ctx, 'drop/r', 'skills/b', 'pdf-table-reader', 'Extract tables from PDF documents into CSV files.', { installs: 500 });
    const dir = join(tmp, `proj-${Date.now()}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '# PDF table extractor\n\nExtract tables from PDF documents and save them as CSV files.\n');
    const w = getSettings(ctx.store).weights;
    const plain = recommendForProject(ctx.store, dir, w);
    assert.deepEqual(plain.skills.map((s) => s.item.name).sort(), ['pdf-table-extractor', 'pdf-table-reader']);
    assert.equal(plain.hiddenByPrefs, undefined);
    setOwnerPref(ctx.store, 'drop', 'owner', 'hide');
    const hidden = recommendForProject(ctx.store, dir, w);
    assert.deepEqual(hidden.skills.map((s) => s.item.name), ['pdf-table-extractor']);
    assert.equal(hidden.hiddenByPrefs, 1);
    assert.equal(recommendForProject(ctx.store, dir, w, { showHidden: true }).skills.length, 2);
  });
});

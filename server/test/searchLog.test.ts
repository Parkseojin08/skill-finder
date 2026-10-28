import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { searchLogger } from '../src/search/searchLog.ts';
import { pruneSearchLog } from '../src/tasks.ts';
import { rawRequest, startTestServer, type TestServer } from './helpers.ts';

let srv: TestServer;
before(async () => {
  srv = await startTestServer();
});
after(() => srv.close());

type Row = { kind: string; skill_id: string | null; query: string | null; created_at: string; meta_json: string | null };
const rows = (kind: string) => srv.ctx.store.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind) as Row[];
const headers = (port: number) => ({ 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' });

describe('검색 기록 (U5-2)', () => {
  it('검색이 끝나면 개수·시간·실패한 출처를 한 줄로 남기고, done에 sid를 붙인다', () => {
    srv.ctx.store.clearSearchLog();
    const started = Date.now() - 50;
    const log = searchLogger(srv.ctx.store, 'pdf tables', { minStars: 0 }, started);
    log({ type: 'source', source: 'github', state: 'timeout' });
    log({ type: 'candidates', items: [] });
    log({ type: 'results', items: [], hiddenHighRisk: 2, hiddenNoDescription: 0, hiddenLowStars: 3, hiddenNoMatch: 1, minStars: 0 });
    const done = log({ type: 'done', cached: false, elapsedMs: 1234 });
    log({ type: 'done', cached: false, elapsedMs: 1300 }); // a second done (error path) is not logged twice
    const [row] = rows('search');
    assert.equal(rows('search').length, 1);
    assert.equal(row.query, 'pdf tables');
    const meta = JSON.parse(row.meta_json!);
    assert.ok(done.type === 'done' && done.sid === meta.sid && /^[0-9a-f-]{36}$/.test(meta.sid));
    assert.deepEqual({ ...meta, sid: undefined, firstMs: undefined }, {
      sid: undefined,
      firstMs: undefined,
      n: 0,
      hidLow: 3,
      hidNoMatch: 1,
      hidRisk: 2,
      finalMs: 1234,
      cached: false,
      srcFail: ['github:timeout'],
      minStars: 0,
      maxRisk: 'medium',
      lift: true,
    });
    assert.ok(meta.firstMs >= 50);
  });

  it('열어 본 결과는 sid·순위와 함께 남고, 설정을 끄면 남기지 않는다', async () => {
    srv.ctx.store.clearSearchLog();
    srv.ctx.store.upsertSkill(
      buildSkillRow({ repo: 'a/b', sha: '0'.repeat(40), dirPath: 'skills/x', raw: '---\nname: x\ndescription: X.\n---\n', tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null }),
      '',
    );
    const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const open = () =>
      rawRequest({ port: srv.port, path: `/api/skills/${encodeURIComponent('gh:a/b:skills/x')}?q=x&sid=${sid}&pos=7&page=2&prov=1&evil=1`, headers: headers(srv.port) });
    assert.equal((await open()).status, 200);
    const [view] = rows('view');
    assert.equal(view.query, 'x');
    assert.deepEqual(JSON.parse(view.meta_json!), { sid, pos: 7, page: 2, provisional: true });

    const put = await rawRequest({ port: srv.port, method: 'PUT', path: '/api/settings', headers: headers(srv.port), body: JSON.stringify({ settings: { searchLog: false } }) });
    assert.equal(JSON.parse(put.body).settings.searchLog, false);
    await open();
    assert.equal(rows('view').length, 1, '끈 뒤에는 남기지 않음');
    await rawRequest({ port: srv.port, method: 'PUT', path: '/api/settings', headers: headers(srv.port), body: JSON.stringify({ settings: { searchLog: true } }) });
  });

  it('설정 화면의 기록 지우기와 90일 정리', async () => {
    const store = srv.ctx.store;
    store.clearSearchLog();
    store.logEvent('search', null, 'old', { sid: 'x' });
    store.logEvent('install', 'gh:a/b:skills/x', null);
    store.db.prepare("UPDATE events SET created_at = ? WHERE query = 'old'").run(new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString());
    store.logEvent('search', null, 'new', { sid: 'y' });
    assert.equal(pruneSearchLog(srv.ctx), 1);
    assert.deepEqual(rows('search').map((r) => r.query), ['new']);

    const got = await rawRequest({ port: srv.port, path: '/api/settings', headers: headers(srv.port) });
    assert.equal(JSON.parse(got.body).searchLogCount, 1);
    const del = await rawRequest({ port: srv.port, method: 'DELETE', path: '/api/search-log', headers: headers(srv.port) });
    assert.equal(del.status, 200);
    assert.equal(JSON.parse(del.body).searchLogCount, 0);
    assert.equal(rows('install').length, 1, '설치 기록은 지우지 않음');
    const foreign = await rawRequest({ port: srv.port, method: 'DELETE', path: '/api/search-log', headers: { ...headers(srv.port), Origin: 'http://evil.example' } });
    assert.equal(foreign.status, 403);
  });
});

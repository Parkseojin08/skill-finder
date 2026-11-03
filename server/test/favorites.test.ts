import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openDb } from '../src/db/index.ts';
import { MIGRATIONS } from '../src/db/schema.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { rawRequest, startTestServer } from './helpers.ts';

describe('GitHub 저장소 즐겨찾기 (사용자 요청 2026-11-03)', () => {
  it('저장소를 이름 하나로 넣고, 검색이 보여 준 설명·토픽과 색인의 스킬로 카드를 만든다', async () => {
    const srv = await startTestServer();
    try {
      const { store } = srv.ctx;
      for (const dir of ['skills/rea-tool-design', 'skills/reverse-engineer-anything']) {
        const name = dir.split('/')[1];
        store.upsertSkill(buildSkillRow({ repo: 'morluto/rea', sha: '0'.repeat(40), dirPath: dir, raw: `---\nname: ${name}\ndescription: ${name} for tests.\n---\n`, tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null }), '');
      }
      store.upsertRepo({ full_name: 'morluto/rea', stars: 423_600, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: new Date().toISOString() });
      const headers = { 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${srv.port}`, 'Content-Type': 'application/json' };
      const call = (method: string, path: string, body?: unknown) => rawRequest({ port: srv.port, method, path, headers, body: body === undefined ? undefined : JSON.stringify(body) });

      const repo = { description: 'Reverse engineer anything\u0007 with agents', topics: ['ai', 'Not A Topic', 'mcp', 7] };
      assert.equal((await call('POST', '/api/favorites', { id: 'repo:morluto/rea', name: 'Morluto/REA', repo })).status, 200);
      assert.equal((await call('POST', '/api/favorites', { id: 'repo:MORLUTO/rea', name: 'x' })).status, 200, '대소문자만 다른 같은 저장소');
      assert.equal((await call('POST', '/api/favorites', { id: 'repo:../etc' })).status, 400);
      assert.equal((await call('POST', '/api/favorites', { id: 'repo:a/..' })).status, 400, '설치와 같은 저장소 이름 규칙');
      assert.equal((await call('POST', '/api/favorites', { id: 'repo:morluto/k', name: 'morluto/K' })).status, 200);
      assert.equal(JSON.parse((await call('GET', '/api/favorites')).body).repos.find((r: { repo: string }) => r.repo.endsWith('k')).repo, 'morluto/k', '저장소 이름이 아닌 이름은 쓰지 않음');
      assert.equal((await call('DELETE', '/api/favorites?id=repo%3AMORLUTO%2Fk')).status, 200);
      assert.deepEqual(JSON.parse((await call('GET', '/api/favorites/ids')).body).ids, ['repo:morluto/rea']);

      const list = JSON.parse((await call('GET', '/api/favorites')).body);
      assert.equal(list.repos.length, 1);
      const card = list.repos[0];
      assert.equal(card.repo, 'Morluto/REA', 'GitHub가 쓰는 이름 그대로');
      assert.equal(card.stars, 423_600);
      assert.equal(card.description, 'Reverse engineer anything with agents', '제어 문자는 지움');
      assert.deepEqual(card.topics, ['ai', 'mcp']);
      assert.deepEqual(card.skills.map((s: { name: string }) => s.name).sort(), ['rea-tool-design', 'reverse-engineer-anything']);
      assert.equal(list.items.length, 0, '저장소는 스킬 카드가 아님');

      assert.equal((await call('DELETE', '/api/favorites?id=repo%3Amorluto%2Frea')).status, 200);
      assert.equal(JSON.parse((await call('GET', '/api/favorites')).body).repos.length, 0);
    } finally {
      await srv.close();
    }
  });
});

describe('즐겨찾기 (계정 없이, 사용자 결정 2026-11-02)', () => {
  it('별을 넣고 빼고, 색인에서 사라진 스킬도 이름으로 남는다', async () => {
    const srv = await startTestServer();
    try {
      const { store } = srv.ctx;
      const row = buildSkillRow({ repo: 'a/b', sha: '0'.repeat(40), dirPath: 'skills/pdf', raw: '---\nname: pdf\ndescription: PDF tools for tests.\n---\n', tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
      store.upsertSkill(row, '');
      const headers = { 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${srv.port}`, 'Content-Type': 'application/json' };
      const call = (method: string, path: string, body?: unknown) => rawRequest({ port: srv.port, method, path, headers, body: body === undefined ? undefined : JSON.stringify(body) });

      assert.equal((await call('POST', '/api/favorites', { id: row.id })).status, 200);
      assert.equal((await call('POST', '/api/favorites', { id: row.id })).status, 200, '두 번 눌러도 하나');
      assert.equal((await call('POST', '/api/favorites', { id: 'gh:no/such:x' })).status, 404, '색인에 없고 이름도 없음');
      assert.equal((await call('POST', '/api/favorites', {})).status, 400);
      assert.equal((await call('POST', '/api/favorites', { id: row.id, name: ' ' })).status, 200, '쓸 수 없는 이름은 무시, 색인의 이름으로');
      assert.deepEqual(JSON.parse((await call('GET', '/api/favorites/ids')).body).ids, [row.id]);
      assert.equal(JSON.parse((await call('GET', '/api/favorites')).body).items[0].name, 'pdf');

      // a result still being checked is not in the index yet: kept by its name, a card once it is indexed
      assert.equal((await call('POST', '/api/favorites', { id: 'gh:new/one:skills/xlsx', name: 'xlsx' })).status, 200);
      assert.deepEqual(JSON.parse((await call('GET', '/api/favorites')).body).gone, [{ id: 'gh:new/one:skills/xlsx', name: 'xlsx' }]);
      assert.equal((await call('DELETE', `/api/favorites?id=${encodeURIComponent('gh:new/one:skills/xlsx')}`)).status, 200);

      store.deleteSkill(row.id);
      assert.deepEqual(JSON.parse((await call('GET', '/api/favorites')).body).gone, [{ id: row.id, name: 'pdf' }]);
      assert.equal((await call('DELETE', `/api/favorites?id=${encodeURIComponent(row.id)}`)).status, 200);
      assert.deepEqual(JSON.parse((await call('GET', '/api/favorites/ids')).body).ids, []);

      // a page on another site cannot change them (same-origin check on writes)
      const cross = await rawRequest({ port: srv.port, method: 'POST', path: '/api/favorites', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ id: row.id }) });
      assert.equal(cross.status, 403);
    } finally {
      await srv.close();
    }
  });

  it('계정이 있던 데이터의 즐겨찾기는 이 PC의 즐겨찾기로 옮기고 계정 표는 지운다', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sf-fav-mig-')), 'skill-finder.db');
    // the database as the version with accounts left it (migration 8)
    const old = new DatabaseSync(path);
    for (const sql of MIGRATIONS.slice(0, 8)) old.exec(sql);
    old.exec('PRAGMA user_version = 8');
    old.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (1, ?, ?, ?), (2, ?, ?, ?)').run('alice', 'x', '2026-11-01', 'bob', 'y', '2026-11-01');
    old.prepare('INSERT INTO favorites (user_id, skill_id, skill_name, created_at) VALUES (1, ?, ?, ?), (2, ?, ?, ?), (2, ?, ?, ?)').run('gh:a/b:pdf', 'pdf', '2026-11-02T01:00:00Z', 'gh:a/b:pdf', 'pdf', '2026-11-01T01:00:00Z', 'gh:c/d:xlsx', 'xlsx', '2026-11-02T02:00:00Z');
    old.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run('sessionKey', '"00"');
    old.close();

    const db = openDb(path);
    try {
      const favs = db.prepare('SELECT skill_id, created_at FROM favorites ORDER BY skill_id').all() as Array<{ skill_id: string; created_at: string }>;
      assert.deepEqual(
        favs.map((f) => [f.skill_id, f.created_at]),
        [
          ['gh:a/b:pdf', '2026-11-01T01:00:00Z'],
          ['gh:c/d:xlsx', '2026-11-02T02:00:00Z'],
        ],
        '두 계정의 같은 스킬은 하나로, 먼저 누른 때로',
      );
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'users'").get()!.n, 0, 'users 표 없음');
      assert.equal(db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'sessionKey'").get()!.n, 0, '세션 키 없음');
    } finally {
      db.close();
    }
  });
});

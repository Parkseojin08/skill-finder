import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, sessionToken, userFromCookie, verifyPassword } from '../src/auth.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { rawRequest, startTestServer } from './helpers.ts';

describe('계정·즐겨찾기 (사용자 결정 2026-11-02)', () => {
  it('비밀번호는 scrypt로 저장하고 맞는 비밀번호만 통과한다', async () => {
    const h = await hashPassword('correct horse');
    assert.match(h, /^scrypt\$16384\$8\$1\$/);
    assert.ok(!h.includes('correct horse'));
    assert.equal(await verifyPassword('correct horse', h), true);
    assert.equal(await verifyPassword('wrong horse', h), false);
    assert.notEqual(await hashPassword('correct horse'), h, '소금이 달라 해시도 다름');
  });

  it('가입·로그인·쿠키·즐겨찾기 흐름; 쿠키를 바꾸거나 비밀번호가 바뀌면 로그인이 풀린다', async () => {
    const srv = await startTestServer();
    try {
      const { store } = srv.ctx;
      const row = buildSkillRow({ repo: 'a/b', sha: '0'.repeat(40), dirPath: 'skills/pdf', raw: '---\nname: pdf\ndescription: PDF tools for tests.\n---\n', tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
      store.upsertSkill(row, '');
      const base = { 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${srv.port}`, 'Content-Type': 'application/json' };
      const call = (method: string, path: string, body?: unknown, cookie?: string) =>
        rawRequest({ port: srv.port, method, path, headers: cookie ? { ...base, Cookie: cookie } : base, body: body === undefined ? undefined : JSON.stringify(body) });

      assert.equal((await call('POST', '/api/auth/signup', { username: 'me', password: 'longenough' })).status, 400, '아이디 3자 이상');
      assert.equal((await call('POST', '/api/auth/signup', { username: 'alice', password: 'short' })).status, 400, '비밀번호 8자 이상');
      const signup = await call('POST', '/api/auth/signup', { username: 'alice', password: 'longenough' });
      assert.equal(signup.status, 201, signup.body);
      const setCookie = String(signup.headers['set-cookie']);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      const cookie = setCookie.split(';')[0];
      assert.equal((await call('POST', '/api/auth/signup', { username: 'ALICE', password: 'longenough' })).status, 409, '대소문자만 다른 아이디도 같은 아이디');

      assert.deepEqual(JSON.parse((await call('GET', '/api/auth/me', undefined, cookie)).body).user.username, 'alice');
      assert.equal(JSON.parse((await call('GET', '/api/auth/me')).body).user, null);
      assert.equal(JSON.parse((await call('GET', '/api/auth/me', undefined, `${cookie.slice(0, -2)}xx`)).body).user, null, '서명을 바꾸면 무효');

      assert.equal((await call('POST', '/api/favorites', { id: row.id })).status, 401, '로그인 없이는 안 됨');
      assert.equal((await call('POST', '/api/favorites', { id: row.id }, cookie)).status, 200);
      assert.equal((await call('POST', '/api/favorites', { id: row.id }, cookie)).status, 200, '두 번 눌러도 하나');
      assert.equal((await call('POST', '/api/favorites', { id: 'gh:no/such:x' }, cookie)).status, 404);
      assert.deepEqual(JSON.parse((await call('GET', '/api/favorites/ids', undefined, cookie)).body).ids, [row.id]);
      const list = JSON.parse((await call('GET', '/api/favorites', undefined, cookie)).body);
      assert.equal(list.items[0].name, 'pdf');

      // the skill leaves the index: still listed by name, and can be removed
      store.deleteSkill(row.id);
      assert.deepEqual(JSON.parse((await call('GET', '/api/favorites', undefined, cookie)).body).gone, [{ id: row.id, name: 'pdf' }]);
      assert.equal((await call('DELETE', `/api/favorites?id=${encodeURIComponent(row.id)}`, undefined, cookie)).status, 200);
      assert.deepEqual(JSON.parse((await call('GET', '/api/favorites/ids', undefined, cookie)).body).ids, []);

      // other accounts do not see them; a wrong password is refused, and five in a row wait
      assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'wrong-pass' })).status, 401);
      assert.equal((await call('POST', '/api/auth/login', { username: 'nobody', password: 'wrong-pass' })).status, 401, '없는 아이디도 같은 답');
      for (let i = 0; i < 4; i++) await call('POST', '/api/auth/login', { username: 'alice', password: 'wrong-pass' });
      assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'longenough' })).status, 429);

      const user = store.getUserByName('alice')!;
      const old = sessionToken(store, user);
      assert.equal(userFromCookie(store, `sf_session=${old}`)?.username, 'alice');
      srv.ctx.store.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword('another password'), user.id);
      assert.equal(userFromCookie(store, `sf_session=${old}`), null, '비밀번호가 바뀌면 예전 로그인은 끝');
      assert.equal(userFromCookie(store, `sf_session=${sessionToken(store, user, Date.now() - 31 * 86_400_000)}`), null, '30일이 지나면 끝');

      const out = await call('POST', '/api/auth/logout', {}, cookie);
      assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
    } finally {
      await srv.close();
    }
  });
});

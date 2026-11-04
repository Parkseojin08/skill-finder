import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rawRequest, startTestServer, type TestServer } from './helpers.ts';

// npx unpacks the package under ~/.npm/_npx/..., a path with a dot folder in it
describe('웹 화면: 점(.)으로 시작하는 폴더 아래 설치', () => {
  let srv: TestServer;
  let base: string;
  before(async () => {
    base = mkdtempSync(join(tmpdir(), 'skill-finder-web-'));
    const dist = join(base, '.npm', '_npx', 'abc', 'node_modules', 'skill-finder', 'web', 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Skill Finder</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    srv = await startTestServer({}, { webDistDir: dist });
  });
  after(async () => {
    await srv.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('첫 화면(/)과 앱 안 주소가 index.html을 준다', async () => {
    for (const path of ['/', '/installed', '/skills/a/b']) {
      const r = await rawRequest({ port: srv.port, path });
      assert.equal(r.status, 200, path);
      assert.match(r.body, /<title>Skill Finder<\/title>/, path);
      assert.equal(r.headers['cache-control'], 'no-cache', path);
    }
  });

  it('번들 파일도 받는다', async () => {
    const r = await rawRequest({ port: srv.port, path: '/assets/app.js' });
    assert.equal(r.status, 200);
  });

  it('dist 안의 점 파일은 여전히 내주지 않는다', async () => {
    writeFileSync(join(base, '.npm', '_npx', 'abc', 'node_modules', 'skill-finder', 'web', 'dist', '.secret'), 'x');
    const r = await rawRequest({ port: srv.port, path: '/.secret' });
    assert.notEqual(r.body, 'x', '점 파일 내용이 나가지 않음');
  });
});

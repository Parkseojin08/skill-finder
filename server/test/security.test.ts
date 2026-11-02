import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { after, before, describe, it } from 'node:test';
import { rawRequest, startTestServer, type TestServer } from './helpers.ts';

describe('§12 보안', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer();
  });
  after(() => srv.close());

  const api = { 'X-Skill-Finder': '1' };

  it('정상 요청은 통과한다', async () => {
    const r = await rawRequest({ port: srv.port, path: '/api/health', headers: api });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);
    // the launcher tells Skill Finder from other dev servers by this fixed value
    assert.equal(JSON.parse(r.body).app, 'skill-finder');
  });

  it('localhost Host도 허용한다', async () => {
    const r = await rawRequest({ port: srv.port, host: `localhost:${srv.port}`, path: '/api/health', headers: api });
    assert.equal(r.status, 200);
  });

  it('대문자 경로(/API)로 헤더·출처 검사를 건너뛸 수 없다', async () => {
    for (const path of ['/API/health', '/aPi/health', '/API/HEALTH']) {
      const r = await rawRequest({ port: srv.port, path });
      assert.equal(r.status, 403, `${path} 헤더 없이`);
      const withHeader = await rawRequest({ port: srv.port, path, headers: api });
      assert.notEqual(withHeader.status, 200, `${path}는 API로 가지 않음`);
    }
    const post = await rawRequest({ port: srv.port, method: 'POST', path: '/API/sync', headers: { ...api, Origin: 'http://evil.example' } });
    assert.equal(post.status, 403);
  });

  it('다른 사이트에서 온 요청(Sec-Fetch-Site: cross-site)은 403', async () => {
    const r = await rawRequest({ port: srv.port, path: '/api/health', headers: { ...api, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
    const same = await rawRequest({ port: srv.port, path: '/api/health', headers: { ...api, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(same.status, 200);
  });

  it('Host가 evil.example이면 403', async () => {
    const r = await rawRequest({ port: srv.port, host: 'evil.example', path: '/api/health', headers: api });
    assert.equal(r.status, 403);
  });

  it('포트가 다른 Host도 403 (DNS 리바인딩)', async () => {
    const r = await rawRequest({ port: srv.port, host: `127.0.0.1:${srv.port + 1}`, path: '/api/health', headers: api });
    assert.equal(r.status, 403);
  });

  it('커스텀 헤더가 없으면 403', async () => {
    const r = await rawRequest({ port: srv.port, path: '/api/health' });
    assert.equal(r.status, 403);
  });

  it('Origin이 다른 POST는 403', async () => {
    const r = await rawRequest({
      port: srv.port,
      method: 'POST',
      path: '/api/search',
      headers: { ...api, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: '{"query":"pdf"}',
    });
    assert.equal(r.status, 403);
  });

  it('Origin이 없는 POST도 403', async () => {
    const r = await rawRequest({
      port: srv.port,
      method: 'POST',
      path: '/api/sync',
      headers: { ...api, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 403);
  });

  it('앱 출처 POST는 보안 검사를 통과한다', async () => {
    const r = await rawRequest({
      port: srv.port,
      method: 'POST',
      path: '/api/does-not-exist',
      headers: { ...api, Origin: `http://127.0.0.1:${srv.port}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 404);
  });

  it('CORS preflight에 CORS 헤더를 내보내지 않는다', async () => {
    const r = await rawRequest({
      port: srv.port,
      method: 'OPTIONS',
      path: '/api/search',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-skill-finder' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });

  it('루프백에만 바인딩되어 다른 인터페이스로는 접속할 수 없다', async () => {
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i!.address);
    for (const address of external) {
      const ok = await new Promise<boolean>((resolve) => {
        const sock = connect({ host: address, port: srv.port, timeout: 1500 });
        sock.on('connect', () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => resolve(false));
        sock.on('timeout', () => {
          sock.destroy();
          resolve(false);
        });
      });
      assert.equal(ok, false, `${address}:${srv.port} 에 접속되면 안 된다`);
    }
  });
});

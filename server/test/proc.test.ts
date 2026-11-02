import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../src/util/proc.ts';

describe('로그·진단·오류 처리 (전체 점검 F2)', () => {
  it('시간을 넘기면 그 프로세스가 띄운 하위 프로세스까지 끝낸다', async () => {
    // the child starts a grandchild that would outlive it, prints its pid, and waits
    const code =
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });" +
      'console.log(c.pid); setTimeout(() => {}, 60000);';
    const r = await run(process.execPath, ['-e', code], { timeoutMs: 1500 });
    assert.equal(r.timedOut, true);
    const pid = Number(r.stdout.trim());
    assert.ok(pid > 0, r.stdout);
    await new Promise((done) => setTimeout(done, 800));
    assert.throws(() => process.kill(pid, 0), '손자 프로세스도 끝남');
  });

  it('로그 파일에는 토큰과 홈 폴더 이름을 가려서 쓴다', async () => {
    const { homedir } = await import('node:os');
    const { maskSecrets, startLogFile, logTail } = await import('../src/util/log.ts');
    const token = 'ghp_' + 'a1B2'.repeat(9);
    assert.equal(maskSecrets(`token ${token} at ${join(homedir(), 'x')}`), `token [가림] at ${join('~', 'x')}`);
    assert.equal(maskSecrets('GITHUB_TOKEN=abc123secretvalue'), 'GITHUB_TOKEN=[가림]');
    const dir = mkdtempSync(join(tmpdir(), 'sf-log-'));
    const file = startLogFile(dir, ['custom-secret-value']);
    console.log('hello custom-secret-value', token);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /INFO hello \[가림\] \[가림\]/);
    assert.ok(!text.includes('custom-secret-value') && !text.includes(token));
    assert.match(logTail(5), /hello/);
  });

  it('진단 정보에는 버전·개수가 있고 토큰은 없다; 화면 오류는 로그에 남는다', async () => {
    const { rawRequest, startTestServer } = await import('./helpers.ts');
    const { startLogFile } = await import('../src/util/log.ts');
    startLogFile(mkdtempSync(join(tmpdir(), 'sf-diag-')));
    const token = 'ghp_' + 'Zz9'.repeat(12);
    const srv = await startTestServer({ githubToken: token });
    try {
      const headers = { 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${srv.port}`, 'Content-Type': 'application/json' };
      const posted = await rawRequest({ port: srv.port, method: 'POST', path: '/api/client-error', headers, body: JSON.stringify({ message: 'boom in SearchPage' }) });
      assert.equal(posted.status, 204);
      const r = await rawRequest({ port: srv.port, path: '/api/diagnostics', headers });
      assert.equal(r.status, 200);
      const { text } = JSON.parse(r.body) as { text: string };
      assert.match(text, /^Skill Finder .* · Node v/);
      assert.match(text, /GitHub 토큰 있음/);
      assert.match(text, /boom in SearchPage/, '방금 남긴 화면 오류가 최근 로그에 있음');
      assert.ok(!text.includes(token));
    } finally {
      await srv.close();
    }
  });
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { run } from '../src/util/proc.ts';

/** A child that starts a grandchild (its code given), prints the grandchild's pid, and waits. */
const parentOf = (grandchild: string) =>
  `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });` +
  'console.log(c.pid); setTimeout(() => {}, 60000);';
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Waits until the process is gone, up to `ms`; whether it went. */
async function gone(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!alive(pid)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return !alive(pid);
}

describe('로그·진단·오류 처리 (전체 점검 F2)', () => {
  it('시간을 넘기면 그 프로세스가 띄운 하위 프로세스까지 끝낸다', async () => {
    const r = await run(process.execPath, ['-e', parentOf('setTimeout(() => {}, 60000)')], { timeoutMs: 1500 });
    assert.equal(r.timedOut, true);
    const pid = Number(r.stdout.trim());
    assert.ok(pid > 0, r.stdout);
    assert.ok(await gone(pid, 1500), '손자 프로세스도 끝남');
  });

  it('끝내라는 신호를 무시하는 하위 프로세스도 잠시 뒤 끝낸다', async () => {
    // SIGTERM is ignored (Windows has no SIGTERM to catch: taskkill /F ends it at once)
    const r = await run(process.execPath, ['-e', parentOf("process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)")], { timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    const pid = Number(r.stdout.trim());
    assert.ok(pid > 0, r.stdout);
    assert.ok(await gone(pid, 4000), '신호를 무시한 손자 프로세스도 끝남');
  });

  // A stand-in for the app (src/index.ts): runs a long command through run() and, once it has the grandchild's pid,
  // ends the way the app does: process.exit, or a signal that its handlers turn into endChildren() and process.exit.
  // The grandchild writes a file when it is asked to end (SIGTERM): a chance to clean up, as git does with a clone.
  const appEnding = async (how: 'exit' | 'SIGINT' | 'SIGTERM' | 'SIGHUP') => {
    const marker = join(mkdtempSync(join(tmpdir(), 'sf-proc-')), 'asked-to-end');
    // "ready" once its handler is in place (a signal before that would end it without one), on the output it shares
    const grandchild = `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }); console.log('ready'); setTimeout(() => {}, 60000)`;
    const parent =
      `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'ignore'] });` +
      'console.log(c.pid); setTimeout(() => {}, 60000);';
    const proc = JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', 'util', 'proc.ts')).href);
    const app =
      `import { run, endChildren } from ${proc};` +
      `for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void endChildren().finally(() => process.exit(0)));` +
      `run(process.execPath, ['-e', ${JSON.stringify(parent)}], { onLine: (line) => { if (line !== 'ready') { console.log(line); return; }` +
      (how === 'exit' ? 'process.exit(0);' : `process.kill(process.pid, '${how}');`) +
      ' } });';
    const out = await new Promise<string>((done, fail) =>
      execFile(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', app], { timeout: 15000 }, (err, stdout) => (err ? fail(err) : done(stdout))),
    );
    const pid = Number(out.trim());
    assert.ok(pid > 0, out);
    assert.ok(await gone(pid, 3000), `${how}: 앱이 꺼진 뒤 남은 프로세스가 없음`);
    return existsSync(marker);
  };

  const posixOnly = { skip: process.platform === 'win32' && 'Windows는 프로세스 그룹을 따로 두지 않음' };
  it('앱이 실행 도중 꺼지면 띄운 프로세스와 그 하위 프로세스도 함께 끝난다', posixOnly, async () => {
    await appEnding('exit');
  });

  it('Ctrl+C·종료 요청·터미널 창 닫기로 꺼질 때는 하위 프로세스가 스스로 끝날 기회를 먼저 얻는다', posixOnly, async () => {
    for (const how of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) assert.equal(await appEnding(how), true, `${how}: 손자 프로세스가 SIGTERM을 받고 정리함`);
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
      // the runtime it runs on: Bun in development, Node in the zip and the npm package (D#b7e3)
      assert.match(text, process.versions.bun ? /^Skill Finder .* · Bun \d/ : /^Skill Finder .* · Node v/);
      assert.match(text, /GitHub 토큰 있음/);
      assert.match(text, /boom in SearchPage/, '방금 남긴 화면 오류가 최근 로그에 있음');
      assert.ok(!text.includes(token));
    } finally {
      await srv.close();
    }
  });
});

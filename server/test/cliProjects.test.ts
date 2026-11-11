// bin/skill-finder.mjs `check` (F12) against a stand-in for the app's API: no network, no real app (every call names
// the stand-in's port, the only one the CLI then looks at), and `lint` (F15) on temporary skill folders, which the CLI
// reads itself without the app. Exit codes are what CI reads.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'skill-finder.mjs');
const dataDir = mkdtempSync(join(tmpdir(), 'sf-cli-proj-'));
after(() => rmSync(dataDir, { recursive: true, force: true }));

type Run = { code: number; out: string; err: string };
const cli = (args: string[]) =>
  new Promise<Run>((done) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, PORT: '', SKILL_FINDER_LANG: 'en', SKILL_FINDER_DATA_DIR: dataDir }, timeout: 20_000 },
      (error, out, err) => done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err }),
    );
  });

type Seen = { method: string; url: string; body: string };
async function fakeApp(routes: Record<string, (body: string, url: string) => { status?: number; body: string }>) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body });
      if (req.headers['x-skill-finder'] !== '1') return void res.writeHead(403).end();
      if (req.url === '/api/health') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ app: 'skill-finder', pid: process.pid }));
      const path = req.url!.split('?')[0];
      const route = routes[`${req.method} ${path}`];
      if (!route) return void res.writeHead(404).end('{"error":"없는 경로"}');
      const r = route(body, req.url!);
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' }).end(r.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return { port, seen, close: () => new Promise<void>((done) => server.close(() => done())) };
}

const counts = (c: Partial<Record<string, number>> = {}) => ({ ok: 0, missing: 0, differs: 0, extra: 0, disabled: 0, unregistered: 0, ...c });
const item = (kind: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  kind,
  name,
  status,
  source: null,
  ref: null,
  skillPath: null,
  skillId: null,
  paths: [],
  agents: [],
  notForClaude: false,
  lockHash: null,
  localHash: null,
  hashNote: null,
  marketplace: null,
  preset: null,
  ...extra,
});
const standard = (over: Record<string, unknown>) =>
  JSON.stringify({ projectPath: 'X', files: { lock: 'read', settings: 'read' }, hasStandard: true, ok: true, counts: counts(), items: [], missingPreset: [], refNote: false, ...over });

describe('CLI check (F12)', () => {
  it('맞으면 0, 지금 폴더가 기본, --json', async () => {
    const app = await fakeApp({ 'GET /api/projects/standard': () => ({ body: standard({ counts: counts({ ok: 1 }), items: [item('skill', 'pdf', 'ok', { source: 'o/r' })] }) }) });
    try {
      const r = await cli(['check', '--port', String(app.port)]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /\[OK\] skill pdf {2}o\/r/);
      assert.match(r.out, /Matches the project standard/);
      const asked = new URL(app.seen.find((s) => s.url.startsWith('/api/projects/standard'))!.url, 'http://x');
      assert.equal(asked.searchParams.get('projectPath'), resolve(process.cwd()));
      const j = await cli(['check', 'some/dir', '--json', '--port', String(app.port)]);
      assert.equal(j.code, 0);
      const parsed = JSON.parse(j.out);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.items[0].status, 'ok');
      assert.equal(parsed.items[0].preset, undefined, 'the dialog input stays in the app');
      const last = new URL(app.seen.at(-1)!.url, 'http://x');
      assert.equal(last.searchParams.get('projectPath'), resolve('some/dir'));
    } finally {
      await app.close();
    }
  });

  it('어긋나면 1 (설치 안 됨·내용 다름), 표준에 없음은 알리기만', async () => {
    const app = await fakeApp({
      'GET /api/projects/standard': () => ({
        body: standard({
          ok: false,
          counts: counts({ missing: 1, differs: 1, extra: 1 }),
          items: [item('skill', 'gone', 'missing', { source: 'o/r', ref: 'v2' }), item('skill', 'edited', 'differs'), item('skill', 'mine', 'extra', { notForClaude: true }), item('plugin', 'p@m', 'unregistered', { marketplace: 'm' })],
        }),
      }),
    });
    try {
      const r = await cli(['check', '--port', String(app.port)]);
      assert.equal(r.code, 1);
      assert.match(r.out, /\[not installed\] skill gone {2}o\/r#v2/);
      assert.match(r.out, /\[content differs\] skill edited/);
      assert.match(r.out, /\[not in the standard\] skill mine {2}\(not in a Claude Code folder\)/);
      assert.match(r.out, /\[marketplace not added\] plugin p@m {2}m/);
      assert.match(r.out, /3 item\(s\) differ/);
      const j = await cli(['check', '--json', '--port', String(app.port)]);
      assert.equal(j.code, 1);
      assert.equal(JSON.parse(j.out).ok, false);
    } finally {
      await app.close();
    }
  });

  it('표준이 없으면 0과 안내, 서버 오류는 1', async () => {
    const app = await fakeApp({
      'GET /api/projects/standard': (_b, url) =>
        url.includes('broken') ? { status: 400, body: JSON.stringify({ error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' }) } : { body: standard({ hasStandard: false, files: { lock: 'missing', settings: 'missing' } }) },
    });
    try {
      const r = await cli(['check', '--port', String(app.port)]);
      assert.equal(r.code, 0);
      assert.match(r.out, /has no project standard/);
      const bad = await cli(['check', 'broken', '--port', String(app.port)]);
      assert.equal(bad.code, 1);
      assert.match(bad.err, /Failed: /);
    } finally {
      await app.close();
    }
  });
});

describe('CLI lint (F15)', () => {
  const skill = (name: string, body: string) => {
    const dir = join(dataDir, 'lint', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), ['---', `name: ${name}`, `description: ${name} takes notes from PDF files.`, '---', body, ''].join('\n'));
    return dir;
  };

  it('앱 없이 폴더를 직접 읽는다: 고칠 것이 있으면 1, 없으면 0, 폴더가 아니면 2', async () => {
    const good = skill('pdf-notes', 'Body.');
    const bad = skill('bad-skill', ['```bash', 'cat ~/.ssh/id_rsa', '```'].join('\n'));
    // a port nothing listens on: the command must not need the app
    const ok = await cli(['lint', good, '--port', '9']);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /pdf-notes/);
    assert.match(ok.out, /Nothing to fix\./);
    const r = await cli(['lint', bad]);
    assert.equal(r.code, 1);
    assert.match(r.out, /1 problem\(s\) to fix/);
    assert.match(r.out, /\[warning\] .+ {2}\(SKILL\.md:6\)/);
    const j = await cli(['lint', bad, '--json']);
    assert.equal(j.code, 1);
    const parsed = JSON.parse(j.out) as { ok: boolean; problems: Array<{ code: string; severity: string; line?: number }>; similar: unknown };
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.problems.map((p) => [p.code, p.severity, p.line]), [['credentialAccess', 'warning', 6]]);
    assert.equal(parsed.similar, null, '색인 없이 검사하므로 비슷한 스킬은 없음');
    const missing = await cli(['lint', join(dataDir, 'lint', 'nope')]);
    assert.equal(missing.code, 2);
    assert.match(missing.out, /Not a folder/);
    const none = await cli(['lint']);
    assert.equal(none.code, 1);
    assert.match(none.err, /Give a skill folder/);
  });

  it('도움말에 check와 lint가 있다', async () => {
    for (const lang of ['en', 'ko', 'ja']) {
      const r = await cli(['--help', '--lang', lang]);
      assert.match(r.out, /skill-finder check/);
      assert.match(r.out, /skill-finder lint/);
    }
  });
});

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// bin/skill-finder.mjs against a stand-in for the app's API: no network, no real app, and it never starts one
// (every call names the stand-in's port, the only one the CLI then looks at).
const BIN = join(import.meta.dirname, '..', '..', 'bin', 'skill-finder.mjs');
const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version;
const dataDir = mkdtempSync(join(tmpdir(), 'sf-cli-'));
after(() => rmSync(dataDir, { recursive: true, force: true }));

type Run = { code: number; out: string; err: string };
const cli = (args: string[]) =>
  new Promise<Run>((resolve) => {
    // async: the stand-in answers from this process
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, PORT: '', SKILL_FINDER_LANG: 'en', SKILL_FINDER_DATA_DIR: dataDir }, timeout: 20_000 },
      (error, out, err) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err }),
    );
  });

type Seen = { method: string; url: string; body: string; headers: Record<string, unknown> };
async function fakeApp(routes: Record<string, (body: string) => { status?: number; body: string }>, pid = process.pid) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body, headers: req.headers });
      if (req.headers['x-skill-finder'] !== '1') return void res.writeHead(403).end();
      const health = () => ({ body: JSON.stringify({ app: 'skill-finder', pid }) });
      const route: ((body: string) => { status?: number; body: string }) | undefined = req.url === '/api/health' ? health : routes[`${req.method} ${req.url}`];
      if (!route) return void res.writeHead(404).end('{"error":"없는 경로"}');
      const r = route(body);
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' }).end(r.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return { port, seen, close: () => new Promise<void>((done) => server.close(() => done())) };
}

const item = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `gh:o/r:skills/${name}`,
  name,
  description: `${name} skill   for tests`,
  installs: 1500,
  stars: 20,
  riskLevel: 'low',
  riskFlags: [],
  install: { method: 'skills-cli', command: `npx skills@1.7.4 add o/r --skill ${name} -a claude-code --copy -g` },
  sources: [{ url: `https://github.com/o/r/tree/main/skills/${name}` }],
  ...extra,
});

describe('CLI (bin/skill-finder.mjs)', () => {
  it('도움말·버전·모르는 명령', async () => {
    const help = await cli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage:/);
    assert.match((await cli(['--help', '--lang', 'ja'])).out, /使い方:/);
    assert.match((await cli(['--help', '--lang', 'ko'])).out, /사용법:/);
    assert.equal((await cli(['--version'])).out.trim(), VERSION);
    const unknown = await cli(['frobnicate']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.out, /Usage:/);
  });

  it('search: 마지막 결과 묶음을, --limit만큼, --risk는 서버 필터로', async () => {
    const app = await fakeApp({
      // a slow search sends interim results first
      'POST /api/search': () => ({
        body: [{ type: 'results', items: [item('early')] }, { type: 'progress' }, { type: 'results', items: [item('pdf'), item('xlsx'), item('docx')] }, { type: 'done' }]
          .map((e) => JSON.stringify(e))
          .join('\n'),
      }),
    });
    try {
      const r = await cli(['search', 'pdf', 'tables', '--port', String(app.port), '--json', '--limit', '2', '--risk', 'low']);
      assert.equal(r.code, 0, r.err);
      const items = JSON.parse(r.out);
      assert.deepEqual(items.map((i: { name: string }) => i.name), ['pdf', 'xlsx']);
      assert.deepEqual(Object.keys(items[0]).sort(), ['description', 'id', 'installCommand', 'installMethod', 'installs', 'name', 'repo', 'riskFlags', 'riskLevel', 'stars', 'url'].sort());
      assert.equal(items[0].repo, 'o/r');
      const call = app.seen.find((s) => s.url === '/api/search')!;
      assert.deepEqual(JSON.parse(call.body), { query: 'pdf tables', filters: { maxRisk: 'low' } });
      // the page's own header and origin, as the app's checks want
      assert.equal(call.headers.origin, `http://127.0.0.1:${app.port}`);

      const text = await cli(['search', 'pdf', '--port', String(app.port)]);
      assert.match(text.out, /^pdf {2}\[Low risk\] {2}↓1\.5K ★20 {2}o\/r$/m);
      assert.match(text.out, /^ {2}pdf skill for tests$/m, '설명의 공백은 하나로');
      assert.match(text.out, /not a safety guarantee/);
      assert.equal((await cli(['search', '--port', String(app.port)])).code, 1, '검색어 없음');
    } finally {
      await app.close();
    }
  });

  it('show: 설치 명령, 없는 스킬은 서버의 오류 그대로', async () => {
    const id = 'gh:o/r:skills/pdf';
    const app = await fakeApp({
      [`GET /api/skills/${encodeURIComponent(id)}`]: () => ({ body: JSON.stringify({ ...item('pdf'), whenToUse: 'PDF 작업' }) }),
    });
    try {
      const json = JSON.parse((await cli(['show', id, '--port', String(app.port), '--json'])).out);
      assert.equal(json.installCommand, 'npx skills@1.7.4 add o/r --skill pdf -a claude-code --copy -g');
      assert.equal(json.whenToUse, 'PDF 작업');
      assert.match((await cli(['show', id, '--port', String(app.port)])).out, /^Install: npx skills@1\.7\.4 add o\/r/m);
      const missing = await cli(['show', 'gh:o/r:nope', '--port', String(app.port)]);
      assert.equal(missing.code, 1);
      assert.match(missing.err, /Failed: 없는 경로/);
      assert.equal((await cli(['show', '--port', String(app.port)])).code, 1, 'id 없음');
    } finally {
      await app.close();
    }
  });

  it('stop: 자기가 켠 서버만 끈다 (다른 pid면 그대로 두고 기록만 지움)', async () => {
    const pidFile = join(dataDir, 'cli-server.json');
    // a stale record: the port now answers with another process
    const other = await fakeApp({});
    try {
      writeFileSync(pidFile, JSON.stringify({ pid: 999_999, port: other.port }));
      const r = await cli(['stop']);
      assert.match(r.out, /No Skill Finder started by this command/);
      assert.ok(!existsSync(pidFile));
    } finally {
      await other.close();
    }

    // its own: a stand-in process whose pid the health answer reports
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = new Promise((done) => child.on('exit', done));
    const mine = await fakeApp({}, child.pid);
    try {
      writeFileSync(pidFile, JSON.stringify({ pid: child.pid, port: mine.port }));
      assert.match((await cli(['stop'])).out, /Stopped Skill Finder/);
      await exited;
      assert.ok(!existsSync(pidFile));
    } finally {
      child.kill();
      await mine.close();
    }
  });
});

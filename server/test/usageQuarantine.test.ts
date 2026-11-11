// Stage 3 bundle B (feature review 2026-11-04): F11 skill use counts read from Claude Code's transcripts, F14 copies
// kept before a delete or overwrite and undo. Transcripts are the made-up fixture under fixtures/usage (the format
// checked on a real PC, no real text) in a temporary home; skill folders are temporary projects. Nothing real is
// read, installed or removed.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import express from 'express';
import { createContext } from '../src/bootstrap.ts';
import type { AppContext } from '../src/context.ts';
import { dropQuarantine, listQuarantine, measureFolder, pruneQuarantine, quarantineFolder, quarantineRoot, restoreQuarantine, runQuarantinePrune, skillFolderTarget } from '../src/install/quarantine.ts';
import { uninstallSkill } from '../src/install/uninstall.ts';
import { installRouter } from '../src/routes/install.ts';
import { quarantineRouter } from '../src/routes/quarantine.ts';
import { usageRouter } from '../src/routes/usage.ts';
import { searchActivity } from '../src/search/activity.ts';
import { securityMiddleware } from '../src/security.ts';
import { getSettings, saveSettings } from '../src/settings.ts';
import { localDay, splitSkillName, usesInLine } from '../src/usage/parse.ts';
import { clearUsage, readLines, runUsageScan, transcriptFiles } from '../src/usage/scan.ts';
import { usageSummary, windowStart } from '../src/usage/summary.ts';
import { rawRequest } from './helpers.ts';

const FIXTURE = readFileSync(new URL('./fixtures/usage/session.jsonl', import.meta.url), 'utf8');
const temps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ctxOf = (): AppContext => createContext({ port: 0, dev: false, dataDir: tmp('sf-s3b-data-'), githubToken: null }, ':memory:');
const turnOn = (ctx: AppContext, on = true) => saveSettings(ctx.store, { ...getSettings(ctx.store), usageScan: on });
const usageRows = (ctx: AppContext) =>
  ctx.store.db.prepare('SELECT day, project_path, skill, plugin, count FROM skill_usage ORDER BY day, skill, project_path').all() as Array<{ day: string; project_path: string; skill: string; plugin: string; count: number }>;
const total = (ctx: AppContext) => usageRows(ctx).reduce((n, r) => n + r.count, 0);

/** A home with the fixture as one session and one subagent file of another project. */
function homeWithTranscripts(): { home: string; main: string; sub: string } {
  const home = tmp('sf-s3b-home-');
  const dir = join(home, '.claude', 'projects', 'C--work-alpha');
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true });
  const main = join(dir, 's1.jsonl');
  writeFileSync(main, FIXTURE);
  const sub = join(dir, 's1', 'subagents', 'agent-x.jsonl');
  writeFileSync(sub, line({ id: 'toolu_SUB', skill: 'exa-search', ts: '2026-11-03T12:00:00.000Z', cwd: 'C:\\work\\alpha' }) + '\n');
  // not transcripts: another extension, a file one level too deep
  writeFileSync(join(dir, 'notes.txt'), line({ id: 'toolu_NO', skill: 'nope', ts: '2026-11-03T12:00:00.000Z' }) + '\n');
  mkdirSync(join(dir, 's1', 'other'), { recursive: true });
  writeFileSync(join(dir, 's1', 'other', 'x.jsonl'), line({ id: 'toolu_NO2', skill: 'nope', ts: '2026-11-03T12:00:00.000Z' }) + '\n');
  return { home, main, sub };
}

function line(o: { id: string; skill: string; ts: string; cwd?: string }): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: o.id, name: 'Skill', input: { skill: o.skill } }] },
    uuid: 'x' + o.id,
    timestamp: o.ts,
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
  });
}

async function serve(ctx: AppContext, routers: express.Router[]): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(securityMiddleware(ctx.config));
  app.use('/api', express.json({ limit: '64kb' }));
  for (const r of routers) app.use('/api', r);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  ctx.config.port = (server.address() as AddressInfo).port;
  return { port: ctx.config.port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const api = (port: number, method: string, path: string, body?: unknown) =>
  rawRequest({
    port,
    method,
    path,
    headers: { 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${port}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => ({ status: r.status, json: JSON.parse(r.body || 'null') }));

describe('F11 대화 기록 한 줄 읽기', () => {
  const uses = FIXTURE.split('\n').flatMap((l) => usesInLine(l));

  it('Skill tool_use(skill·command)와 사용자 명령 태그만 센다', () => {
    assert.deepEqual(
      uses.map((u) => [u.day, u.project, u.plugin, u.skill, u.key]),
      [
        [localDay('2026-11-01T12:01:00.000Z'), 'C:\\work\\alpha', '', 'tidy-notes', 'u2'],
        [localDay('2026-11-01T12:02:00.000Z'), 'C:\\work\\alpha', 'anthropic-skills', 'pdf', 'toolu_A1'],
        [localDay('2026-11-02T12:00:00.000Z'), 'C:\\work\\alpha\\sub', '', 'game-engine', 'toolu_A2'],
        [localDay('2026-11-02T12:05:00.000Z'), 'C:\\work\\beta', '', 'game-engine', 'toolu_A3'],
        [localDay('2026-11-02T12:05:00.000Z'), 'C:\\work\\beta', '', 'game-engine', 'toolu_A3'], // same id: dropped by the scan
        [localDay('2026-10-01T12:00:00.000Z'), '', '', 'tidy-notes', 'toolu_A6'],
      ],
    );
  });

  it('대화 본문·인자·기본 명령·인용한 태그는 남기지 않는다', () => {
    const all = JSON.stringify(uses);
    for (const bad of ['SECRET', 'ARGS', 'model', 'not-a-use', 'also-not', 'fake-in-result', 'rm -rf', 'explain']) assert.ok(!all.includes(bad), bad);
  });

  it('이름 나누기: plugin:skill, 앞의 /, 허용 안 되는 문자', () => {
    assert.deepEqual(splitSkillName('/Plugin-A:My.Skill'), { plugin: 'plugin-a', skill: 'my.skill' });
    assert.deepEqual(splitSkillName('solo'), { plugin: '', skill: 'solo' });
    for (const bad of ['', ':x', 'a:', 'a;b', 'a/b', '"x"', 'x'.repeat(201), 42, null]) assert.equal(splitSkillName(bad), null, String(bad));
  });

  it('512KB 악성 줄도 길이에 비례해 끝난다 (D#4de9)', () => {
    const N = 512 * 1024;
    const evil = [
      JSON.stringify({ type: 'user', timestamp: '2026-11-01T00:00:00Z', message: { content: '<command-name>' + '<command-name>'.repeat(N / 14) } }),
      JSON.stringify({ type: 'user', timestamp: '2026-11-01T00:00:00Z', message: { content: '<command-message>' + 'a'.repeat(N) + '</command-name>' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T00:00:00Z', message: { content: Array.from({ length: N / 64 }, () => ({ type: 'tool_use', name: 'Skill', input: { skill: 'a'.repeat(30) + ' ' } })) } }),
      '{"Skill"' + '"Skill"'.repeat(N / 7),
      JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T00:00:00Z', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'a'.repeat(N) } }] } }),
    ];
    for (const l of evil) {
      const t = performance.now();
      usesInLine(l);
      assert.ok(performance.now() - t < 500, `${(performance.now() - t).toFixed(0)}ms`);
    }
  });
});

describe('F11 usage-scan 작업', () => {
  it('설정이 꺼져 있으면 아무것도 읽지 않는다', async () => {
    const ctx = ctxOf();
    const { home } = homeWithTranscripts();
    const r = await runUsageScan(ctx, undefined, { home });
    assert.equal(r.skipped, true);
    assert.equal(total(ctx), 0);
    assert.equal((ctx.store.db.prepare('SELECT COUNT(*) AS n FROM usage_scan_files').get() as { n: number }).n, 0);
  });

  it('projects/*/*.jsonl과 subagents/*.jsonl만 읽고, 이어 읽고, 줄면 처음부터', async () => {
    const ctx = ctxOf();
    turnOn(ctx);
    const { home, main, sub } = homeWithTranscripts();
    assert.deepEqual((await transcriptFiles(home)).sort(), [main, sub].sort());
    const r1 = await runUsageScan(ctx, undefined, { home });
    assert.equal(r1.counts?.files, 2);
    assert.equal(total(ctx), 6, JSON.stringify(usageRows(ctx))); // 5 in the session (one repeat dropped) + 1 subagent
    assert.ok(!usageRows(ctx).some((r) => r.skill === 'nope'));
    assert.deepEqual(
      { ...usageRows(ctx).find((r) => r.plugin === 'anthropic-skills') },
      { day: localDay('2026-11-01T12:02:00.000Z'), project_path: 'C:\\work\\alpha', skill: 'pdf', plugin: 'anthropic-skills', count: 1 },
    );

    // nothing changed: nothing read again
    const r2 = await runUsageScan(ctx, undefined, { home });
    assert.equal(r2.counts?.read, 0);
    assert.equal(total(ctx), 6);

    // a line being written (no newline yet) waits; once whole it is read, and only it
    appendFileSync(main, line({ id: 'toolu_NEW', skill: 'tidy-notes', ts: '2026-11-04T12:00:00.000Z', cwd: 'C:\\work\\alpha' }));
    await runUsageScan(ctx, undefined, { home });
    assert.equal(total(ctx), 6, '끝나지 않은 줄은 세지 않음');
    appendFileSync(main, '\n');
    await runUsageScan(ctx, undefined, { home });
    assert.equal(total(ctx), 7);

    // written anew and shorter: read from the start
    writeFileSync(main, line({ id: 'toolu_R', skill: 'fresh', ts: '2026-11-05T12:00:00.000Z' }) + '\n');
    const r3 = await runUsageScan(ctx, undefined, { home });
    assert.equal(r3.counts?.restarted, 1);
    assert.ok(usageRows(ctx).some((r) => r.skill === 'fresh'));

    // a file gone: its position is forgotten, its counts stay
    rmSync(sub);
    await runUsageScan(ctx, undefined, { home });
    assert.equal((ctx.store.db.prepare('SELECT COUNT(*) AS n FROM usage_scan_files').get() as { n: number }).n, 1);
    assert.ok(usageRows(ctx).some((r) => r.skill === 'exa-search'));

    assert.equal(clearUsage(ctx.store).rows > 0, true);
    assert.equal(total(ctx), 0);
  });

  it('시간 상한에 걸리면 다음 실행에서 이어 읽는다', async () => {
    const ctx = ctxOf();
    turnOn(ctx);
    const { home } = homeWithTranscripts();
    const r1 = await runUsageScan(ctx, undefined, { home, budgetMs: -1 });
    assert.equal(r1.counts?.read, 1);
    assert.equal(r1.counts?.left, 2);
    assert.match(r1.note ?? '', /이어 읽/);
    await runUsageScan(ctx, undefined, { home, budgetMs: -1 });
    await runUsageScan(ctx, undefined, { home });
    assert.equal(total(ctx), 6);
  });

  it('검색 중에는 쉬었다가 끝나면 이어 간다', async () => {
    const ctx = ctxOf();
    turnOn(ctx);
    const { home } = homeWithTranscripts();
    searchActivity.begin();
    let done = false;
    const run = runUsageScan(ctx, undefined, { home }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 450));
    const whileBusy = done;
    searchActivity.end();
    await run;
    assert.equal(whileBusy, false, '검색 중에는 끝나지 않음');
    assert.equal(total(ctx), 6);
  });

  it('읽는 중에 설정이 꺼지면 멈추고, 비운 표에 다시 쓰지 않는다 (리뷰 2026-11-10)', async () => {
    const ctx = ctxOf();
    turnOn(ctx);
    const { home } = homeWithTranscripts();
    // the scan waits on a search; meanwhile the user turns it off and the page clears the tables
    searchActivity.begin();
    const run = runUsageScan(ctx, undefined, { home });
    await new Promise((r) => setTimeout(r, 300));
    turnOn(ctx, false);
    clearUsage(ctx.store);
    searchActivity.end();
    const r = await run;
    assert.equal(r.skipped, true);
    assert.match(r.note ?? '', /꺼져/);
    assert.equal(total(ctx), 0, '꺼진 뒤에는 횟수를 쓰지 않음');
    assert.equal((ctx.store.db.prepare('SELECT COUNT(*) AS n FROM usage_scan_files').get() as { n: number }).n, 0, '읽은 위치도 남기지 않음');
  });

  it('줄 단위 읽기: 아주 긴 줄은 건너뛰고 위치는 정확하다', async () => {
    const dir = tmp('sf-s3b-lines-');
    const f = join(dir, 'x.jsonl');
    const long = 'z'.repeat(3 * 1024 * 1024);
    writeFileSync(f, `first\n${long}\nthird\r\nlast-no-newline`);
    const seen: string[] = [];
    const size = readFileSync(f).length;
    const r = await readLines(f, 0, size, (b) => seen.push(b.toString().slice(0, 10)), async () => false, 1024 * 1024);
    assert.deepEqual(seen, ['first', 'third\r']);
    assert.equal(r.offset, size - 'last-no-newline'.length);
    const r2 = await readLines(f, 6, size, (b) => seen.push(b.toString().slice(0, 10)), async () => false, 8 * 1024 * 1024);
    assert.equal(seen.length, 4, '두 번째 읽기: 긴 줄과 third');
    assert.equal(r2.offset, r.offset);
  });

  it('요약: 마지막 사용일, 30일 횟수, 이 폴더(안쪽 폴더 포함), 한 프로젝트에서만 쓴 것', async () => {
    const ctx = ctxOf();
    turnOn(ctx);
    const { home } = homeWithTranscripts();
    await runUsageScan(ctx, undefined, { home });
    const now = new Date('2026-11-09T12:00:00.000Z');
    assert.equal(windowStart(now), localDay('2026-10-11T12:00:00.000Z'));
    const s = usageSummary(ctx.store, true, 'C:\\work\\alpha', now);
    const get = (plugin: string, skill: string) => s.skills.find((x) => x.plugin === plugin && x.skill === skill)!;
    assert.deepEqual(
      { ...get('', 'tidy-notes') },
      { skill: 'tidy-notes', plugin: '', lastUsed: localDay('2026-11-01T12:01:00.000Z'), count30: 1, lastUsedHere: localDay('2026-11-01T12:01:00.000Z'), count30Here: 1, onlyProject: 'C:\\work\\alpha' },
    );
    assert.equal(get('', 'game-engine').count30, 2);
    assert.equal(get('', 'game-engine').count30Here, 1, 'alpha\\sub는 alpha 안');
    assert.equal(get('', 'game-engine').onlyProject, null);
    assert.equal(get('anthropic-skills', 'pdf').count30, 1);
    assert.equal(usageSummary(ctx.store, true, null, now).skills[0].count30Here, null);
  });
});

describe('F11 /api/usage', () => {
  it('꺼져 있으면 빈 답, 켜면 요약, 폴더 검사, 비우기', async () => {
    const ctx = ctxOf();
    const project = tmp('sf-s3b-proj-');
    const home = tmp('sf-s3b-home2-');
    const dir = join(home, '.claude', 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.jsonl'), line({ id: 't1', skill: 'demo', ts: new Date().toISOString(), cwd: project }) + '\n');
    const srv = await serve(ctx, [usageRouter(ctx)]);
    try {
      assert.deepEqual((await api(srv.port, 'GET', '/api/usage')).json, { enabled: false, scannedAt: null, files: 0, skills: [] });
      turnOn(ctx);
      await runUsageScan(ctx, undefined, { home });
      const r = await api(srv.port, 'GET', `/api/usage?projectPath=${encodeURIComponent(project)}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.enabled, true);
      assert.equal(r.json.files, 1);
      assert.equal(r.json.skills[0].skill, 'demo');
      assert.equal(r.json.skills[0].count30Here, 1);
      assert.equal((await api(srv.port, 'GET', '/api/usage?projectPath=relative')).status, 400);
      // without the app's header or Origin a delete is refused
      assert.equal((await rawRequest({ port: srv.port, method: 'DELETE', path: '/api/usage' })).status, 403);
      assert.equal((await api(srv.port, 'DELETE', '/api/usage')).json.rows, 1);
      assert.equal(total(ctx), 0);
    } finally {
      await srv.close();
    }
  });
});

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} does things.\n---\nBody.\n`;
function projectWithSkill(name = 'demo'): { project: string; folder: string } {
  const project = tmp('sf-s3b-q-');
  const folder = join(project, '.claude', 'skills', name);
  mkdirSync(join(folder, 'scripts'), { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), skillMd(name));
  writeFileSync(join(folder, 'scripts', 'run.sh'), 'echo hi\n');
  return { project, folder };
}

describe('F14 보관과 되돌리기', () => {
  it('복사본: 파일·하위 폴더는 복사, 링크는 따라가지 않음, 링크 폴더는 보관하지 않음', async () => {
    const ctx = ctxOf();
    const { project, folder } = projectWithSkill();
    const outside = tmp('sf-s3b-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'not mine');
    symlinkSync(outside, join(folder, 'linked'), 'junction');
    const k = await quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'delete', name: 'demo', scope: 'project', projectPath: project, originalPath: folder });
    assert.equal(k.kept, true);
    assert.ok(k.kept && k.files === 2 && k.skippedLinks === 1);
    const row = listQuarantine(ctx.store)[0];
    assert.equal(row.reason, 'delete');
    assert.ok(existsSync(join(row.stored_path, 'scripts', 'run.sh')));
    assert.ok(!existsSync(join(row.stored_path, 'linked')));
    assert.ok(row.stored_path.startsWith(quarantineRoot(ctx.config.dataDir)));

    const linkSkill = join(project, '.claude', 'skills', 'via-link');
    symlinkSync(outside, linkSkill, 'junction');
    assert.deepEqual(await quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'delete', name: 'via-link', scope: 'project', projectPath: project, originalPath: linkSkill }), { kept: false, reason: 'link' });
    assert.deepEqual(await quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'delete', name: 'x', scope: 'project', projectPath: project, originalPath: join(project, 'none') }), { kept: false, reason: 'missing' });
  });

  it('20MB를 넘는 폴더는 보관하지 않고 그렇다고 알린다', async () => {
    const ctx = ctxOf();
    const { project, folder } = projectWithSkill('big');
    writeFileSync(join(folder, 'blob.bin'), Buffer.alloc(20 * 1024 * 1024 + 10));
    const k = await quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'overwrite', name: 'big', scope: 'project', projectPath: project, originalPath: folder });
    assert.equal(k.kept, false);
    assert.ok(!k.kept && k.reason === 'tooBig' && (k.bytes ?? 0) > 20 * 1024 * 1024);
    assert.equal(listQuarantine(ctx.store).length, 0);
    assert.equal((await measureFolder(folder)).over, true);
  });

  it('정리: 30일·20개를 넘으면 오래된 것부터, 모르는 폴더도 지운다', async () => {
    const ctx = ctxOf();
    const { project, folder } = projectWithSkill();
    const now = new Date('2026-11-09T00:00:00.000Z');
    const old = await quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'delete', name: 'old', scope: 'project', projectPath: project, originalPath: folder }, new Date('2026-10-01T00:00:00.000Z'));
    for (let i = 0; i < 21; i++) {
      await quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'delete', name: `n${i}`, scope: 'project', projectPath: project, originalPath: folder }, new Date(now.getTime() + i * 1000));
    }
    assert.equal(listQuarantine(ctx.store).length, 20, '새로 넣을 때마다 정리');
    assert.ok(old.kept);
    assert.ok(!listQuarantine(ctx.store).some((r) => r.name === 'old' || r.name === 'n0'));
    const orphan = join(quarantineRoot(ctx.config.dataDir), 'orphan');
    mkdirSync(orphan);
    const young = join(quarantineRoot(ctx.config.dataDir), 'young');
    mkdirSync(young);
    const hourAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(orphan, hourAgo, hourAgo);
    const r = await pruneQuarantine(ctx.store, ctx.config.dataDir);
    assert.equal(r.orphans, 1);
    assert.ok(!existsSync(orphan) && existsSync(young), '막 만든 폴더는 남김');
    // the daily task: 30 days on, all gone
    const later = await pruneQuarantine(ctx.store, ctx.config.dataDir, new Date(now.getTime() + 40 * 86_400_000));
    assert.equal(later.removed, 20);
    assert.deepEqual((await runQuarantinePrune(ctx)).counts, { removed: 0, orphans: 0 });
  });

  it('되돌린 항목은 20개 칸을 차지하지 않는다 (리뷰 2026-11-10)', async () => {
    const ctx = ctxOf();
    const { project, folder } = projectWithSkill();
    const now = new Date('2026-11-09T00:00:00.000Z');
    const keep = (name: string, i: number) =>
      quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'delete', name, scope: 'project', projectPath: project, originalPath: folder }, new Date(now.getTime() + i * 1000));
    for (let i = 0; i < 20; i++) await keep(`n${i}`, i);
    // the two newest were put back: they hold no copy any more
    ctx.store.db.prepare("UPDATE quarantine SET restored_at = ? WHERE name IN ('n18', 'n19')").run(now.toISOString());
    await keep('n20', 20);
    const names = listQuarantine(ctx.store).map((r) => r.name);
    assert.ok(names.includes('n0'), '가장 오래된 복사본이 되돌린 항목 때문에 밀려나지 않음');
    assert.equal(names.length, 21);
    await keep('n21', 21);
    await keep('n22', 22);
    assert.ok(!listQuarantine(ctx.store).some((r) => r.name === 'n0'), '보관 중인 복사본이 20개를 넘으면 오래된 것부터');
  });

  it('되돌리기: 빈 자리에만, 원래 위치를 다시 검사, 보관 위치 밖은 거부', async () => {
    const ctx = ctxOf();
    const { project, folder } = projectWithSkill();
    const k = await quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'delete', name: 'demo', scope: 'project', projectPath: project, originalPath: folder });
    assert.ok(k.kept);
    // still there: nothing is overwritten
    const busy = await restoreQuarantine(ctx.store, ctx.config.dataDir, k.id);
    assert.equal(busy.ok, false);
    assert.ok(!busy.ok && busy.status === 409);
    writeFileSync(join(folder, 'SKILL.md'), 'edited by hand');
    rmSync(folder, { recursive: true });
    const ok = await restoreQuarantine(ctx.store, ctx.config.dataDir, k.id);
    assert.deepEqual(ok, { ok: true, path: folder });
    assert.equal(readFileSync(join(folder, 'SKILL.md'), 'utf8'), skillMd('demo'));
    assert.ok(existsSync(join(folder, 'scripts', 'run.sh')));
    const again = await restoreQuarantine(ctx.store, ctx.config.dataDir, k.id);
    assert.ok(!again.ok && again.status === 409);
    assert.ok(listQuarantine(ctx.store)[0].restored_at);

    // a database row pointing elsewhere is not followed
    const k2 = await quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'delete', name: 'demo', scope: 'project', projectPath: project, originalPath: folder });
    assert.ok(k2.kept);
    rmSync(folder, { recursive: true });
    for (const bad of [join(project, 'elsewhere'), join(project, '.claude', 'skills', 'a', 'b'), join(project, '.claude', 'skills', '..', 'x'), join(tmpdir(), 'x')]) {
      ctx.store.db.prepare('UPDATE quarantine SET original_path = ? WHERE id = ?').run(bad, k2.id);
      const r = await restoreQuarantine(ctx.store, ctx.config.dataDir, k2.id);
      assert.ok(!r.ok && r.status === 400, bad);
    }
    ctx.store.db.prepare('UPDATE quarantine SET original_path = ?, stored_path = ? WHERE id = ?').run(folder, project, k2.id);
    const r = await restoreQuarantine(ctx.store, ctx.config.dataDir, k2.id);
    assert.ok(!r.ok && r.status === 404, '보관 폴더 밖의 stored_path');
    assert.ok(existsSync(project));
    await dropQuarantine(ctx.store, ctx.config.dataDir, k2.id);
    assert.equal(listQuarantine(ctx.store).length, 1);
  });

  it('허용 위치 검사: 에이전트 스킬 폴더 바로 아래만', () => {
    const { project } = projectWithSkill();
    const home = tmp('sf-s3b-h-');
    assert.ok(skillFolderTarget('project', project, join(project, '.agents', 'skills', 'x')));
    assert.ok(skillFolderTarget('user', null, join(home, '.claude', 'skills', 'x'), home));
    assert.equal(skillFolderTarget('user', null, join(home, '.claude', 'x'), home), null);
    assert.equal(skillFolderTarget('project', project, join(project, '.claude', 'skills'), home), null);
    assert.equal(skillFolderTarget('project', join(project, 'missing'), join(project, 'missing', '.claude', 'skills', 'x')), null);
    assert.equal(skillFolderTarget('local', project, join(project, '.claude', 'skills', 'x')), null);
    assert.equal(skillFolderTarget('project', project, join(project, '.claude', 'skills', '..x')), null);
  });

  it('스킬 삭제 직전에 보관하고, 복사가 깨지면 지우지 않는다', async () => {
    const ctx = ctxOf();
    const { project, folder } = projectWithSkill();
    const env = { ...process.env, DISABLE_TELEMETRY: '1' };
    const broken = await uninstallSkill('demo', 'project', project, env, undefined, undefined, async () => ({ kept: false, reason: 'failed', error: 'disk full' }));
    assert.equal(broken.ok, false);
    assert.ok(existsSync(folder), '복사 실패 시 그대로');
    const r = await uninstallSkill('demo', 'project', project, env, undefined, undefined, (target) =>
      quarantineFolder(ctx.store, ctx.config.dataDir, { reason: 'delete', name: 'demo', scope: 'project', projectPath: project, originalPath: target }),
    );
    assert.equal(r.ok, true, r.message);
    assert.ok(r.quarantine?.kept);
    assert.ok(!existsSync(folder));
    assert.ok((await restoreQuarantine(ctx.store, ctx.config.dataDir, r.quarantine!.kept ? r.quarantine!.id : 0)).ok);
    assert.ok(existsSync(join(folder, 'SKILL.md')));
  });
});

describe('F14 API', () => {
  it('삭제 응답에 보관 결과, 목록, 되돌리기, 크기, 플러그인 재설치 명령', async () => {
    const ctx = ctxOf();
    const { project, folder } = projectWithSkill();
    const srv = await serve(ctx, [installRouter(ctx), quarantineRouter(ctx)]);
    try {
      const size = await api(srv.port, 'GET', `/api/quarantine/size?scope=project&projectPath=${encodeURIComponent(project)}&folder=demo`);
      assert.equal(size.status, 200);
      assert.equal(size.json.exists, true);
      assert.equal(size.json.over, false);
      assert.ok(size.json.bytes > 0);
      const byPath = await api(srv.port, 'GET', `/api/quarantine/size?scope=project&projectPath=${encodeURIComponent(project)}&path=${encodeURIComponent(folder)}`);
      assert.equal(byPath.json.bytes, size.json.bytes);
      for (const q of ['folder=..', `path=${encodeURIComponent(join(project, '..'))}`, 'folder=demo&agent=nobody', 'folder=demo']) {
        const scope = q === 'folder=demo' ? 'scope=project' : `scope=project&projectPath=${encodeURIComponent(project)}`;
        assert.equal((await api(srv.port, 'GET', `/api/quarantine/size?${scope}&${q}`)).status, 400, q);
      }

      const del = await api(srv.port, 'POST', '/api/uninstall', { kind: 'skill', id: 'demo', scope: 'project', projectPath: project });
      assert.equal(del.status, 200, JSON.stringify(del.json));
      assert.equal(del.json.quarantine.kept, true);
      assert.ok(!existsSync(folder));

      ctx.store.logInstall({ skill_id: null, plugin_id: 'tool@market', method: 'uninstall-plugin', scope: 'user', project_path: null, argv: [], exit_code: 0, output: '' });
      ctx.store.logInstall({ skill_id: null, plugin_id: 'x;rm@market', method: 'uninstall-plugin', scope: 'user', project_path: null, argv: [], exit_code: 0, output: '' });
      const list = await api(srv.port, 'GET', '/api/quarantine');
      assert.equal(list.json.entries.length, 1);
      assert.equal(list.json.entries[0].available, true);
      assert.equal(list.json.entries[0].originalPath, folder);
      assert.ok(!('storedPath' in list.json.entries[0]));
      assert.deepEqual(list.json.plugins.map((p: { command: string }) => p.command), ['claude plugin install tool@market --scope user']);
      assert.deepEqual(list.json.limits, { maxBytes: 20 * 1024 * 1024, keepDays: 30, maxEntries: 20 });

      const id = list.json.entries[0].id;
      assert.equal((await rawRequest({ port: srv.port, method: 'POST', path: `/api/quarantine/${id}/restore`, headers: { 'X-Skill-Finder': '1' } })).status, 403, 'Origin 없음');
      assert.equal((await api(srv.port, 'POST', '/api/quarantine/abc/restore')).status, 400);
      assert.equal((await api(srv.port, 'POST', '/api/quarantine/999/restore')).status, 404);
      const back = await api(srv.port, 'POST', `/api/quarantine/${id}/restore`);
      assert.equal(back.status, 200, JSON.stringify(back.json));
      assert.ok(existsSync(join(folder, 'SKILL.md')));
      assert.equal((await api(srv.port, 'POST', `/api/quarantine/${id}/restore`)).status, 409);
      assert.equal((await api(srv.port, 'GET', '/api/quarantine')).json.entries[0].available, false);
    } finally {
      await srv.close();
    }
  });
});

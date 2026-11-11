// Feature review F12 (프로젝트 표준, `skill-finder check`) and F13 (모든 프로젝트): read-only views over a project's
// skills-lock.json and .claude/settings.json and over every known project. Every file is a fixture in a temporary
// folder; the one skills CLI run installs a local fixture skill into a temporary project with a temporary home.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createContext } from '../src/bootstrap.ts';
import type { AppConfig } from '../src/config.ts';
import { lockSkillId, readLockEntries } from '../src/install/installed.ts';
import { forgetProjects, knownProjects, listProjects, usageWindowStart } from '../src/projects/list.ts';
import { projectStandard, skillFolderHash } from '../src/projects/standard.ts';
import { projectsRouter } from '../src/routes/projects.ts';
import { presetsRouter, standardSnippet } from '../src/routes/presets.ts';
import { getSettings, saveSettings } from '../src/settings.ts';

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const md = (name: string, desc = `${name} skill for tests`) => `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody of ${name}.\n`;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const roots: string[] = [];
const tempRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'sf-proj-'));
  roots.push(r);
  return r;
};
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const newCtx = (dataDir: string) => {
  const config: AppConfig = { port: 0, dev: false, dataDir, githubToken: null };
  return createContext(config, ':memory:');
};

const SKILLS_CLI = join(import.meta.dirname, '..', '..', 'node_modules', 'skills', 'bin', 'cli.mjs');

describe('skills-lock.json 읽기', () => {
  it('ref·computedHash를 남기고, GitHub 출처만 색인 id로', () => {
    const root = tempRoot();
    const file = join(root, 'skills-lock.json');
    write(
      file,
      `\uFEFF${json({
        version: 1,
        skills: {
          pdf: { source: 'Anthropics/Skills', ref: 'v1', sourceType: 'github', skillPath: 'skills/pdf/SKILL.md', computedHash: 'abc' },
          top: { source: 'o/r', sourceType: 'github', skillPath: 'SKILL.md', computedHash: 'def' },
          gl: { source: 'https://gitlab.com/x/y.git', sourceType: 'gitlab', sourceUrl: 'https://gitlab.com/x/y.git', computedHash: '1' },
          bad: null,
        },
      })}`,
    );
    const entries = readLockEntries(file)!;
    assert.equal(entries.length, 4);
    const pdf = entries.find((e) => e.name === 'pdf')!;
    assert.equal(pdf.ref, 'v1');
    assert.equal(pdf.computedHash, 'abc');
    assert.equal(lockSkillId(pdf), 'gh:anthropics/skills:skills/pdf');
    assert.equal(lockSkillId(entries.find((e) => e.name === 'top')!), 'gh:o/r:');
    assert.equal(lockSkillId(entries.find((e) => e.name === 'gl')!), null);
    assert.equal(entries.find((e) => e.name === 'bad')!.source, null);
    assert.equal(readLockEntries(join(root, 'none.json')), null);
    write(join(root, 'broken.json'), '{ not json');
    assert.equal(readLockEntries(join(root, 'broken.json')), null);
  });
});

describe('프로젝트 표준 (F12)', () => {
  it('skills CLI가 쓴 computedHash와 같은 방식으로 계산한다 (맞음 → 내용 다름 → 설치 안 됨)', { skip: !existsSync(SKILLS_CLI) && 'skills CLI 없음' }, async () => {
    const root = tempRoot();
    const home = join(root, 'home');
    const project = join(root, 'proj');
    const src = join(root, 'src', 'my-skill');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    // CRLF, nested folders and names whose order differs by case: the hash must not care how they were made
    write(join(src, 'SKILL.md'), '---\r\nname: my-skill\r\ndescription: A local skill for the hash test\r\n---\r\n\r\nBody\r\n');
    write(join(src, 'scripts', 'run.sh'), 'echo hi\n');
    write(join(src, 'Zeta.md'), 'Z\n');
    write(join(src, 'alpha.md'), 'a\n');
    write(join(src, 'a', 'b', 'c.txt'), 'deep\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', CI: '' };
    await new Promise<void>((done, fail) =>
      execFile(process.execPath, [SKILLS_CLI, 'add', src, '-a', 'claude-code', '--copy', '-y'], { cwd: project, env, timeout: 90_000 }, (err, _out, errOut) =>
        err ? fail(new Error(`${err.message}\n${errOut}`)) : done(),
      ),
    );
    const lock = readLockEntries(join(project, 'skills-lock.json'))!;
    assert.ok(lock[0]?.computedHash, 'the CLI wrote a computedHash');
    const installed = join(project, '.claude', 'skills', 'my-skill');
    assert.equal(await skillFolderHash(installed), lock[0].computedHash);

    let s = await projectStandard(project, { home });
    assert.equal(s.hasStandard, true);
    const item = s.items.find((i) => i.kind === 'skill' && i.name === 'my-skill')!;
    assert.equal(item.status, 'ok');
    assert.equal(item.localHash, item.lockHash);
    assert.equal(s.ok, true);

    write(join(installed, 'alpha.md'), 'edited\n');
    s = await projectStandard(project, { home });
    assert.equal(s.items.find((i) => i.name === 'my-skill')!.status, 'differs');
    assert.equal(s.ok, false);

    rmSync(installed, { recursive: true, force: true });
    s = await projectStandard(project, { home });
    const gone = s.items.find((i) => i.name === 'my-skill')!;
    assert.equal(gone.status, 'missing');
    // a local source is not in the index: nothing for the preset dialog
    assert.equal(gone.preset, null);
    assert.deepEqual(s.missingPreset, []);
  });

  it('스킬: 설치 안 됨(프리셋 항목), 표준에 없음, 다른 에이전트 폴더만, 해시 없음', async () => {
    const root = tempRoot();
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home, { recursive: true });
    write(
      join(project, 'skills-lock.json'),
      json({
        version: 1,
        skills: {
          'PDF Tools': { source: 'Owner/Repo', ref: 'main', sourceType: 'github', skillPath: 'skills/pdf/SKILL.md', computedHash: 'x'.repeat(64) },
          codexonly: { source: 'o/r', sourceType: 'github', skillPath: 'codexonly/SKILL.md' },
        },
      }),
    );
    write(join(project, '.agents', 'skills', 'codexonly', 'SKILL.md'), md('codexonly'));
    write(join(project, '.claude', 'skills', 'handmade', 'SKILL.md'), md('handmade'));
    write(join(project, '.claude', 'skills', 'not-a-skill', 'README.md'), 'no SKILL.md here');
    const s = await projectStandard(project, { home });
    const by = new Map(s.items.map((i) => [i.name, i]));
    assert.equal(by.get('PDF Tools')!.status, 'missing');
    assert.deepEqual(by.get('PDF Tools')!.preset, { id: 'gh:owner/repo:skills/pdf', name: 'PDF Tools' });
    assert.equal(by.get('PDF Tools')!.ref, 'main');
    assert.equal(by.get('codexonly')!.status, 'ok');
    assert.equal(by.get('codexonly')!.hashNote, 'noLockHash');
    assert.equal(by.get('codexonly')!.notForClaude, true);
    assert.equal(by.get('handmade')!.status, 'extra');
    assert.equal(by.has('not-a-skill'), false);
    assert.deepEqual(s.missingPreset, [{ id: 'gh:owner/repo:skills/pdf', name: 'PDF Tools' }]);
    assert.equal(s.refNote, true);
    assert.equal(s.counts.missing, 1);
    assert.equal(s.counts.extra, 1);
    // only `missing` fails here: `extra` is reported, not a failure
    assert.equal(s.ok, false);
    rmSync(join(project, 'skills-lock.json'));
    write(join(project, 'skills-lock.json'), json({ version: 1, skills: { codexonly: { source: 'o/r', sourceType: 'github', skillPath: 'codexonly/SKILL.md' } } }));
    const ok = await projectStandard(project, { home });
    assert.equal(ok.ok, true, 'extra alone does not fail');
    assert.equal(ok.counts.extra, 1);
  });

  it('플러그인·마켓: 맞음, 설치 안 됨, 꺼짐, 마켓 미등록, 표준에 없음', async () => {
    const root = tempRoot();
    const home = join(root, 'home');
    const project = join(root, 'proj');
    const other = join(root, 'other');
    mkdirSync(other, { recursive: true });
    write(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      json({
        version: 2,
        plugins: {
          'a@m1': [{ scope: 'user', installPath: join(home, 'p', 'a') }],
          'd@m1': [{ scope: 'project', projectPath: project, installPath: join(home, 'p', 'd') }],
          'e@m1': [{ scope: 'project', projectPath: project, installPath: join(home, 'p', 'e') }],
          'f@m1': [{ scope: 'project', projectPath: other, installPath: join(home, 'p', 'f') }],
        },
      }),
    );
    write(join(home, '.claude', 'plugins', 'known_marketplaces.json'), json({ m1: { source: { source: 'github', repo: 'o/m1' } } }));
    write(
      join(project, '.claude', 'settings.json'),
      json({
        enabledPlugins: { 'a@m1': true, 'b@m1': true, 'c@m2': true, 'd@m1': true, 'off@m1': false, 'g@claude-plugins-official': true },
        extraKnownMarketplaces: { m1: { source: { source: 'github', repo: 'o/m1' } }, m3: { source: { source: 'git', url: 'https://example.com/m3.git' } } },
      }),
    );
    write(join(project, '.claude', 'settings.local.json'), json({ enabledPlugins: { 'd@m1': false } }));
    const s = await projectStandard(project, { home });
    const st = (kind: string, name: string) => s.items.find((i) => i.kind === kind && i.name === name)?.status;
    assert.equal(st('plugin', 'a@m1'), 'ok');
    assert.equal(st('plugin', 'b@m1'), 'missing');
    assert.equal(st('plugin', 'c@m2'), 'unregistered');
    assert.equal(st('plugin', 'd@m1'), 'disabled');
    assert.equal(st('plugin', 'g@claude-plugins-official'), 'missing', 'the official marketplace needs no adding');
    assert.equal(st('plugin', 'e@m1'), 'extra');
    assert.equal(st('plugin', 'f@m1'), undefined, "another project's plugin is not this one's");
    assert.equal(st('plugin', 'off@m1'), undefined, 'off in the standard: nothing to check');
    assert.equal(st('marketplace', 'm1'), 'ok');
    assert.equal(st('marketplace', 'm3'), 'unregistered');
    assert.equal(s.items.find((i) => i.name === 'm3')!.marketplace, 'https://example.com/m3.git');
    assert.deepEqual(
      s.missingPreset.map((p) => p.plugin).sort(),
      ['b@m1', 'c@m2', 'g@claude-plugins-official'],
    );
    assert.equal(s.files.lock, 'missing');
    assert.equal(s.files.settings, 'read');
    assert.equal(s.ok, false);
  });

  it('표준이 없는 폴더, 읽지 못하는 파일', async () => {
    const root = tempRoot();
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    const none = await projectStandard(project, { home });
    assert.equal(none.hasStandard, false);
    assert.equal(none.ok, true);
    assert.deepEqual(none.items, []);
    write(join(project, 'skills-lock.json'), 'not json');
    write(join(project, '.claude', 'settings.json'), '[1,2]');
    const bad = await projectStandard(project, { home });
    assert.equal(bad.files.lock, 'unreadable');
    assert.equal(bad.files.settings, 'unreadable');
    assert.equal(bad.ok, false);
  });

  it('512KB 악성 입력도 길이에 비례해 끝난다', async () => {
    const root = tempRoot();
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home, { recursive: true });
    const N = 512 * 1024;
    const skills: Record<string, unknown> = {
      long: { source: `${'a/'.repeat(N / 2)}`, sourceType: 'github', skillPath: `${'x/'.repeat(N / 2)}SKILL.md`, computedHash: 'h' },
      spaces: { source: `a${' '.repeat(N)}/b`, sourceType: 'github', skillPath: 'SKILL.md' },
    };
    for (let i = 0; i < 2000; i++) skills[`s${i}-${'-'.repeat(100)}`] = { source: 'o/r', sourceType: 'github', skillPath: `s${i}/SKILL.md` };
    write(join(project, 'skills-lock.json'), JSON.stringify({ version: 1, skills }));
    write(join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [`${'@'.repeat(N)}x`]: true, [`p@${'m'.repeat(250)}`]: true }, extraKnownMarketplaces: { [`${'k'.repeat(N)}`]: { source: { repo: 'r'.repeat(N) } } } }));
    const t0 = performance.now();
    const s = await projectStandard(project, { home });
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, `${ms.toFixed(0)}ms`);
    assert.ok(s.items.length >= 2000);
    assert.equal(lockSkillId({ source: `a${' '.repeat(N)}/b`, sourceType: 'github', skillPath: 'SKILL.md' }), null);
  });
});

describe('라우트 (임시 홈 폴더, 읽기 전용)', () => {
  let root: string;
  let home: string;
  let project: string;
  let ctx: ReturnType<typeof createContext>;
  let base: string;
  let server: ReturnType<express.Express['listen']>;
  before(async () => {
    root = tempRoot();
    home = join(root, 'home');
    project = join(root, 'Proj');
    write(join(project, 'skills-lock.json'), json({ version: 1, skills: { gone: { source: 'o/r', sourceType: 'github', skillPath: 'gone/SKILL.md', computedHash: 'h' } } }));
    write(join(project, '.claude', 'skills', 'mine', 'SKILL.md'), md('mine'));
    write(join(home, '.claude', 'skills', 'personal', 'SKILL.md'), md('personal'));
    ctx = newCtx(root);
    const app = express();
    app.use(express.json());
    app.use('/api', projectsRouter(ctx, { home }));
    app.use('/api', presetsRouter(ctx, { home }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ctx.store.db.close();
  });

  it('/projects/standard: 없는 폴더·상대 경로는 400, 폴더면 대조 결과', async () => {
    assert.equal((await fetch(`${base}/projects/standard`)).status, 400);
    assert.equal((await fetch(`${base}/projects/standard?projectPath=relative/dir`)).status, 400);
    assert.equal((await fetch(`${base}/projects/standard?projectPath=${encodeURIComponent(join(root, 'nope'))}`)).status, 400);
    const res = await fetch(`${base}/projects/standard?projectPath=${encodeURIComponent(project)}`);
    assert.equal(res.status, 200);
    const s = (await res.json()) as { ok: boolean; counts: Record<string, number> };
    assert.equal(s.ok, false);
    assert.equal(s.counts.missing, 1);
    assert.equal(s.counts.extra, 1);
  });

  it('/presets/snippet: 색인에 없는 스킬은 빼고, 켜진 플러그인과 그 마켓', async () => {
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), json({ plugins: { 'a@m1': [{ scope: 'user', installPath: join(home, 'p', 'a') }], 'b@local': [{ scope: 'user', installPath: join(home, 'p', 'b') }], 'c@claude-plugins-official': [{ scope: 'user', installPath: join(home, 'p', 'c') }] } }));
    write(join(home, '.claude', 'settings.json'), json({ enabledPlugins: { 'a@m1': true, 'b@local': true, 'c@claude-plugins-official': true } }));
    write(join(home, '.claude', 'plugins', 'known_marketplaces.json'), json({ m1: { source: { source: 'github', repo: 'o/m1' } }, local: { source: { source: 'directory', path: 'C:\\secret\\path' } } }));
    assert.equal((await fetch(`${base}/presets/snippet?projectPath=relative`)).status, 400);
    const res = await fetch(`${base}/presets/snippet?projectPath=${encodeURIComponent(project)}`);
    assert.equal(res.status, 200);
    const s = (await res.json()) as { lock: string; settings: string; skippedSkills: number; localMarkets: string[]; plugins: number };
    assert.deepEqual(JSON.parse(s.lock), { version: 1, skills: {} });
    assert.equal(s.skippedSkills, 2, 'mine and personal are not indexed');
    const settings = JSON.parse(s.settings);
    assert.deepEqual(settings.enabledPlugins, { 'a@m1': true, 'b@local': true, 'c@claude-plugins-official': true });
    assert.deepEqual(settings.extraKnownMarketplaces, { m1: { source: { source: 'github', repo: 'o/m1' } } });
    assert.deepEqual(s.localMarkets, ['local']);
    assert.ok(!s.settings.includes('secret'), 'a local marketplace path stays out');
  });

  it('조각의 lock 항목: 색인된 GitHub 스킬, skills CLI 형식과 설치본 해시', async () => {
    const id = 'gh:owner/repo:skills/tool';
    const skillDir = join(home, '.claude', 'skills', 'tool');
    write(join(skillDir, 'SKILL.md'), md('tool'));
    const { createHash } = await import('node:crypto');
    const raw = md('tool');
    ctx.store.db
      .prepare(
        `INSERT INTO skills (id, origin, repo, dir_path, name, description, skill_md_sha256, risk_level)
         VALUES (?, 'generic', 'Owner/Repo', 'skills/tool', 'tool', 'tool skill for tests', ?, 'low')`,
      )
      .run(id, createHash('sha256').update(raw).digest('hex'));
    const s = await standardSnippet(ctx.store, null, home);
    const lock = JSON.parse(s.lock) as { skills: Record<string, Record<string, string>> };
    assert.deepEqual(Object.keys(lock.skills.tool), ['source', 'sourceType', 'skillPath', 'computedHash']);
    assert.equal(lock.skills.tool.source, 'Owner/Repo');
    assert.equal(lock.skills.tool.skillPath, 'skills/tool/SKILL.md');
    assert.equal(lock.skills.tool.computedHash, await skillFolderHash(skillDir));
  });

  it('/projects: 설치 기록과 ~/.claude.json의 있는 폴더만, 한 번씩, 1분 캐시', async () => {
    forgetProjects();
    const claudeProj = join(root, 'claude-proj');
    mkdirSync(claudeProj, { recursive: true });
    ctx.store.logInstall({ skill_id: null, plugin_id: null, method: 'skills-cli', scope: 'project', project_path: project, argv: [], exit_code: 0, output: '' });
    ctx.store.logInstall({ skill_id: null, plugin_id: null, method: 'skills-cli', scope: 'project', project_path: join(root, 'deleted'), argv: [], exit_code: 0, output: '' });
    write(
      join(home, '.claude.json'),
      json({
        projects: {
          [project.replace(/\\/g, '/').toLowerCase()]: {},
          [claudeProj.replace(/\\/g, '/')]: { mcpServers: { local: { command: 'node', args: ['x.js'] } } },
          [home]: {},
          'relative/path': {},
        },
      }),
    );
    const known = knownProjects(ctx.store, home);
    assert.equal(known.length, 2);
    assert.deepEqual(known[0].from, ['install', 'claude']);
    assert.deepEqual(known[1].from, ['claude']);

    const res = await fetch(`${base}/projects`);
    assert.equal(res.status, 200);
    const list = (await res.json()) as { projects: Array<{ path: string; skills: { project: number; loaded: number }; mcp: { project: number }; standard: { counts: Record<string, number> } | null; usage: unknown }>; usageOn: boolean };
    assert.equal(list.usageOn, false);
    const p = list.projects.find((x) => x.path.toLowerCase() === project.toLowerCase())!;
    assert.equal(p.skills.project, 1);
    assert.ok(p.skills.loaded >= 2, 'personal skills load there too');
    assert.equal(p.standard!.counts.missing, 1);
    assert.equal(p.usage, null);
    const c = list.projects.find((x) => x.path.toLowerCase() === claudeProj.toLowerCase())!;
    assert.equal(c.mcp.project, 1);

    // kept for a minute: a new folder shows only when asked fresh
    const third = join(root, 'third');
    mkdirSync(third);
    ctx.store.logInstall({ skill_id: null, plugin_id: null, method: 'skills-cli', scope: 'project', project_path: third, argv: [], exit_code: 0, output: '' });
    assert.equal(((await (await fetch(`${base}/projects`)).json()) as { projects: unknown[] }).projects.length, 2);
    assert.equal(((await (await fetch(`${base}/projects?fresh=1`)).json()) as { projects: unknown[] }).projects.length, 3);
  });

  it('/projects: 사용량(F11) — 30일 미사용과 마지막 사용, 하위 폴더 사용도 그 프로젝트', async () => {
    const now = Date.now();
    const today = usageWindowStart(now, 1);
    const old = usageWindowStart(now, 60);
    const add = ctx.store.db.prepare('INSERT INTO skill_usage (day, project_path, skill, plugin, count) VALUES (?, ?, ?, ?, ?)');
    add.run(old, project, 'mine', '', 3);
    add.run(today, join(project, 'sub'), 'other', '', 1);
    // counts kept from when usage reading was on are not shown while it is off (as GET /api/usage; review 2026-11-10)
    const off = await listProjects(ctx.store, { home, now }, true);
    assert.equal(off.usageOn, false);
    assert.equal(off.projects.find((x) => x.path.toLowerCase() === project.toLowerCase())!.usage, null);
    saveSettings(ctx.store, { ...getSettings(ctx.store), usageScan: true });
    const list = await listProjects(ctx.store, { home, now }, true);
    const p = list.projects.find((x) => x.path.toLowerCase() === project.toLowerCase())!;
    assert.equal(list.usageOn, true);
    assert.deepEqual(p.usage, { unused30d: 1, lastUsed: today });
  });
});

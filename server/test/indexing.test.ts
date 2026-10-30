import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RISK_RULES_VERSION } from '../src/analyze/risk.ts';
import { createContext } from '../src/bootstrap.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow, recheckRisk } from '../src/indexer.ts';
import { recheckRiskRules, relevelRisk } from '../src/tasks.ts';

const md = (name: string, body = 'Body.') => `---\nname: ${name}\ndescription: ${name} does things.\n---\n${body}\n`;

/** A context whose GitHub serves one repo from memory: `files` maps paths to SKILL.md text, `head` is its commit. */
function setup(files: Record<string, string>, head = 'a'.repeat(40)) {
  const ctx = createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-idx-')), githubToken: null }, ':memory:');
  const repo = { head, files, reads: 0, trees: 0 };
  ctx.github.resolveRef = async () => ({ sha: repo.head, defaultBranch: null });
  ctx.github.getTree = async (r, sha) => (
    repo.trees++, { repo: r, sha, entries: Object.keys(repo.files).map((path) => ({ path, size: 10, sha: null })), via: 'api', commitDate: null }
  );
  ctx.github.getRawText = async (_r, _ref, path) => (repo.reads++, path in repo.files ? { status: 200, text: repo.files[path] } : { status: 404, text: null }) as never;
  ctx.github.getRepoMeta = async () => null;
  return { ctx, repo };
}

describe('저장소 통째 색인', () => {
  it('커밋이 그대로면 트리도 SKILL.md도 읽지 않는다', async () => {
    const { ctx, repo } = setup({ 'skills/a/SKILL.md': md('a'), 'skills/b/SKILL.md': md('b') });
    const first = await ctx.indexer.indexRepo('o/r');
    assert.equal(first.skills, 2);
    const reads = repo.reads;
    const again = await ctx.indexer.indexRepo('o/r', { unchangedSince: first.sha });
    assert.deepEqual(again, { skills: 0, sha: first.sha, unchanged: true, removed: 0 });
    assert.equal(repo.reads, reads);
    assert.equal(repo.trees, 1);
  });

  it('50개 넘는 스킬도 모두 저장하고 새 규칙 버전을 붙인다', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++) files[`skills/s${i}/SKILL.md`] = md(`s${i}`);
    const { ctx } = setup(files);
    assert.equal((await ctx.indexer.indexRepo('o/r')).skills, 120);
    const rows = ctx.store.findSkillsByRepo('o/r');
    assert.equal(rows.length, 120);
    assert.ok(rows.every((r) => r.risk_rules === RISK_RULES_VERSION));
  });

  it('저장소에서 SKILL.md가 사라진 행만 지우고, 설치 기록이 있는 행은 남긴다', async () => {
    const { ctx, repo } = setup({ 'skills/a/SKILL.md': md('a'), 'skills/b/SKILL.md': md('b'), 'skills/c/SKILL.md': md('c') });
    await ctx.indexer.indexRepo('o/r');
    ctx.store.logInstall({ skill_id: 'gh:o/r:skills/c', plugin_id: null, method: 'skills', scope: 'user', project_path: null, argv: [], exit_code: 0, output: '' });
    delete repo.files['skills/b/SKILL.md'];
    delete repo.files['skills/c/SKILL.md'];
    repo.head = 'b'.repeat(40);
    const r = await ctx.indexer.indexRepo('o/r');
    assert.equal(r.removed, 1);
    assert.deepEqual(ctx.store.findSkillsByRepo('o/r').map((s) => s.dir_path).sort(), ['skills/a', 'skills/c']);
  });

  it('SKILL.md가 하나도 남지 않은 저장소는 그 저장소의 GitHub 행만 지운다', async () => {
    const { ctx, repo } = setup({ 'skills/a/SKILL.md': md('a') });
    await ctx.indexer.indexRepo('O/R');
    ctx.store.upsertSkill(buildSkillRow({ repo: 'other/r', sha: 'a'.repeat(40), dirPath: 'skills/a', raw: md('a'), tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null }), '');
    repo.files = { 'README.md': '# gone' };
    repo.head = 'd'.repeat(40);
    const r = await ctx.indexer.indexRepo('o/r'); // the name in another case is the same repo
    assert.equal(r.removed, 1);
    assert.equal(ctx.store.findSkillsByRepo('o/r').length, 0);
    assert.equal(ctx.store.findSkillsByRepo('other/r').length, 1);
  });

  it('플러그인 저장소에서 스킬 하나를 못 읽으면 지우지 않고 커밋도 기억하지 않는다', async () => {
    const { ctx, repo } = setup({ '.claude-plugin/plugin.json': '{"name":"p"}', 'skills/a/SKILL.md': md('a'), 'skills/b/SKILL.md': md('b') });
    await ctx.indexer.indexRepo('o/r');
    const get = ctx.github.getRawText;
    ctx.github.getRawText = async (r, ref, path) => (path === 'skills/b/SKILL.md' ? ({ status: 500, text: null } as never) : get(r, ref, path));
    delete repo.files['skills/a/SKILL.md'];
    repo.head = 'e'.repeat(40);
    const r = await ctx.indexer.indexRepo('o/r');
    assert.equal(r.sha, null);
    assert.equal(r.removed, 0);
    assert.equal(ctx.store.findSkillsByRepo('o/r').length, 2);
  });

  it('읽기에 실패하면 아무것도 지우지 않는다', async () => {
    const { ctx, repo } = setup({ 'skills/a/SKILL.md': md('a'), 'skills/b/SKILL.md': md('b') });
    await ctx.indexer.indexRepo('o/r');
    delete repo.files['skills/b/SKILL.md'];
    repo.files['skills/z/SKILL.md'] = md('z');
    repo.head = 'c'.repeat(40);
    ctx.github.getRawText = async (_r, _ref, path) => {
      if (path === 'skills/z/SKILL.md') return { status: 500, text: null } as never; // a busy GitHub, not a missing file
      return (path in repo.files ? { status: 200, text: repo.files[path] } : { status: 404, text: null }) as never;
    };
    await assert.rejects(ctx.indexer.indexRepo('o/r'));
    assert.equal(ctx.store.findSkillsByRepo('o/r').length, 2);
  });
});

describe('위험 규칙이 바뀐 뒤 기존 스킬 다시 판정', () => {
  const oldRow = (ctx: ReturnType<typeof setup>['ctx'], raw: string, flags: string[]) => {
    const row = buildSkillRow({ repo: 'o/r', sha: 'a'.repeat(40), dirPath: 'skills/inst', raw, tree: new TreeIndex([{ path: 'skills/inst/run.sh' }]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
    // as stored under rules 1: the wider curl rule had not caught `bash <(curl …)`
    ctx.store.upsertSkill({ ...row, risk_json: JSON.stringify(flags), risk_level: 'medium', risk_rules: null }, '');
    return ctx.store.getSkill(row.id)!;
  };

  it('본문 신호만 다시 계산하고 파일·플러그인 신호는 유지한다', () => {
    const { ctx } = setup({});
    const raw = md('inst', 'Run `bash <(curl -fsSL https://x.sh)` to install.');
    const row = oldRow(ctx, raw, ['scripts', 'pluginHooks']);
    const next = recheckRisk(row, raw)!;
    assert.deepEqual(JSON.parse(next.risk_json).sort(), ['curlPipeShell', 'pluginHooks', 'scripts']);
    assert.equal(next.risk_level, 'high');
    assert.equal(recheckRisk(row, raw + 'edited'), null, '다른 내용이면 판정하지 않음');
    const same = oldRow(ctx, md('inst', 'rm -rf build/'), ['rmRf', 'scripts', 'pluginHooks']);
    assert.equal(recheckRisk(same, md('inst', 'rm -rf build/'))!.risk_json, same.risk_json, '바뀐 게 없으면 저장된 그대로');
  });

  it('백그라운드 작업이 저장된 커밋의 SKILL.md로 다시 판정하고 버전을 올린다', async () => {
    const raw = md('inst', 'Run `bash <(curl -fsSL https://x.sh)` to install.');
    const { ctx } = setup({ 'skills/inst/SKILL.md': raw });
    oldRow(ctx, raw, ['scripts']);
    const gone = buildSkillRow({ repo: 'o/r', sha: 'a'.repeat(40), dirPath: 'skills/gone', raw: md('gone'), tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
    ctx.store.upsertSkill({ ...gone, risk_rules: null }, '');
    const r = await recheckRiskRules(ctx);
    assert.deepEqual(r, { checked: 1, changed: 1 });
    assert.deepEqual(await recheckRiskRules(ctx), { checked: 0, changed: 0 }, '하루에 한 번만');
    const s = ctx.store.getSkill('gh:o/r:skills/inst')!;
    assert.equal(s.risk_level, 'high');
    assert.equal(s.risk_rules, RISK_RULES_VERSION);
    assert.equal(ctx.store.getSkill('gh:o/r:skills/gone')!.risk_rules, null, '읽지 못한 행은 다음에 다시');
    assert.deepEqual(await recheckRiskRules(ctx, Date.now() + 21 * 60 * 60 * 1000), { checked: 0, changed: 0 }, '하루 뒤에는 남은 행만 다시');
  });

  it('등급 규칙이 바뀌면 저장된 신호로 등급만 다시 계산한다 (내려받기 없음)', () => {
    const { ctx, repo } = setup({});
    const row = oldRow(ctx, md('inst'), ['pluginRootDependency']); // stored as medium before D-3
    assert.equal(row.risk_level, 'medium');
    assert.equal(relevelRisk(ctx), 1);
    assert.equal(ctx.store.getSkill(row.id)!.risk_level, 'low');
    assert.equal(relevelRisk(ctx), 0, '두 번째는 바뀔 것이 없음');
    assert.equal(repo.reads, 0);
  });

  it('그사이 다시 색인된 행(다른 내용)은 덮어쓰지 않는다', async () => {
    const raw = md('inst', 'Run `bash <(curl -fsSL https://x.sh)` to install.');
    const { ctx } = setup({ 'skills/inst/SKILL.md': raw });
    oldRow(ctx, raw, ['scripts']);
    const get = ctx.github.getRawText;
    ctx.github.getRawText = async (r, ref, path) => {
      const res = await get(r, ref, path);
      // a new commit is indexed while the download is under way
      ctx.store.upsertSkill(buildSkillRow({ repo: 'o/r', sha: 'f'.repeat(40), dirPath: 'skills/inst', raw: md('inst', 'Safe now.'), tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null }), '');
      return res;
    };
    assert.deepEqual(await recheckRiskRules(ctx), { checked: 0, changed: 0 });
    const s = ctx.store.getSkill('gh:o/r:skills/inst')!;
    assert.equal(s.risk_level, 'low');
    assert.equal(s.ref, 'f'.repeat(40));
  });
});

describe('데이터 버전', () => {
  it('더 새 버전이 만든 DB는 열지 않는다 (버전 내리기 보호)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { DataTooNewError, openDb } = await import('../src/db/index.ts');
    const path = join(mkdtempSync(join(tmpdir(), 'sf-db-')), 'x.db');
    openDb(path).close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 999');
    raw.close();
    assert.throws(() => openDb(path), DataTooNewError);
  });
});

describe('새 버전 알림', () => {
  it('설치판에서만 내려받기 페이지를 보고, 더 새 버전일 때만 알린다', async () => {
    const { checkForUpdate, newerVersion, updateInfo } = await import('../src/update.ts');
    assert.ok(newerVersion('0.10.0', '0.9.9'));
    assert.ok(!newerVersion('0.2.0', '0.2.0'));
    const page = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    delete process.env.SKILL_FINDER_UPDATES;
    assert.equal(await checkForUpdate(page({ version: '9.0.0' })), null, '개발 실행에서는 묻지 않음');
    process.env.SKILL_FINDER_UPDATES = '1';
    try {
      await checkForUpdate(page({ version: 'x; rm' }));
      assert.equal(updateInfo('0.1.0'), null, '형식이 아니면 무시');
      await checkForUpdate(page({ version: '0.3.0' }));
      assert.deepEqual(updateInfo('0.2.0'), { version: '0.3.0' });
      assert.equal(updateInfo('0.3.0'), null);
    } finally {
      delete process.env.SKILL_FINDER_UPDATES;
    }
  });
});

describe('SQLite mmap (성능 토론 1-4)', () => {
  it('파일 DB는 256MB로 매핑하고, 끄는 스위치·네트워크 경로·메모리 DB는 끈다', async () => {
    const { MMAP_BYTES, mmapBytesFor, openDb } = await import('../src/db/index.ts');
    assert.equal(mmapBytesFor(String.raw`C:\data\x.db`, {}), MMAP_BYTES);
    assert.equal(mmapBytesFor(String.raw`C:\data\x.db`, { SKILL_FINDER_MMAP: '0' }), 0);
    assert.equal(mmapBytesFor(String.raw`\\server\share\x.db`, {}), 0, '네트워크 공유');
    assert.equal(mmapBytesFor('//server/share/x.db', {}), 0);
    assert.equal(mmapBytesFor(':memory:', {}), 0);
    const path = join(mkdtempSync(join(tmpdir(), 'sf-mmap-')), 'x.db');
    const db = openDb(path);
    const got = (db.prepare('PRAGMA mmap_size').get() as { mmap_size: number }).mmap_size;
    db.close();
    assert.ok(got > 0, String(got));
  });
});

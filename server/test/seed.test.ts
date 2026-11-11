import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createContext } from '../src/bootstrap.ts';
import { exportSeed, importSeed, writeSeedFile } from '../src/db/seed.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';

const md = (name: string) => `---\nname: ${name}\ndescription: ${name} extracts tables from pdf files.\n---\nBody.\n`;
const newCtx = (dbPath = ':memory:') => createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-seed-')), githubToken: null }, dbPath);
const skill = (repo: string, dir: string, pluginId: string | null) =>
  buildSkillRow({ repo, sha: 'a'.repeat(40), dirPath: dir, raw: md(dir.split('/').pop()!), tree: new TreeIndex([]), origin: pluginId ? 'plugin' : 'generic', pluginId, extraFlags: [], install: null, lastCommitAt: null });
const plugin = (id: string, marketplace: string, repo: string) =>
  ({ id, marketplace, name: id.split('@')[0], display_name: null, description: 'PDF tools', category: null, keywords: null, source_json: '"./"', source_kind: 'url', repo, path: null, ref: null, sha: 'a'.repeat(40), strict: null, entry_json: null }) as const;

/** An index like a developer's: a default marketplace, a marketplace of their own, and skills found by searching. */
function sourceIndex() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-seed-src-'));
  const ctx = newCtx(join(dir, 'index.db'));
  const s = ctx.store;
  s.updateMarketplaceSync('claude-plugins-official', { commit_sha: 'c'.repeat(40), plugin_count: 2, etag: 'e' });
  s.upsertMarketplace({ name: 'mine', repo: 'me/market', enabled: true, index_mode: 'eager' });
  s.updateMarketplaceSync('mine', { commit_sha: 'd'.repeat(40), plugin_count: 1 });
  s.upsertPlugin(plugin('pdf@claude-plugins-official', 'claude-plugins-official', 'o/pdf'));
  s.markPluginIndexed('pdf@claude-plugins-official', 'a'.repeat(40), { hooks: false }, null);
  s.upsertPlugin(plugin('broken@claude-plugins-official', 'claude-plugins-official', 'o/broken'));
  s.markPluginIndexed('broken@claude-plugins-official', null, null, 'git fetch failed: C:\\Users\\me\\data\\tmp\\git');
  s.upsertPlugin(plugin('secret@mine', 'mine', 'me/secret'));
  s.markPluginIndexed('secret@mine', 'a'.repeat(40), null, null);
  s.upsertSkill(skill('o/pdf', 'skills/pdf-tables', 'pdf@claude-plugins-official'), 'pdf');
  s.upsertSkill(skill('me/secret', 'skills/secret', 'secret@mine'), 'secret');
  s.upsertSkill(skill('searched/repo', 'skills/found', null), '');
  for (const [full_name, stars] of [['o/pdf', 420], ['me/secret', 1], ['searched/repo', 9]] as const) {
    s.upsertRepo({ full_name, stars, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: '2026-01-01T00:00:00.000Z' });
  }
  s.addFavorite('gh:searched/repo:skills/found', 'found');
  return { ctx, dir, dbPath: join(dir, 'index.db') };
}

describe('미리 만든 색인 (2026-11-03)', () => {
  it('기본 마켓플레이스의 플러그인·스킬·별 수만 내보내고, 직접 추가한 마켓플레이스·검색으로 모은 스킬·로컬 오류 문구는 뺀다', () => {
    const { ctx } = sourceIndex();
    const seed = exportSeed(ctx.store.db);
    assert.deepEqual(seed.marketplaces.map((m) => m.name), ['claude-plugins-official']);
    assert.deepEqual(seed.plugins.map((p) => p.id), ['broken@claude-plugins-official', 'pdf@claude-plugins-official']);
    assert.equal(seed.plugins[0].error, null, '경로가 든 오류 문구는 내보내지 않음');
    assert.deepEqual(seed.skills.map((s) => s.id), ['gh:o/pdf:skills/pdf-tables']);
    assert.deepEqual(seed.repos.map((r) => r.full_name), ['o/pdf']);
    assert.ok(!JSON.stringify(seed).includes('found'), '즐겨찾기·검색으로 모은 것은 없음');
  });

  it('빈 데이터에만 넣고, 넣은 뒤에는 검색되며 동기화가 다시 읽을 플러그인이 없다', () => {
    const { dbPath, dir } = sourceIndex();
    const file = join(dir, 'seed.json.gz');
    assert.deepEqual(writeSeedFile(dbPath, file).skills, 1);
    const ctx = newCtx();
    assert.deepEqual(importSeed(ctx.store, file), { plugins: 2, skills: 1, repos: 1 });
    assert.equal(ctx.store.searchSkillsFts('tables', 5)[0]?.skill.id, 'gh:o/pdf:skills/pdf-tables');
    assert.equal(ctx.store.searchPluginsFts('pdf', 5)[0]?.plugin.id, 'pdf@claude-plugins-official');
    assert.equal(ctx.store.getMarketplace('claude-plugins-official')!.commit_sha, 'c'.repeat(40));
    assert.deepEqual(ctx.store.listPluginsNeedingIndex('claude-plugins-official').map((p) => p.id), ['broken@claude-plugins-official'], '실패했던 것만 다시 읽음');
    const repo = ctx.store.getRepo('o/pdf')!;
    assert.equal(repo.stars, 420);
    assert.equal(repo.fetched_at, '2026-01-01T00:00:00.000Z', '별 수는 받은 시각 그대로(넣은 시각으로 새것처럼 꾸미지 않음)');
    assert.equal(importSeed(ctx.store, file), null, '이미 색인이 있으면 넣지 않음');
    assert.equal(importSeed(newCtx().store, join(dir, 'none.json.gz')), null, '파일이 없으면 지금 방식');
  });

  it('형식이 다르면 실패하고, 저장소가 바뀐 마켓플레이스는 넣지 않고, 옛 위험 규칙 색인은 만들지 않는다', () => {
    const { ctx: src, dbPath, dir } = sourceIndex();
    const seed = exportSeed(src.store.db);
    const write = (s: object) => (writeFileSync(join(dir, 'x.json.gz'), gzipSync(JSON.stringify(s))), join(dir, 'x.json.gz'));
    assert.throws(() => importSeed(newCtx().store, write({ ...seed, format: 99 })), /형식/);
    const moved = { ...seed, marketplaces: seed.marketplaces.map((m) => ({ ...m, repo: 'someone/else' })) };
    const ctx = newCtx();
    assert.deepEqual(importSeed(ctx.store, write(moved)), { plugins: 0, skills: 0, repos: 1 });
    assert.equal(ctx.store.countSkills(), 0);
    src.store.db.exec('UPDATE skills SET risk_rules = 0');
    assert.throws(() => writeSeedFile(dbPath, join(dir, 'old.json.gz')), /옛 위험 규칙/);
  });

  it('MinHash 서명(BLOB)은 base64로 내보내 되돌리고, blob·군집·fingerprint·출처 열도 옮긴다 (3단계 B8·B9·F5)', () => {
    const { ctx: src, dbPath, dir } = sourceIndex();
    const sig = new Uint8Array(256).map((_, i) => i);
    src.store.db.prepare("UPDATE skills SET minhash = ?, cluster_id = 'gh:o/pdf:skills/pdf-tables', skill_md_blob = ? WHERE id = 'gh:o/pdf:skills/pdf-tables'").run(sig, 'b'.repeat(40));
    src.store.db.prepare("UPDATE plugins SET tree_fingerprint = ? WHERE id = 'pdf@claude-plugins-official'").run('f'.repeat(64));
    src.store.db.prepare("UPDATE plugins SET tree_fingerprint = ? WHERE id = 'broken@claude-plugins-official'").run('e'.repeat(64));
    src.store.db.prepare("UPDATE repos SET created_at = '2024-01-01T00:00:00Z', owner_type = 'Organization' WHERE full_name = 'o/pdf'").run();
    const seed = exportSeed(src.store.db);
    assert.equal(typeof seed.skills[0].minhash, 'string', 'JSON에 바이트 객체로 들어가지 않는다');
    assert.ok(!JSON.stringify(seed).includes('"minhash":{'));
    const file = join(dir, 'sig.json.gz');
    writeSeedFile(dbPath, file);
    const ctx = newCtx();
    importSeed(ctx.store, file);
    const s = ctx.store.getSkill('gh:o/pdf:skills/pdf-tables')!;
    assert.deepEqual([...(s.minhash as Uint8Array)], [...sig]);
    assert.equal(s.cluster_id, 'gh:o/pdf:skills/pdf-tables');
    assert.equal(s.skill_md_blob, 'b'.repeat(40));
    assert.equal(ctx.store.getPlugin('pdf@claude-plugins-official')!.tree_fingerprint, 'f'.repeat(64));
    assert.equal(ctx.store.getPlugin('broken@claude-plugins-official')!.tree_fingerprint, null, '실패했던 플러그인은 다시 전부 읽는다');
    assert.equal(ctx.store.getRepo('o/pdf')!.owner_type, 'Organization');
    // a seed made before stage 3 (no such fields) still goes in
    const old = { ...seed, skills: seed.skills.map(({ minhash: _m, ...rest }) => rest) };
    writeFileSync(join(dir, 'old3.json.gz'), gzipSync(JSON.stringify(old)));
    const ctx2 = newCtx();
    assert.equal(importSeed(ctx2.store, join(dir, 'old3.json.gz'))!.skills, 1);
    assert.equal(ctx2.store.getSkill('gh:o/pdf:skills/pdf-tables')!.minhash, null);
  });

  it('다시 검사할 수 없는 소수(1% 이하)의 옛 규칙 스킬은 빼고 만든다', () => {
    const { ctx: src, dbPath, dir } = sourceIndex();
    const db = src.store.db;
    db.exec("CREATE TEMP TABLE t AS SELECT * FROM skills WHERE id = 'gh:o/pdf:skills/pdf-tables'");
    for (let i = 0; i < 150; i++) {
      db.prepare('UPDATE t SET id = ?').run(`gh:o/pdf:skills/copy-${i}`);
      db.exec('INSERT INTO skills SELECT * FROM t');
    }
    db.exec("UPDATE skills SET risk_rules = 0 WHERE id = 'gh:o/pdf:skills/copy-7'");
    db.exec("UPDATE plugins SET tree_fingerprint = 'f'");
    const file = join(dir, 'few-old.json.gz');
    assert.equal(writeSeedFile(dbPath, file).skills, 150);
    const seed = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as { skills: Array<{ id: string }>; plugins: Array<{ id: string; tree_fingerprint: string | null }> };
    assert.ok(!seed.skills.some((s) => s.id === 'gh:o/pdf:skills/copy-7'));
    // the plugin that lost a skill here must not look unchanged to the first sync (B9), or the skill never comes back;
    // the others keep their fingerprint (review 2026-11-10)
    const prints = Object.fromEntries(seed.plugins.map((p) => [p.id, p.tree_fingerprint]));
    assert.equal(prints['pdf@claude-plugins-official'], null);
    assert.equal(prints['broken@claude-plugins-official'], 'f');
  });
});

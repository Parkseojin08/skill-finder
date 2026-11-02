import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createContext } from '../src/bootstrap.ts';
import { openDb } from '../src/db/index.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';

describe('DB 인덱스', () => {
  it('대소문자를 무시하는 저장소 조회도 인덱스를 쓴다', () => {
    const db = openDb(':memory:');
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('Owner/Repo') as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    assert.match(plan('SELECT * FROM skills WHERE repo = ? COLLATE NOCASE'), /USING INDEX skills_repo_nocase/);
    assert.match(plan('SELECT * FROM repos WHERE full_name = ? COLLATE NOCASE'), /USING INDEX repos_full_name_nocase/);
    assert.match(plan("SELECT * FROM skills WHERE lower(substr(repo, instr(repo, '/') + 1)) = ?"), /USING INDEX skills_repo_tail/);
  });
});

describe('검색 쿼리 (1단계)', () => {
  const ctx = () => {
    const c = createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-store-')), githubToken: null }, ':memory:');
    const add = (repo: string | null, dir: string, name: string, description: string, origin: 'generic' | 'wellknown' = 'generic') => {
      const row = buildSkillRow({ repo: repo ?? 'x/y', sha: 'a'.repeat(40), dirPath: dir, raw: `---\nname: ${name}\ndescription: ${description}\n---\n`, tree: new TreeIndex([]), origin, pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
      c.store.upsertSkill({ ...row, repo, id: `${row.id}:${origin}` }, '');
    };
    return { c, add };
  };

  it('같은 이름 저장소 조회는 대소문자를 무시하고 소유자 뒤 이름 전체가 같아야 하며 wellknown은 뺀다', () => {
    const { c, add } = ctx();
    add('Morluto/REA', 'a', 'reverse-engineer-anything', 'Reverse engineer things.');
    add('someone/rea.js', 'b', 'other', 'Something else.');
    add('x/my_rea', 'c', 'third', 'Third.');
    add(null, 'd', 'site-rea', 'Well-known site skill.', 'wellknown');
    assert.deepEqual(c.store.findSkillsByRepoName('rea').map((s) => s.name), ['reverse-engineer-anything']);
    assert.deepEqual(c.store.findSkillsByRepoName('my_rea').map((s) => s.name), ['third'], '_는 와일드카드가 아님');
    assert.deepEqual(c.store.findSkillsByRepoName('rea.js').map((s) => s.name), ['other']);
  });

  it('점수가 같은 결과는 늘 같은 순서(rowid)로 나오고, 마켓플레이스 필터를 걸어도 limit을 채운다', () => {
    const { c, add } = ctx();
    for (let i = 0; i < 6; i++) add(`r${i}/same`, 's', `same-${i}`, 'Exactly the same widget text.');
    const ids = c.store.searchSkillsFts('"widget"', 6).map((h) => h.skill.name);
    assert.deepEqual(ids, ['same-0', 'same-1', 'same-2', 'same-3', 'same-4', 'same-5']);
    assert.deepEqual(c.store.searchSkillsFts('"widget"', 3).map((h) => h.skill.name), ids.slice(0, 3));
    // no plugin → marketplace null, which the filter keeps
    assert.equal(c.store.searchSkillsFts('"widget"', 4, ['anything']).length, 4);
  });
});

describe('데이터 백업·손상 복구 (전체 점검 #4)', () => {
  it('예전 형식의 데이터를 바꾸기 전에 앱 버전 이름으로 백업한다', async () => {
    const { existsSync } = await import('node:fs');
    const { DatabaseSync } = await import('node:sqlite');
    const { MIGRATIONS } = await import('../src/db/schema.ts');
    const path = join(mkdtempSync(join(tmpdir(), 'sf-bak-')), 'skill-finder.db');
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]);
    old.exec('PRAGMA user_version = 1');
    old.close();
    openDb(path, { backupLabel: '9.9.9' }).close();
    const bak = `${path}.before-9.9.9.bak`;
    assert.ok(existsSync(bak));
    const copy = new DatabaseSync(bak, { readOnly: true });
    assert.equal((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1, '바꾸기 전 형식 그대로');
    copy.close();
    openDb(path, { backupLabel: '9.9.10' }).close();
    assert.ok(!existsSync(`${path}.before-9.9.10.bak`), '이미 최신 형식이면 백업하지 않음');
  });

  it('손상된 데이터 파일은 옮겨 두고 백업으로 되살리며, 백업이 없으면 새로 시작한다', async () => {
    const { copyFileSync, readdirSync, rmSync, writeFileSync } = await import('node:fs');
    const { openContext } = await import('../src/bootstrap.ts');
    const dir = mkdtempSync(join(tmpdir(), 'sf-corrupt-'));
    const config = { port: 0, dev: false, dataDir: dir, githubToken: null };
    const path = join(dir, 'skill-finder.db');
    const good = createContext(config, path);
    good.store.upsertSkill(
      buildSkillRow({ repo: 'a/b', sha: '0'.repeat(40), dirPath: 'skills/x', raw: '---\nname: x\ndescription: X.\n---\n', tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null }),
      '',
    );
    good.store.db.close();
    copyFileSync(path, `${path}.before-0.0.1.bak`);
    writeFileSync(path, 'this is not a database '.repeat(200));
    const restored = openContext(config);
    assert.equal(restored.store.countSkills(), 1, '백업의 스킬이 돌아옴');
    restored.store.db.close();
    assert.ok(readdirSync(dir).some((f) => f.startsWith('skill-finder.db.corrupt-')), '손상된 파일은 지우지 않고 옮겨 둠');

    for (const f of readdirSync(dir)) if (f.endsWith('.bak')) rmSync(join(dir, f));
    writeFileSync(path, 'still not a database '.repeat(200));
    const fresh = openContext(config);
    assert.equal(fresh.store.countSkills(), 0);
    fresh.store.db.close();
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createContext } from '../src/bootstrap.ts';
import { openDb } from '../src/db/index.ts';
import { Store, clipOutput } from '../src/db/store.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow, writeSkillRow } from '../src/indexer.ts';

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

describe('트랜잭션 중첩과 검색 한 번의 묶음 쓰기', () => {
  const setup = () => {
    const store = new Store(openDb(':memory:'));
    const row = (name: string) =>
      buildSkillRow({ repo: 'o/r', sha: 'a'.repeat(40), dirPath: `skills/${name}`, raw: `---\nname: ${name}\ndescription: ${name} widget.\n---\n`, tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
    const installs = (id: string) => store.getSkill(id)?.installs ?? null;
    // a transaction left open makes BEGIN fail
    const txOpen = () => {
      try {
        store.db.exec('BEGIN');
        store.db.exec('ROLLBACK');
        return false;
      } catch {
        return true;
      }
    };
    return { store, row, installs, txOpen };
  };

  it('안쪽 transaction은 savepoint가 되어 바깥이 커밋할 때 함께 쓰이고, 안쪽만 실패하면 안쪽만 되돌린다', () => {
    const { store, row, txOpen } = setup();
    const [a, b, c] = [row('a'), row('b'), row('c')];
    const out = store.transaction(() => {
      store.upsertSkill(a, '');
      const inner = store.transaction(() => {
        store.upsertSkill(b, '');
        return store.transaction(() => store.countSkills()); // two levels down, reads its own writes
      });
      assert.throws(() =>
        store.transaction(() => {
          store.upsertSkill(c, '');
          throw new Error('inner');
        }),
      /inner/);
      return inner;
    });
    assert.equal(out, 2);
    assert.ok(store.getSkill(a.id) && store.getSkill(b.id));
    assert.equal(store.getSkill(c.id), undefined, '실패한 안쪽만 되돌림');
    assert.equal(store.countSkillsFts('"widget"'), 2, '전문 검색 항목도 같이');
    assert.equal(txOpen(), false);
  });

  it('바깥이 실패하면 이미 끝난 안쪽까지 모두 되돌리고 트랜잭션을 열어 두지 않는다', () => {
    const { store, row, txOpen } = setup();
    assert.throws(() =>
      store.transaction(() => {
        store.upsertSkill(row('a'), '');
        store.transaction(() => store.upsertSkill(row('b'), ''));
        throw new Error('outer');
      }),
    /outer/);
    assert.equal(store.countSkills(), 0);
    assert.equal(store.countSkillsFts('"widget"'), 0);
    assert.equal(txOpen(), false);
    // the next one is a real transaction again: its own throw undoes it
    assert.throws(() =>
      store.transaction(() => {
        store.upsertSkill(row('c'), '');
        throw new Error('again');
      }),
    /again/);
    assert.equal(store.countSkills(), 0);
    store.transaction(() => store.upsertSkill(row('d'), ''));
    assert.equal(store.countSkills(), 1);
    assert.equal(txOpen(), false);
  });

  it('후보마다의 설치 수를 한 트랜잭션으로 쓰면 같은 값이 쓰이고, 중간에 실패하면 하나도 남지 않는다', () => {
    const { store, row, installs, txOpen } = setup();
    const rows = ['a', 'b', 'c'].map(row);
    for (const r of rows) store.upsertSkill(r, '');
    // the pass in buildResults: a write per candidate, each read back (as withSuspicion's facts do) in between
    const seen = store.transaction(() =>
      rows.map((r, i) => {
        store.setSkillInstalls(r.id, (i + 1) * 100, '2026-11-12T00:00:00.000Z');
        return installs(r.id);
      }),
    );
    assert.deepEqual(seen, [100, 200, 300], '같은 트랜잭션 안에서 앞 후보의 쓰기가 보임');
    assert.deepEqual(rows.map((r) => installs(r.id)), [100, 200, 300]);
    assert.deepEqual(rows.map((r) => store.getSkill(r.id)?.installs_at), Array(3).fill('2026-11-12T00:00:00.000Z'));
    assert.throws(() =>
      store.transaction(() =>
        rows.map((r, i) => {
          if (i === 2) throw new Error('mid-pass');
          store.setSkillInstalls(r.id, 0);
          return r;
        }),
      ),
    /mid-pass/);
    assert.deepEqual(rows.map((r) => installs(r.id)), [100, 200, 300], '실패한 묶음은 되돌림');
    assert.equal(txOpen(), false);
  });

  it('호출한 쪽이 직접 연 BEGIN 안에서도 savepoint로 돌고, 그 BEGIN은 열어 둔 채 돌려준다 (벤치의 검색마다 롤백)', () => {
    const { store, row, txOpen } = setup();
    store.db.exec('BEGIN');
    store.transaction(() => store.upsertSkill(row('a'), ''));
    assert.throws(() =>
      store.transaction(() => {
        store.upsertSkill(row('b'), '');
        throw new Error('inner');
      }),
    /inner/);
    assert.equal(store.db.isTransaction, true, '바깥 BEGIN은 그대로');
    assert.equal(store.countSkills(), 1);
    store.db.exec('ROLLBACK');
    assert.equal(store.countSkills(), 0, '바깥 ROLLBACK이 안쪽 쓰기도 되돌림');
    assert.equal(txOpen(), false);
  });

  it('한 행씩 transaction으로 쓰는 writeSkillRow도 저장소 색인의 묶음 안에서 함께 커밋·롤백된다', () => {
    const { store, row, txOpen } = setup();
    const batch = (names: string[], failAt = -1) =>
      store.transaction(() =>
        names.forEach((n, i) => {
          if (i === failAt) throw new Error('batch');
          store.transaction(() => writeSkillRow(store, row(n), ''));
        }),
      );
    assert.throws(() => batch(['a', 'b', 'c'], 2), /batch/);
    assert.equal(store.countSkills(), 0);
    batch(['a', 'b', 'c']);
    assert.equal(store.countSkills(), 3);
    assert.equal(store.countSkillsFts('"widget"'), 3);
    assert.equal(txOpen(), false);
  });
});

describe('설치 기록 출력 자르기 (리뷰 2026-11-02)', () => {
  it('긴 출력은 앞과 끝(오류가 나오는 곳)을 남긴다', () => {
    const out = 'START' + 'x'.repeat(30_000) + 'ERROR at the end';
    const clipped = clipOutput(out);
    assert.ok(clipped.length < 20_100);
    assert.ok(clipped.startsWith('START'));
    assert.ok(clipped.endsWith('ERROR at the end'));
    assert.match(clipped, /중간 \d+자 생략/);
    assert.equal(clipOutput('short'), 'short');
  });
});

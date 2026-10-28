import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDb } from '../src/db/index.ts';

describe('DB 인덱스', () => {
  it('대소문자를 무시하는 저장소 조회도 인덱스를 쓴다', () => {
    const db = openDb(':memory:');
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('Owner/Repo') as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    assert.match(plan('SELECT * FROM skills WHERE repo = ? COLLATE NOCASE'), /USING INDEX skills_repo_nocase/);
    assert.match(plan('SELECT * FROM repos WHERE full_name = ? COLLATE NOCASE'), /USING INDEX repos_full_name_nocase/);
  });
});

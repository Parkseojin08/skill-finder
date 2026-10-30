import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

export type Db = DatabaseSync;

/** The data was written by a newer Skill Finder (UI debate D-6): an older one must not run on it. */
export class DataTooNewError extends Error {
  constructor(found: number, known: number) {
    super(
      `이 데이터는 더 새 버전의 Skill Finder가 만들었습니다 (데이터 버전 ${found}, 이 앱은 ${known}까지). ` +
        '새 버전의 Skill Finder를 실행하세요. 예전 버전으로 열면 데이터가 망가질 수 있어 시작하지 않습니다.',
    );
  }
}

/**
 * Reading the database through a memory map halves the local search's SQL time (14 → 7ms, same results) at
 * +0–5MB of private memory, where a 64MB page cache costs +35–40MB (perf debate 1-4). This SQLite build has no
 * Windows structured exception handling, so a disk read error while mapped ends the process instead of failing
 * one query: off for a network share, and SKILL_FINDER_MMAP=0 turns it off.
 */
export const MMAP_BYTES = 256 * 1024 * 1024;

export function mmapBytesFor(path: string, env: NodeJS.ProcessEnv = process.env): number {
  if (env.SKILL_FINDER_MMAP === '0' || path === ':memory:' || /^(\\\\|\/\/)/.test(path)) return 0;
  return MMAP_BYTES;
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
  const mmap = mmapBytesFor(path);
  if (mmap > 0) {
    db.exec(`PRAGMA mmap_size = ${mmap}`);
    const got = (db.prepare('PRAGMA mmap_size').get() as { mmap_size: number } | undefined)?.mmap_size ?? 0;
    if (got === 0) console.warn('[db] mmap을 쓸 수 없어 일반 읽기로 엽니다');
  }
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) throw new DataTooNewError(row.user_version, MIGRATIONS.length);
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

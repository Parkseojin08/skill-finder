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

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
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

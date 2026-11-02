import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

/**
 * `backupLabel`: names the copy made before a migration (`<db>.before-<label>.bak`, the app version), which the
 * launcher puts back when a new version fails to start (project review #4).
 */
export function openDb(path: string, opts: { backupLabel?: string | null } = {}): Db {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
    const mmap = mmapBytesFor(path);
    if (mmap > 0) {
      db.exec(`PRAGMA mmap_size = ${mmap}`);
      const got = (db.prepare('PRAGMA mmap_size').get() as { mmap_size: number } | undefined)?.mmap_size ?? 0;
      if (got === 0) console.warn('[db] mmap을 쓸 수 없어 일반 읽기로 엽니다');
    }
    migrate(db, path === ':memory:' ? undefined : (from) => backupBeforeMigration(db, path, opts.backupLabel || `v${from}`));
  } catch (err) {
    // let go of the file, so a damaged one can be moved aside (Windows refuses to rename an open file)
    db.close();
    throw err;
  }
  return db;
}

/** `beforeMigrating`: called once, with the stored version, when an existing database is about to change. */
export function migrate(db: Db, beforeMigrating?: (from: number) => void): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) throw new DataTooNewError(row.user_version, MIGRATIONS.length);
  if (row.user_version > 0 && row.user_version < MIGRATIONS.length) beforeMigrating?.(row.user_version);
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

const BACKUPS_KEPT = 2;
const backupsOf = (path: string) => {
  const dir = dirname(path);
  const prefix = `${basename(path)}.before-`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
    .map((f) => ({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
};

/** A copy of the database as it was before a newer version changes its tables; the two newest are kept. */
export function backupBeforeMigration(db: Db, path: string, label: string): string | null {
  const target = `${path}.before-${label.replace(/[^0-9A-Za-z._-]/g, '_')}.bak`;
  try {
    rmSync(target, { force: true });
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    for (const old of backupsOf(path).slice(BACKUPS_KEPT)) rmSync(old.path, { force: true });
    console.log(`[db] 데이터 형식을 바꾸기 전에 백업했습니다: ${target}`);
    return target;
  } catch (err) {
    // a full disk must not stop the app from starting; the migration itself still runs in a transaction
    console.warn('[db] 데이터 형식을 바꾸기 전 백업을 만들지 못했습니다:', err);
    return null;
  }
}

/** The newest backup made before a migration, if any. */
export function latestBackup(path: string): string | null {
  try {
    return backupsOf(path)[0]?.path ?? null;
  } catch {
    return null;
  }
}

/** SQLite cannot read the file as a database (damaged, or not one). */
export function isCorruptDb(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  return e?.errcode === 11 || e?.errcode === 26 || /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
}

/** Moves a damaged database and its -wal/-shm aside as `<db>.corrupt-<time>`, kept for a look; returns that name. */
export function setAsideCorrupt(path: string): string {
  const target = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(path, target);
  for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) renameSync(path + ext, target + ext);
  return target;
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

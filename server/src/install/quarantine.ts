// Copies kept before a skill folder is deleted or replaced (feature review F14, decision 15): for undo only, not a
// way to turn a skill off. The folder is copied into <data folder>/quarantine/<time>-<name>/ (a folder over 20MB is
// not kept, and the answer says so), kept 30 days and at most 20 entries, oldest removed first. Links are never
// followed: a linked skill folder loses only its link, and links inside a folder are left out of the copy.
// Plugins are Claude Code's to manage: not kept here, the page shows their reinstall command.
import { constants, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppContext } from '../context.ts';
import type { Store } from '../db/store.ts';
import { agentFolders } from './agents.ts';
import { pathKey } from './installed.ts';
import { isProjectDir } from './validate.ts';

export const QUARANTINE_MAX_BYTES = 20 * 1024 * 1024;
export const QUARANTINE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const QUARANTINE_MAX_ENTRIES = 20;
/** Deeper than this is not a skill folder anyone wrote by hand; the copy stops (and is not kept). */
const MAX_DEPTH = 32;
/** Same rule as uninstall.ts SKILL_FOLDER_RE (kept here to avoid an import cycle). */
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

export type QuarantineReason = 'delete' | 'overwrite';

export type QuarantineInput = {
  reason: QuarantineReason;
  /** Shown name (the skill's name or its folder). */
  name: string;
  skillId?: string | null;
  scope: 'user' | 'project';
  projectPath: string | null;
  agent?: string | null;
  /** The skill folder itself. */
  originalPath: string;
};

export type QuarantineOutcome =
  | { kept: true; id: number; bytes: number; files: number; skippedLinks: number }
  /** tooBig: over 20MB, not kept; link: the folder is a link (only the link goes); missing: nothing there; failed: the copy broke. */
  | { kept: false; reason: 'tooBig' | 'link' | 'missing' | 'failed'; bytes?: number; error?: string };

export type QuarantineRow = {
  id: number;
  created_at: string;
  reason: QuarantineReason;
  name: string;
  skill_id: string | null;
  scope: string | null;
  project_path: string | null;
  agent: string | null;
  original_path: string;
  stored_path: string;
  bytes: number;
  files: number;
  restored_at: string | null;
};

export const quarantineRoot = (dataDir: string) => join(dataDir, 'quarantine');

export type FolderSize = { bytes: number; files: number; links: number; over: boolean };

/** The size of a folder's files, links not followed; stops counting once past `limit` (`over`). */
export async function measureFolder(dir: string, limit = QUARANTINE_MAX_BYTES): Promise<FolderSize> {
  const out: FolderSize = { bytes: 0, files: 0, links: 0, over: false };
  const walk = async (d: string, depth: number): Promise<void> => {
    if (out.over) return;
    if (depth > MAX_DEPTH) {
      out.over = true;
      return;
    }
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (out.over) return;
      const p = join(d, e.name);
      if (e.isSymbolicLink()) out.links++;
      else if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) {
        out.bytes += (await lstat(p)).size;
        out.files++;
        if (out.bytes > limit) out.over = true;
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/**
 * Copies the files and folders of `from` into `to`, which must not exist yet (its parent must); links are left out.
 * `onCreated` is told once `to` is made, so a failure removes only what this copy made.
 */
async function copyTree(from: string, to: string, onCreated?: () => void, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) throw new Error('폴더가 너무 깊습니다');
  await mkdir(to);
  onCreated?.();
  for (const e of await readdir(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await copyTree(src, dst, undefined, depth + 1);
    else if (e.isFile()) await copyFile(src, dst, constants.COPYFILE_EXCL);
  }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '') + '-' + String(d.getUTCMilliseconds()).padStart(3, '0');
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 60) || 'skill';

/** Whether `p` is a folder directly inside the quarantine folder (a stored path read from the database is checked). */
export function inQuarantine(dataDir: string, p: string): boolean {
  const root = resolve(quarantineRoot(dataDir));
  return pathKey(dirname(resolve(p))) === pathKey(root) && basename(resolve(p)) !== '';
}

/** Copies a skill folder about to be deleted or replaced; then trims the kept ones to 30 days and 20 entries. */
export async function quarantineFolder(store: Store, dataDir: string, input: QuarantineInput, now = new Date()): Promise<QuarantineOutcome> {
  const original = resolve(input.originalPath);
  const st = await lstat(original).catch(() => null);
  if (!st) return { kept: false, reason: 'missing' };
  if (st.isSymbolicLink()) return { kept: false, reason: 'link' };
  if (!st.isDirectory()) return { kept: false, reason: 'missing' };
  let size: FolderSize;
  try {
    size = await measureFolder(original);
  } catch (err) {
    return { kept: false, reason: 'failed', error: String((err as Error).message ?? err).slice(0, 200) };
  }
  if (size.over) return { kept: false, reason: 'tooBig', bytes: size.bytes };
  const root = quarantineRoot(dataDir);
  await mkdir(root, { recursive: true });
  let stored = join(root, `${stamp(now)}-${safeName(input.name)}`);
  for (let n = 2; existsSync(stored); n++) stored = join(root, `${stamp(now)}-${safeName(input.name)}-${n}`);
  let made = false;
  try {
    await copyTree(original, stored, () => (made = true));
  } catch (err) {
    if (made) await rm(stored, { recursive: true, force: true }).catch(() => {});
    return { kept: false, reason: 'failed', error: String((err as Error).message ?? err).slice(0, 200) };
  }
  const r = store.db
    .prepare(
      `INSERT INTO quarantine (created_at, reason, name, skill_id, scope, project_path, agent, original_path, stored_path, bytes, files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(now.toISOString(), input.reason, input.name.slice(0, 200), input.skillId ?? null, input.scope, input.projectPath, input.agent ?? null, original, stored, size.bytes, size.files);
  await pruneQuarantine(store, dataDir, now);
  return { kept: true, id: Number(r.lastInsertRowid), bytes: size.bytes, files: size.files, skippedLinks: size.links };
}

/** Removes kept copies older than 30 days and past the newest 20, and folders the table does not know. */
export async function pruneQuarantine(store: Store, dataDir: string, now = new Date()): Promise<{ removed: number; orphans: number }> {
  const rows = store.db.prepare('SELECT id, created_at, stored_path, restored_at FROM quarantine ORDER BY created_at DESC, id DESC').all() as Array<{ id: number; created_at: string; stored_path: string; restored_at: string | null }>;
  const cutoff = new Date(now.getTime() - QUARANTINE_KEEP_MS).toISOString();
  // the newest 20 copies still kept: a restored entry holds no copy, so it does not push an older copy out (it
  // stays in the list until it is 30 days old; review 2026-11-10)
  let kept = 0;
  const drop = rows.filter((r) => r.created_at < cutoff || (!r.restored_at && ++kept > QUARANTINE_MAX_ENTRIES));
  for (const r of drop) {
    if (inQuarantine(dataDir, r.stored_path)) await rm(r.stored_path, { recursive: true, force: true }).catch(() => {});
    store.db.prepare('DELETE FROM quarantine WHERE id = ?').run(r.id);
  }
  // a copy made just before a crash, never written down
  let orphans = 0;
  const root = quarantineRoot(dataDir);
  const known = new Set(rows.filter((r) => !drop.includes(r)).map((r) => pathKey(resolve(r.stored_path))));
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const p = join(root, e.name);
    if (known.has(pathKey(resolve(p)))) continue;
    // one being written right now has no row yet: leave anything younger than an hour
    const st = await lstat(p).catch(() => null);
    if (!st || now.getTime() - st.mtimeMs < 60 * 60 * 1000) continue;
    await rm(p, { recursive: true, force: true }).catch(() => {});
    orphans++;
  }
  return { removed: drop.length, orphans };
}

export function listQuarantine(store: Store): QuarantineRow[] {
  return store.db.prepare('SELECT * FROM quarantine ORDER BY created_at DESC, id DESC LIMIT ?').all(QUARANTINE_MAX_ENTRIES * 2) as QuarantineRow[];
}

/**
 * A skill folder of the app's install places: directly inside one of agents.ts's skill folders for the scope (the
 * project's for a project that exists), with a plain folder name. Null for anything else, `..` and other spellings
 * included. Used for a restore's stored original_path and for the size asked before a delete or overwrite.
 */
export function skillFolderTarget(scope: unknown, projectPath: string | null, path: unknown, home = homedir()): string | null {
  if (typeof path !== 'string' || !path || path.length > 2000 || /[\0\r\n]/.test(path)) return null;
  if (scope !== 'user' && scope !== 'project') return null;
  if (scope === 'project' && !isProjectDir(projectPath)) return null;
  const target = resolve(path);
  const name = basename(target);
  if (!FOLDER_RE.test(name) || name.includes('..')) return null;
  const roots = agentFolders(scope, scope === 'user' ? home : projectPath!).map((f) => pathKey(resolve(f.dir)));
  return roots.includes(pathKey(dirname(target))) ? target : null;
}

export type RestoreResult = { ok: true; path: string } | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/** Copies a kept folder back where it was, only when nothing is there now; the kept copy is then removed. */
export async function restoreQuarantine(store: Store, dataDir: string, id: number, home = homedir()): Promise<RestoreResult> {
  const row = store.db.prepare('SELECT * FROM quarantine WHERE id = ?').get(id) as QuarantineRow | undefined;
  if (!row) return { ok: false, status: 404, error: '보관한 항목을 찾을 수 없습니다' };
  if (row.restored_at) return { ok: false, status: 409, error: '이미 되돌린 항목입니다' };
  if (!inQuarantine(dataDir, row.stored_path) || !existsSync(row.stored_path)) return { ok: false, status: 404, error: '보관한 복사본이 없습니다(30일이 지났거나 지워짐)' };
  // where it goes is checked again: the stored path must still be one of the install places
  const target = skillFolderTarget(row.scope, row.project_path, row.original_path, home);
  if (!target) return { ok: false, status: 400, error: '원래 위치가 지금은 허용된 설치 위치가 아니라 되돌리지 않았습니다' };
  if (await lstat(target).catch(() => null)) {
    return { ok: false, status: 409, error: `원래 위치(${target})에 이미 같은 이름의 폴더가 있어 되돌리지 않았습니다. 그 폴더를 지우거나 옮긴 뒤 다시 되돌리세요.` };
  }
  let made = false;
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyTree(row.stored_path, target, () => (made = true));
  } catch (err) {
    // only what this restore made is removed: a folder that appeared meanwhile is someone else's
    if (made) await rm(target, { recursive: true, force: true }).catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' && !made) return { ok: false, status: 409, error: `원래 위치(${target})에 이미 같은 이름의 폴더가 있어 되돌리지 않았습니다.` };
    return { ok: false, status: 500, error: `되돌리지 못했습니다: ${String((err as Error).message ?? err).slice(0, 200)}` };
  }
  store.db.prepare('UPDATE quarantine SET restored_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  await rm(row.stored_path, { recursive: true, force: true }).catch(() => {});
  return { ok: true, path: target };
}

/** The daily clean-up task: kept copies past 30 days or the newest 20 go. */
export async function runQuarantinePrune(ctx: AppContext): Promise<{ counts?: Record<string, number> }> {
  const r = await pruneQuarantine(ctx.store, ctx.config.dataDir);
  return { counts: { removed: r.removed, orphans: r.orphans } };
}

/** Removes one kept copy and its row (the delete or install it was made for did not go ahead). */
export async function dropQuarantine(store: Store, dataDir: string, id: number): Promise<void> {
  const row = store.db.prepare('SELECT stored_path FROM quarantine WHERE id = ?').get(id) as { stored_path: string } | undefined;
  if (!row) return;
  if (inQuarantine(dataDir, row.stored_path)) await rm(row.stored_path, { recursive: true, force: true }).catch(() => {});
  store.db.prepare('DELETE FROM quarantine WHERE id = ?').run(id);
}

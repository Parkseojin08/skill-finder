import { createHash } from 'node:crypto';
import type { Store } from '../db/store.ts';
import { isRepo } from '../install/validate.ts';

/**
 * Hidden repositories and trusted owners (F20, feature review 2026-11-04; user decision 18 for U7). Stored in the
 * server's database (table `owner_prefs`), so they stay when the app's port or browser changes.
 *
 * - `hide`: the repo's (or every repo of the owner's) skills are left out of searches, README recommendations and
 *   browsing before the result lists are cut, with a "숨긴 저장소 N개 · 보기" chip to show them for one search.
 * - `trust`: only a side filter ("믿는 제작자"). It changes neither the order nor the risk level of anything.
 *
 * Keys are lower case: `owner/repo` (kind `repo`) or `owner` (kind `owner`), checked as strictly as the install
 * commands' repo names (install/validate.ts).
 */

export type OwnerPrefKind = 'repo' | 'owner';
export type OwnerPrefValue = 'hide' | 'trust';
export type OwnerPref = { key: string; kind: OwnerPrefKind; pref: OwnerPrefValue; createdAt: string };

/** A GitHub owner name (the owner half of install/validate.ts OWNER_REPO_RE). */
const OWNER_RE = /^[a-z0-9-]{1,39}$/;
/** More than anyone hides by hand; a bound so the table and the cache-key hash stay small. */
export const MAX_OWNER_PREFS = 2000;

/** The key as stored (lower case), or null when it is not a repo or owner name of that kind. */
export function normalizeOwnerKey(key: unknown, kind: unknown): string | null {
  if (typeof key !== 'string' || key.length > 141) return null;
  const k = key.trim().toLowerCase();
  if (kind === 'repo') return isRepo(k) ? k : null;
  if (kind === 'owner') return OWNER_RE.test(k) ? k : null;
  return null;
}

export const isOwnerPrefValue = (v: unknown): v is OwnerPrefValue => v === 'hide' || v === 'trust';

type Row = { key: string; kind: string; pref: string; created_at: string };

/** What searches read, built once per change of the table (writes go through this module). */
type State = {
  list: OwnerPref[];
  hiddenRepos: Set<string>;
  hiddenOwners: Set<string>;
  trustedRepos: Set<string>;
  trustedOwners: Set<string>;
  /** Hash of the hidden keys ('' when none): part of cache keys, so hiding changes the cached searches it affects. */
  hideHash: string;
  /** Hash of the trusted keys ('' when none): part of a cache key only when a search filters on trust. */
  trustHash: string;
};

const states = new WeakMap<Store, State>();

const hash = (keys: string[]) => (keys.length ? createHash('sha256').update(keys.sort().join('\n')).digest('hex').slice(0, 16) : '');

function load(store: Store): State {
  const hit = states.get(store);
  if (hit) return hit;
  const rows = store.db.prepare('SELECT key, kind, pref, created_at FROM owner_prefs ORDER BY created_at DESC, key').all() as Row[];
  const list: OwnerPref[] = [];
  const s: State = { list, hiddenRepos: new Set(), hiddenOwners: new Set(), trustedRepos: new Set(), trustedOwners: new Set(), hideHash: '', trustHash: '' };
  for (const r of rows) {
    if ((r.kind !== 'repo' && r.kind !== 'owner') || !isOwnerPrefValue(r.pref)) continue;
    list.push({ key: r.key, kind: r.kind, pref: r.pref, createdAt: r.created_at });
    const set = r.pref === 'hide' ? (r.kind === 'repo' ? s.hiddenRepos : s.hiddenOwners) : r.kind === 'repo' ? s.trustedRepos : s.trustedOwners;
    set.add(r.key);
  }
  s.hideHash = hash(list.filter((p) => p.pref === 'hide').map((p) => `${p.kind}:${p.key}`));
  s.trustHash = hash(list.filter((p) => p.pref === 'trust').map((p) => `${p.kind}:${p.key}`));
  states.set(store, s);
  return s;
}

export function listOwnerPrefs(store: Store): OwnerPref[] {
  return [...load(store).list];
}

export class OwnerPrefError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Adds or replaces the preference for `key` (a key is either hidden or trusted, not both). */
export function setOwnerPref(store: Store, key: unknown, kind: unknown, pref: unknown, now = new Date()): OwnerPref {
  const k = normalizeOwnerKey(key, kind);
  if (!k) throw new OwnerPrefError(kind === 'owner' ? '제작자 이름이 올바르지 않습니다' : '저장소 이름(owner/repo)이 올바르지 않습니다');
  if (!isOwnerPrefValue(pref)) throw new OwnerPrefError('pref는 hide 또는 trust여야 합니다');
  const s = load(store);
  if (!s.list.some((p) => p.key === k) && s.list.length >= MAX_OWNER_PREFS) throw new OwnerPrefError(`최대 ${MAX_OWNER_PREFS}개까지 저장할 수 있습니다`);
  const createdAt = now.toISOString();
  store.db
    .prepare('INSERT INTO owner_prefs (key, kind, pref, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, pref = excluded.pref, created_at = excluded.created_at')
    .run(k, kind as string, pref, createdAt);
  states.delete(store);
  return { key: k, kind: kind as OwnerPrefKind, pref, createdAt };
}

/** Removes the preference for `key` (either kind); whether there was one. */
export function deleteOwnerPref(store: Store, key: unknown): boolean {
  if (typeof key !== 'string') return false;
  const k = key.trim().toLowerCase();
  const kind = k.includes('/') ? 'repo' : 'owner';
  if (!normalizeOwnerKey(k, kind)) return false;
  const changed = Number(store.db.prepare('DELETE FROM owner_prefs WHERE key = ?').run(k).changes) > 0;
  states.delete(store);
  return changed;
}

/** Drops the in-memory copy (tests that write the table directly). */
export function clearOwnerPrefsCache(store: Store): void {
  states.delete(store);
}

/** `owner/repo` → its owner (lower case), or null. */
export const ownerOfRepo = (repo: string | null | undefined): string | null => (repo ? (repo.split('/')[0]?.toLowerCase() ?? null) : null);

export type OwnerFilter = {
  /** Whether this repo is hidden (itself, or its owner). */
  hidden(repo: string | null | undefined): boolean;
  /** Whether this repo's owner (or the repo itself) is trusted. */
  trusted(repo: string | null | undefined): boolean;
  /** Something is hidden at all (searches skip the work when not). */
  anyHidden: boolean;
  hideHash: string;
  trustHash: string;
};

/** The current preferences as checks for one search or listing. `showHidden`: this one shows hidden repos too. */
export function ownerFilter(store: Store, opts: { showHidden?: boolean } = {}): OwnerFilter {
  const s = load(store);
  const anyHidden = !opts.showHidden && (s.hiddenRepos.size > 0 || s.hiddenOwners.size > 0);
  return {
    anyHidden,
    hideHash: anyHidden ? s.hideHash : '',
    trustHash: s.trustHash,
    hidden(repo) {
      if (!anyHidden || !repo) return false;
      const r = repo.toLowerCase();
      return s.hiddenRepos.has(r) || s.hiddenOwners.has(ownerOfRepo(r)!);
    },
    trusted(repo) {
      if (!repo) return false;
      const r = repo.toLowerCase();
      return s.trustedRepos.has(r) || s.trustedOwners.has(ownerOfRepo(r)!);
    },
  };
}

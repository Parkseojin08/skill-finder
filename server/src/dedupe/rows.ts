// Writes of the stage-3 columns the store's upserts leave alone (skills.minhash / skill_md_blob / cluster_id,
// plugins.tree_fingerprint). Kept here so store.ts stays as it is; each statement is prepared once per database.
import type { StatementSync } from 'node:sqlite';
import type { SkillRow, Store } from '../db/store.ts';

const prepared = new WeakMap<Store, Map<string, StatementSync>>();
export function stmt(store: Store, sql: string): StatementSync {
  let m = prepared.get(store);
  if (!m) prepared.set(store, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = store.db.prepare(sql)));
  return s;
}

/**
 * Databases whose signatures were not written since their near-copy groups were last worked out: the hourly grouping
 * (dedupe/clusters.ts) has nothing to redo for them. One just opened is not in it, so its first pass always runs.
 */
const groupsCurrent = new WeakSet<Store>();
export const signaturesChanged = (store: Store): boolean => !groupsCurrent.has(store);
export const markGroupsCurrent = (store: Store): void => void groupsCurrent.add(store);

/**
 * Stores the blob and signature a built row carries (upsertSkill does not write them). A field the row leaves out
 * (undefined) is kept as stored; null clears it.
 */
export function saveSkillExtras(store: Store, row: Pick<SkillRow, 'id' | 'skill_md_blob' | 'minhash'>): void {
  if (row.skill_md_blob !== undefined) stmt(store, 'UPDATE skills SET skill_md_blob = ? WHERE id = ?').run(row.skill_md_blob, row.id);
  if (row.minhash !== undefined) {
    stmt(store, 'UPDATE skills SET minhash = ? WHERE id = ?').run(row.minhash, row.id);
    groupsCurrent.delete(store);
  }
}

/** The fingerprint a plugin's skills were indexed at; null after a failed or partial read (it is read in full next). */
export function setPluginFingerprint(store: Store, pluginId: string, fingerprint: string | null): void {
  stmt(store, 'UPDATE plugins SET tree_fingerprint = ? WHERE id = ?').run(fingerprint, pluginId);
}

/**
 * A plugin whose folder did not change while its marketplace moved (B9): its rows point at the new commit, nothing
 * else is read or rebuilt. Returns the rows touched.
 */
export function moveSkillsToCommit(store: Store, pluginId: string, ref: string, lastCommitAt: string | null): number {
  const r = stmt(store, 'UPDATE skills SET ref = ?, last_commit_at = COALESCE(?, last_commit_at) WHERE plugin_id = ?').run(ref, lastCommitAt, pluginId);
  return Number(r.changes);
}

/** Sets one skill's signature (the re-check and the detail view fill rows indexed before B8). */
export function setSkillMinhash(store: Store, id: string, sha256: string, minhash: Uint8Array | null): boolean {
  const r = stmt(store, 'UPDATE skills SET minhash = ? WHERE id = ? AND skill_md_sha256 = ?').run(minhash, id, sha256);
  if (Number(r.changes) > 0) groupsCurrent.delete(store);
  return Number(r.changes) > 0;
}

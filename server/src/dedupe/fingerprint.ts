// Content-addressed re-indexing (feature review B9). A relative-path plugin takes its marketplace's commit as its
// own (D#6d35), so every marketplace commit queued all of them again (53 official plugins re-read for one changed
// file). The tree already says what each file is (its git blob SHA): a plugin folder whose path + blob list is the
// same as when its skills were indexed holds the same skills, and is not downloaded again.
import { createHash } from 'node:crypto';
import type { TreeIndex } from '../discovery/tree.ts';

/** Bumped when what is derived from a plugin folder changes (discovery rules), so every plugin is read once again. */
export const FINGERPRINT_VERSION = 1;

/**
 * The hash of a plugin folder's files (path and blob SHA, sorted) plus what else its skills are built from: the
 * marketplace entry and the source kind. Null when the tree did not give a blob SHA for every file (a fake or an
 * older tree): such a plugin is read as before.
 */
export function pluginTreeFingerprint(index: TreeIndex, root: string, extra: { entryJson: string | null; sourceKind: string }): string | null {
  const files = index.filesUnder(root);
  if (files.length === 0 || files.some((f) => !f.sha)) return null;
  const h = createHash('sha256');
  h.update(`v${FINGERPRINT_VERSION}\0${root}\0${extra.sourceKind}\0${extra.entryJson ?? ''}\0`);
  // filesUnder sorts with localeCompare; a plain code-unit order is stable across machines and locales
  for (const f of files.map((f) => `${f.path}\0${f.sha}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) h.update(`${f}\n`);
  return h.digest('hex');
}

/** The git blob SHA of a file in the tree, or null when the tree does not say. */
export function blobOf(index: TreeIndex, path: string): string | null {
  const sha = index.files.get(path)?.sha;
  return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
}

// Paths and folder names compared as this platform's file systems tell them apart by default: any case on Windows
// and macOS, as written elsewhere (Linux: `Demo` and `demo` are two folders), and either slash only on Windows. Until
// the first CI run (2026-11-12) every platform got Windows' rule, so on Linux `.Claude/skills` passed for
// `.claude/skills` and two folders differing in case were listed as one. A file system that differs from its
// platform's default (a case-sensitive macOS volume, a case-insensitive mount on Linux) is not detected: where it
// matters whether two paths are the same folder, compare what they lead to (stat: device and inode) instead.
import { sep } from 'node:path';

/** Whether this platform's file systems ignore case by default. */
export const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

/** Two folder or file names, as the file system would tell them apart. */
export const sameName = (a: string, b: string) => (FOLD_CASE ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * A path for comparing, never for building one: no trailing separator, the case folded where the file system ignores
 * it, and on Windows either slash as a backslash (Claude Code writes both). Outside Windows `\` is a character of a
 * name and stays one.
 */
export const pathKey = (p: string) => {
  const s = process.platform === 'win32' ? p.replace(/\//g, '\\').replace(/\\+$/, '') : p.replace(/\/+$/, '');
  return FOLD_CASE ? s.toLowerCase() : s;
};

/** Whether `child` is `parent` or inside it (both as pathKey compares them). */
export const pathWithin = (child: string, parent: string) => {
  const a = pathKey(child);
  const b = pathKey(parent);
  return a === b || a.startsWith(b + sep);
};

import { readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathKey, sameName } from './paths.ts';

/**
 * Drag & drop of a folder into the browser gives its name and the names inside it, never its absolute
 * path (browser security). This finds the folder on disk: a breadth-first walk from the user's home
 * (plus a few given hint folders) for directories with that name, ranked by how many of the dropped
 * entries they contain. Only directory listings are read.
 */

const SKIP = new Set(['node_modules', 'appdata', 'library', '$recycle.bin', 'windows', 'program files', 'program files (x86)', 'dist', 'build', 'target', 'venv', '__pycache__']);
const MAX_DEPTH = 6;
const MAX_DIRS = 40_000;
const TIME_LIMIT_MS = 3000;
/** A candidate must contain at least this share of the dropped entries. */
const MIN_OVERLAP = 0.6;

export type FolderMatch = { path: string; overlap: number };


function listNames(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

export function resolveDroppedFolder(name: string, entries: string[], hints: string[] = []): FolderMatch[] {
  const wanted = new Set(entries.map((e) => e.toLowerCase()));
  const started = Date.now();
  const seen = new Set<string>();
  const matches: FolderMatch[] = [];
  const queue: Array<[string, number]> = [];
  const home = homedir();
  // Hints first (parents of known project folders), then the whole home tree.
  for (const h of [...hints.map((p) => dirname(p)), home]) if (h) queue.push([h, 0]);

  let visited = 0;
  while (queue.length && visited < MAX_DIRS && Date.now() - started < TIME_LIMIT_MS) {
    const [dir, depth] = queue.shift()!;
    // one visit per folder as this platform tells folders apart (Linux: Demo and demo are two)
    const key = pathKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    visited++;
    const children = listNames(dir);
    if (!children) continue;
    for (const c of children) {
      if (!c.isDirectory()) continue;
      const lower = c.name.toLowerCase();
      const full = join(dir, c.name);
      if (sameName(c.name, name)) {
        const inside = listNames(full);
        if (inside) {
          const names = new Set(inside.map((e) => e.name.toLowerCase()));
          const hit = wanted.size ? [...wanted].filter((w) => names.has(w)).length / wanted.size : 1;
          if (hit >= MIN_OVERLAP && !matches.some((m) => pathKey(m.path) === pathKey(full))) matches.push({ path: full, overlap: hit });
        }
      }
      if (depth + 1 < MAX_DEPTH && !lower.startsWith('.') && !SKIP.has(lower)) queue.push([full, depth + 1]);
    }
  }
  const mtime = (p: string) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  return matches.sort((a, b) => b.overlap - a.overlap || mtime(b.path) - mtime(a.path)).slice(0, 5);
}

/** Folder name check for the API: one path segment, no traversal. */
export function isPlainFolderName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name === basename(name) && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

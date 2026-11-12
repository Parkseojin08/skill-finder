export type FileInfo = { size: number | null; sha: string | null };

/** Read-only view over a repository's blob paths with directory helpers. */
export class TreeIndex {
  readonly files: Map<string, FileInfo>;
  private readonly children = new Map<string, Set<string>>();

  /**
   * Every directory of a path is the part before one of its slashes. Each is registered once: walk up from the file's
   * parent to the nearest known directory, then add the missing ones top-down, so the maps get the same keys in the
   * same order as a per-segment loop. Git lists siblings together, so a file in the previous file's directory skips
   * the walk. (kubernetes, 31k files: about 30 ms instead of 140 on Node 24; test/tree.test.ts keeps the old loop.)
   */
  constructor(entries: Iterable<{ path: string; size?: number | null; sha?: string | null }>) {
    const files = new Map<string, FileInfo>();
    this.files = files;
    const children = this.children;
    const root = new Set<string>();
    children.set('', root);
    const ends: number[] = [];
    let lastDir = '';
    for (const e of entries) {
      let path = e.path;
      if (path.charCodeAt(0) === 47) path = path.replace(/^\/+/, ''); // 47 = '/'
      files.set(path, { size: e.size ?? null, sha: e.sha ?? null });
      const slash = path.lastIndexOf('/');
      if (slash < 0 || (slash === lastDir.length && path.startsWith(lastDir))) continue;
      let parent = root;
      let top = -1;
      let n = 0;
      for (let end = slash; end > 0; end = path.lastIndexOf('/', end - 1)) {
        const known = children.get(path.slice(0, end));
        if (known) {
          parent = known;
          top = end;
          break;
        }
        ends[n++] = end;
      }
      while (n > 0) {
        const end = ends[--n];
        const set = new Set<string>();
        parent.add(path.slice(top + 1, end));
        children.set(path.slice(0, end), set);
        parent = set;
        top = end;
      }
      lastDir = path.slice(0, slash);
    }
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  hasDir(path: string): boolean {
    return path === '' || this.children.has(path);
  }

  /** Immediate child directory paths, sorted. */
  childDirs(dir: string): string[] {
    const names = [...(this.children.get(dir) ?? [])].sort();
    return names.map((n) => (dir ? `${dir}/${n}` : n));
  }

  /** Files under a directory, as paths relative to it. */
  filesUnder(dir: string): Array<{ path: string } & FileInfo> {
    const prefix = dir ? `${dir}/` : '';
    const out: Array<{ path: string } & FileInfo> = [];
    for (const [path, info] of this.files) if (path.startsWith(prefix)) out.push({ path: path.slice(prefix.length), ...info });
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  dirHasAnyFile(dir: string): boolean {
    const prefix = dir ? `${dir}/` : '';
    for (const path of this.files.keys()) if (path.startsWith(prefix)) return true;
    return false;
  }
}

export const joinPath = (...parts: string[]) => parts.filter((p) => p !== '' && p !== '.').join('/');

export const skillMdPath = (dir: string) => joinPath(dir, 'SKILL.md');

export const basename = (p: string) => p.split('/').pop() ?? p;

/**
 * Normalizes a manifest-relative path ("./skills/x", ".", "skills/x/") against a base directory.
 * Returns null when the path escapes the base or is absolute.
 */
export function resolveRel(base: string, rel: string): string | null {
  if (typeof rel !== 'string') return null;
  if (/^([a-zA-Z]:|\/|\\)/.test(rel)) return null;
  const out = base ? base.split('/') : [];
  const depthFloor = out.length;
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length <= depthFloor) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

export type FileInfo = { size: number | null; sha: string | null };

/** Read-only view over a repository's blob paths with directory helpers. */
export class TreeIndex {
  readonly files: Map<string, FileInfo>;
  private readonly children = new Map<string, Set<string>>();

  constructor(entries: Iterable<{ path: string; size?: number | null; sha?: string | null }>) {
    this.files = new Map();
    this.children.set('', new Set());
    for (const e of entries) {
      const path = e.path.replace(/^\/+/, '');
      this.files.set(path, { size: e.size ?? null, sha: e.sha ?? null });
      const parts = path.split('/');
      let dir = '';
      for (let i = 0; i < parts.length - 1; i++) {
        const child = dir ? `${dir}/${parts[i]}` : parts[i];
        let set = this.children.get(dir);
        if (!set) this.children.set(dir, (set = new Set()));
        set.add(parts[i]);
        if (!this.children.has(child)) this.children.set(child, new Set());
        dir = child;
      }
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

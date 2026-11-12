import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type FileInfo, TreeIndex } from '../src/discovery/tree.ts';

type Entry = { path: string; size?: number | null; sha?: string | null };

/** The TreeIndex of 0.3.7 (one Map lookup and one joined string per path segment), frozen as the reference. */
class OldTreeIndex {
  readonly files: Map<string, FileInfo>;
  readonly children = new Map<string, Set<string>>();

  constructor(entries: Iterable<Entry>) {
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

  childDirs(dir: string): string[] {
    const names = [...(this.children.get(dir) ?? [])].sort();
    return names.map((n) => (dir ? `${dir}/${n}` : n));
  }

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

// The directory map is private; reading it here pins the key order and each directory's child order as well.
const childrenOf = (t: TreeIndex) => (t as unknown as { children: Map<string, Set<string>> }).children;

/**
 * Builds both indexes from the same entries and compares everything they expose. `probes` are extra paths to ask
 * about; `scanDirs` (filesUnder, dirHasAnyFile: a pass over every file each) defaults to every directory.
 */
function assertSameAsOld(entries: Entry[], opts: { probes?: string[]; scanDirs?: string[] } = {}) {
  const old = new OldTreeIndex(entries);
  // a one-shot iterable: the constructor must read the entries in a single pass
  const neu = new TreeIndex((function* () { yield* entries; })());

  assert.deepEqual([...neu.files], [...old.files], 'files: keys, order and values');
  const kids = childrenOf(neu);
  assert.deepEqual([...kids.keys()], [...old.children.keys()], 'directories and their order');
  for (const [dir, names] of old.children) assert.deepEqual([...kids.get(dir)!], [...names], `child names of "${dir}"`);

  for (const dir of old.children.keys()) {
    assert.equal(neu.hasDir(dir), true, `hasDir("${dir}")`);
    assert.equal(neu.hasFile(dir), old.hasFile(dir), `hasFile("${dir}")`);
    assert.deepEqual(neu.childDirs(dir), old.childDirs(dir), `childDirs("${dir}")`);
  }
  for (const path of old.files.keys()) {
    assert.equal(neu.hasFile(path), true, `hasFile("${path}")`);
    assert.equal(neu.hasDir(path), old.hasDir(path), `hasDir("${path}")`);
  }
  for (const p of opts.probes ?? []) {
    assert.equal(neu.hasFile(p), old.hasFile(p), `probe hasFile("${p}")`);
    assert.equal(neu.hasDir(p), old.hasDir(p), `probe hasDir("${p}")`);
    assert.deepEqual(neu.childDirs(p), old.childDirs(p), `probe childDirs("${p}")`);
  }
  for (const dir of opts.scanDirs ?? [...old.children.keys(), ...(opts.probes ?? [])]) {
    assert.deepEqual(neu.filesUnder(dir), old.filesUnder(dir), `filesUnder("${dir}")`);
    assert.equal(neu.dirHasAnyFile(dir), old.dirHasAnyFile(dir), `dirHasAnyFile("${dir}")`);
  }
  return { files: old.files.size, dirs: old.children.size };
}

/** Every prefix of every path (with and without a trailing slash), plus a few that exist nowhere. */
function prefixProbes(entries: Entry[]): string[] {
  const out = new Set(['', '/', '//', 'nope', 'nope/x', ' ']);
  for (const { path } of entries) {
    for (let i = 0; i <= path.length; i++) out.add(path.slice(0, i));
    out.add(`/${path}`);
    out.add(`${path}/`);
  }
  return [...out];
}

describe('TreeIndex: 0.3.7 동작 그대로', () => {
  const cases: Record<string, Entry[]> = {
    'empty tree': [],
    'empty path': [{ path: '' }],
    'only slashes': [{ path: '/' }, { path: '///', size: 3 }],
    'root files': [{ path: 'README.md' }, { path: 'LICENSE', size: 10, sha: 'a'.repeat(40) }],
    'duplicate after stripping (value replaced, first position kept)': [
      { path: 'README.md', size: 1 },
      { path: 'x/y' },
      { path: '/README.md', size: 5 },
      { path: '//x/y', sha: 'b' },
    ],
    'same path three times': [{ path: 'a/b/c.txt' }, { path: 'a/b/c.txt', sha: 'x' }, { path: 'a/b/c.txt', size: 0 }],
    'leading slashes': [{ path: '/a/b' }, { path: '//a/c/d' }, { path: '///e' }],
    'a file and a directory with the same path': [{ path: 'a' }, { path: 'a/b' }, { path: 'c/d' }, { path: 'c' }],
    'empty segments and trailing slashes': [
      { path: 'a//b' },
      { path: 'a/' },
      { path: 'a//' },
      { path: '/a//b//c' },
      { path: 'q///' },
      { path: 'r/s/' },
    ],
    'children listed before parents, siblings split': [
      { path: 'x/y/z/f' },
      { path: 'x/f' },
      { path: 'x/y/g' },
      { path: 'x/y/z/w/h' },
      { path: 'x/y2/f' },
      { path: 'x/y/z/w2/h' },
      { path: 'x/a/f' },
    ],
    'unsorted with repeats': [{ path: 'z/1' }, { path: 'a/1' }, { path: 'm/1' }, { path: 'a/b/1' }, { path: 'a/1' }, { path: 'z/0' }],
    'previous-directory shortcut traps': [
      { path: 'a/b/c' },
      { path: 'a/bc/d' }, // starts with "a/b" but its parent is longer
      { path: 'a/c/e' }, // parent as long as "a/bc" but different
      { path: 'a/c/f' }, // same parent as the previous file
      { path: 'top' }, // a root file between two files of a/c
      { path: 'a/c/g' },
      { path: 'a/c/h/i' }, // one deeper than the previous parent
      { path: 'a/c/j' },
      { path: 'b/c/j' },
      { path: 'a/c/k' },
    ],
    'non-ASCII names': [{ path: '한글/파일.md' }, { path: 'é/ü/x' }, { path: '😀/a/b' }, { path: '😀/a' }],
    'size and sha defaults': [
      { path: 'f', size: 0, sha: '' },
      { path: 'g', size: null, sha: undefined },
      { path: 'h' },
      { path: 'i', size: 12345, sha: 'c'.repeat(40) },
    ],
    'deep paths': [
      { path: `${Array.from({ length: 200 }, (_, i) => `d${i}`).join('/')}/f` },
      { path: `${Array.from({ length: 100 }, (_, i) => `d${i}`).join('/')}/g` },
      { path: `${Array.from({ length: 150 }, (_, i) => `d${i}`).join('/')}/h/i` },
      { path: `${Array.from({ length: 300 }, () => 'x').join('/')}` },
      { path: `/${Array.from({ length: 50 }, () => '').join('/')}deep` },
    ],
  };
  for (const [name, entries] of Object.entries(cases)) {
    it(name, () => {
      assertSameAsOld(entries, { probes: prefixProbes(entries) });
    });
  }

  // A seeded random repository: ~30k paths over a few thousand directories up to 14 deep, with repeated names,
  // duplicate paths, files named like directories and a sprinkling of the odd shapes above.
  function generated(count: number, seed: number): Entry[] {
    let s = seed >>> 0;
    const rand = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (n: number) => Math.floor(rand() * n);
    const words = ['src', 'pkg', 'cmd', 'test', 'docs', 'lib', 'api', 'v1', 'util', 'skills', 'a', 'b', 'staging', 'vendor', 'k8s.io', '.github'];
    const dirs = [''];
    const out: Entry[] = [];
    while (out.length < count) {
      if (dirs.length < 40 || rand() < 0.15) {
        const parent = dirs[pick(dirs.length)];
        if (parent.split('/').length < 14) {
          const name = `${words[pick(words.length)]}${pick(4) || ''}`;
          dirs.push(parent ? `${parent}/${name}` : name);
        }
      }
      const dir = dirs[pick(dirs.length)];
      const file = `${words[pick(words.length)]}_${pick(30)}.go`;
      let path = dir ? `${dir}/${file}` : file;
      const odd = rand();
      if (odd < 0.01) path = `/${path}`;
      else if (odd < 0.013) path = `//${path}`;
      else if (odd < 0.016) path = path.replace('/', '//');
      else if (odd < 0.018) path = `${path}/`;
      else if (odd < 0.019) path = '';
      else if (odd < 0.025 && dir) path = dir;
      out.push({ path, size: odd < 0.5 ? pick(5000) : odd < 0.6 ? null : undefined, sha: odd < 0.8 ? rand().toString(16).slice(2) : null });
    }
    return out;
  }

  const big = generated(30_000, 20261112);
  const missing = ['nope', 'src/nope', 'src/src', 'pkg/pkg1/zzz', '/src', 'src/', 'src//pkg', ' '];
  // filesUnder and dirHasAnyFile read every file per call, so they are checked on a spread of directories
  const scanDirs = (entries: Entry[]) => {
    const dirs = [...new OldTreeIndex(entries).children.keys()];
    return [...dirs.filter((_, i) => i % Math.ceil(dirs.length / 60) === 0), ...missing];
  };

  it('30k 경로 (생성 순서): files, 디렉터리, 모든 디렉터리의 childDirs', () => {
    const { files, dirs } = assertSameAsOld(big, { probes: missing, scanDirs: scanDirs(big) });
    assert.ok(files > 25_000 && dirs > 3_000, `${files} files, ${dirs} dirs`);
  });

  it('30k 경로 (정렬: git ls-tree처럼 형제가 붙어 있음)', () => {
    const sorted = [...big].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    assertSameAsOld(sorted, { probes: missing, scanDirs: scanDirs(sorted) });
  });

  it('30k 경로 (역순: 깊은 경로가 먼저)', () => {
    const reversed = [...big].sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
    assertSameAsOld(reversed, { probes: missing, scanDirs: scanDirs(reversed) });
  });
});

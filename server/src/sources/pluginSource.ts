import { resolveRel, type TreeIndex } from '../discovery/tree.ts';

export type NormalizedSource =
  | { kind: 'relative'; raw: string; path: string }
  | { kind: 'github'; repo: string; ref: string | null; sha: string | null; path: string | null }
  | { kind: 'url'; url: string; repo: string | null; ref: string | null; sha: string | null; path: string | null }
  | { kind: 'git-subdir'; url: string; repo: string | null; ref: string | null; sha: string | null; path: string }
  | { kind: 'npm' | 'archive' | 'command' | 'unknown'; raw: unknown };

const OWNER_REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** owner/repo from a GitHub URL (https, ssh, git@) or `owner/repo` shorthand; null for other hosts. */
export function parseGithubRepo(input: string): string | null {
  const s = input.trim();
  if (OWNER_REPO_RE.test(s)) return s.replace(/\.git$/, '');
  const m =
    s.match(/^(?:https?:\/\/|git\+https:\/\/|ssh:\/\/git@)(?:www\.)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i) ??
    s.match(/^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  return OWNER_REPO_RE.test(repo) ? repo : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const SHA_RE = /^[0-9a-f]{40}$/i;
const sha = (v: unknown): string | null => {
  const s = str(v);
  return s && SHA_RE.test(s) ? s.toLowerCase() : null;
};
const cleanPath = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const r = resolveRel('', s);
  return r === '' ? null : r;
};

/** Normalizes a marketplace entry `source` (Claude Code marketplace reference). */
export function normalizeSource(source: unknown, pluginRoot?: string | null): NormalizedSource {
  if (typeof source === 'string') {
    const raw = source;
    const isBare = !raw.startsWith('./') && raw !== '.' && !raw.startsWith('../');
    const base = isBare && pluginRoot ? (resolveRel('', pluginRoot) ?? '') : '';
    const path = resolveRel(base, raw);
    if (path == null) return { kind: 'unknown', raw: source };
    return { kind: 'relative', raw, path };
  }
  if (!source || typeof source !== 'object') return { kind: 'unknown', raw: source };
  const s = source as Record<string, unknown>;
  switch (s.source) {
    case 'github': {
      const repo = str(s.repo);
      if (!repo || !OWNER_REPO_RE.test(repo)) return { kind: 'unknown', raw: source };
      return { kind: 'github', repo, ref: str(s.ref), sha: sha(s.sha), path: cleanPath(s.path) };
    }
    case 'url': {
      const url = str(s.url);
      if (!url) return { kind: 'unknown', raw: source };
      return { kind: 'url', url, repo: parseGithubRepo(url), ref: str(s.ref), sha: sha(s.sha), path: cleanPath(s.path) };
    }
    case 'git-subdir': {
      const url = str(s.url);
      const path = cleanPath(s.path);
      if (!url || !path) return { kind: 'unknown', raw: source };
      return { kind: 'git-subdir', url, repo: parseGithubRepo(url), ref: str(s.ref), sha: sha(s.sha), path };
    }
    case 'npm':
    case 'archive':
    case 'command':
      return { kind: s.source, raw: source };
    default:
      return { kind: 'unknown', raw: source };
  }
}

/**
 * Plugin root for a relative source once the marketplace tree is known: a `./` path with `metadata.pluginRoot`
 * prefers `<pluginRoot>/<path>` when that folder exists, else the marketplace-root reading.
 */
export function resolveRelativeRoot(raw: string, pluginRoot: string | null, tree: TreeIndex): string | null {
  const isBare = !raw.startsWith('./') && raw !== '.' && !raw.startsWith('../');
  const root = pluginRoot ? resolveRel('', pluginRoot) : null;
  if (isBare) return resolveRel(root ?? '', raw);
  if (root) {
    const withRoot = resolveRel(root, raw);
    if (withRoot != null && withRoot !== root && tree.hasDir(withRoot)) return withRoot;
  }
  return resolveRel('', raw);
}

export type SourceColumns = { repo: string | null; path: string | null; ref: string | null; sha: string | null };

export function sourceColumns(src: NormalizedSource, marketplaceRepo: string): SourceColumns {
  switch (src.kind) {
    case 'relative':
      return { repo: marketplaceRepo, path: src.path || null, ref: null, sha: null };
    case 'github':
      return { repo: src.repo, path: src.path, ref: src.ref, sha: src.sha };
    case 'url':
    case 'git-subdir':
      return { repo: src.repo, path: src.path, ref: src.ref, sha: src.sha };
    default:
      return { repo: null, path: null, ref: null, sha: null };
  }
}

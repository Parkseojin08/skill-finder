import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../util/proc.ts';

export type TreeEntry = { path: string; size: number | null; sha: string | null };

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

// No prompts, no credential helpers (Git Credential Manager would pop a window for missing repos),
// and no lazy blob downloads from the partial clone.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
};
const GIT_BASE = [
  '-c', 'credential.helper=',
  '-c', 'core.askPass=',
  '-c', 'core.longpaths=true',
  '-c', 'http.lowSpeedLimit=1000',
  '-c', 'http.lowSpeedTime=30',
];

const repoUrl = (repo: string) => `https://github.com/${repo}.git`;

function git(args: string[], cwd?: string, timeoutMs = 90_000, raw = false) {
  return run('git', [...GIT_BASE, ...args], { cwd, env: GIT_ENV, timeoutMs, raw });
}

export type RemoteRef = { sha: string; defaultBranch: string | null };

/** Resolves a ref (or HEAD) to a commit SHA with `git ls-remote`; uses no API quota. */
export async function lsRemote(repo: string, ref?: string | null): Promise<RemoteRef | null> {
  if (!REPO_RE.test(repo)) throw new Error(`invalid repo: ${repo}`);
  if (ref && SHA_RE.test(ref)) return { sha: ref.toLowerCase(), defaultBranch: null };
  if (ref && !REF_RE.test(ref)) throw new Error(`invalid ref: ${ref}`);
  const target = ref || 'HEAD';
  const r = await git(['ls-remote', '--symref', repoUrl(repo), target], undefined, 30_000);
  if (r.exitCode !== 0) return null;
  let sha: string | null = null;
  let peeled: string | null = null;
  let defaultBranch: string | null = null;
  for (const line of r.stdout.split('\n')) {
    const sym = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/);
    if (sym) {
      defaultBranch = sym[1];
      continue;
    }
    const m = line.match(/^([0-9a-f]{40})\s+(\S+)$/);
    if (!m) continue;
    if (m[2].endsWith('^{}')) peeled = m[1];
    else if (!sha || m[2] === target || m[2] === `refs/heads/${target}`) sha = m[1];
  }
  const resolved = peeled ?? sha;
  return resolved ? { sha: resolved, defaultBranch } : null;
}

/**
 * Lists every blob path at a commit (or the remote HEAD) using a bare, blob-less, depth-1 fetch.
 * Nothing is checked out. Passing 'HEAD' saves the separate ls-remote round trip.
 */
export async function gitTree(
  repo: string,
  sha: string | 'HEAD',
  workRoot: string,
): Promise<{ sha: string; entries: TreeEntry[]; commitDate: string | null }> {
  if (!REPO_RE.test(repo)) throw new Error(`invalid repo: ${repo}`);
  if (sha !== 'HEAD' && !SHA_RE.test(sha)) throw new Error(`invalid sha: ${sha}`);
  await mkdir(workRoot, { recursive: true });
  // Short folder names: Windows paths over 260 chars break pack writes under deep data dirs.
  const dir = join(workRoot, `${createHash('sha1').update(repo).digest('hex').slice(0, 10)}-${randomBytes(3).toString('hex')}`);
  try {
    const init = await git(['init', '--bare', '-q', dir]);
    if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
    const fetch = await git(['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', repoUrl(repo), sha], dir);
    if (fetch.exitCode !== 0) throw new Error(`git fetch failed: ${fetch.stderr.trim().split('\n')[0] || fetch.exitCode}`);
    if (sha === 'HEAD') {
      const rev = await git(['rev-parse', 'FETCH_HEAD'], dir);
      sha = rev.stdout.trim();
      if (rev.exitCode !== 0 || !SHA_RE.test(sha)) throw new Error('git rev-parse FETCH_HEAD failed');
    }
    const ls = await git(['ls-tree', '-r', '-z', '--full-tree', sha], dir, 90_000, true);
    if (ls.exitCode !== 0) throw new Error(`git ls-tree failed: ${ls.stderr.trim()}`);
    const entries: TreeEntry[] = [];
    for (const rec of ls.stdout.split('\0')) {
      const m = rec.match(/^\d+ (blob|commit|tree) ([0-9a-f]{40})\t(.+)$/s);
      if (m && m[1] === 'blob') entries.push({ path: m[3], size: null, sha: m[2] });
    }
    const log = await git(['log', '-1', '--format=%cI', sha], dir);
    return { sha, entries, commitDate: log.exitCode === 0 ? log.stdout.trim() || null : null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

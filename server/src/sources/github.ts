import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { RepoRow, Store } from '../db/store.ts';
import { fetchText, USER_AGENT } from '../util/http.ts';
import { Semaphore, sleep, TokenBucket } from '../util/limiter.ts';
import { gitTree, lsRemote, type RemoteRef, type TreeEntry } from './gitTree.ts';

export type RepoTree = {
  repo: string;
  sha: string;
  entries: TreeEntry[];
  via: 'api' | 'git';
  commitDate: string | null;
};

export type CodeSearchItem = { repo: string; path: string; htmlUrl: string };

export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export class GitHub {
  private readonly store: Store;
  private readonly config: AppConfig;
  private readonly workRoot: string;
  private readonly codeSearch = new TokenBucket(9);
  private readonly search = new TokenBucket(28);
  private core: { remaining: number | null; reset: number | null } = { remaining: null, reset: null };
  private readonly treeCache = new Map<string, Promise<RepoTree>>();
  private readonly refCache = new Map<string, { at: number; value: Promise<RemoteRef | null> }>();
  /** raw.githubusercontent.com answers bursts of hundreds of parallel downloads with 429s; keep it civil. */
  private readonly rawSlots = new Semaphore(24);
  private readonly metaInFlight = new Map<string, Promise<RepoRow | null>>();

  constructor(store: Store, config: AppConfig) {
    this.store = store;
    this.config = config;
    this.workRoot = join(config.dataDir, 'tmp', 'git');
  }

  get hasToken(): boolean {
    return !!this.config.githubToken;
  }

  /** Whether the core REST quota allows a call (keeps a small reserve). */
  coreAvailable(reserve = 0): boolean {
    if (this.core.remaining == null) return true;
    if (this.core.reset != null && Date.now() / 1000 > this.core.reset) return true;
    return this.core.remaining > reserve;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
    if (this.config.githubToken) h.Authorization = `Bearer ${this.config.githubToken}`;
    return h;
  }

  private async api(path: string, opts: { etag?: string | null; bucket?: TokenBucket; accept?: string } = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (opts.bucket) await opts.bucket.take();
      const res = await fetch(API + path, {
        headers: this.headers({ ...(opts.etag ? { 'If-None-Match': opts.etag } : {}), ...(opts.accept ? { Accept: opts.accept } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      const resource = res.headers.get('x-ratelimit-resource');
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (resource === 'core' && remaining != null) {
        this.core = { remaining: Number(remaining), reset: Number(res.headers.get('x-ratelimit-reset')) || null };
      }
      if (res.status === 403 || res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter > 0 && retryAfter <= 60 && attempt === 0) {
          await res.body?.cancel().catch(() => {});
          await sleep(retryAfter * 1000);
          continue;
        }
        if (remaining === '0') {
          await res.body?.cancel().catch(() => {});
          throw new GitHubError('GitHub API 한도 초과', res.status);
        }
      }
      return res;
    }
    throw new GitHubError('GitHub API 재시도 실패', 429);
  }

  /**
   * Commit SHA for a ref (or default branch), cached for 10 minutes: the commits API with a token
   * (~0.4s), otherwise `git ls-remote` (a process spawn, ~0.6–1s on Windows).
   */
  resolveRef(repo: string, ref?: string | null): Promise<RemoteRef | null> {
    const key = `${repo.toLowerCase()}@${ref ?? 'HEAD'}`;
    const hit = this.refCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    const value = this.shaViaApi(repo, ref ?? 'HEAD')
      .then((sha) => (sha ? { sha, defaultBranch: null } : lsRemote(repo, ref)))
      .catch(() => lsRemote(repo, ref))
      .catch(() => null);
    this.refCache.set(key, { at: Date.now(), value });
    return value;
  }

  private async shaViaApi(repo: string, ref: string): Promise<string | null> {
    if (!this.hasToken || !this.coreAvailable(50) || !REPO_RE.test(repo) || !/^[\w./-]{1,200}$/.test(ref)) return null;
    const res = await this.api(`/repos/${repo}/commits/${ref.split('/').map(encodeURIComponent).join('/')}`, { accept: 'application/vnd.github.sha' });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const sha = (await res.text()).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /** Full recursive tree at a commit: tree API with a token and spare quota, otherwise a git partial fetch. */
  getTree(repo: string, sha: string): Promise<RepoTree> {
    const key = `${repo.toLowerCase()}@${sha}`;
    let p = this.treeCache.get(key);
    if (!p) {
      p = this.loadTree(repo, sha);
      p.catch(() => this.treeCache.delete(key));
      this.treeCache.set(key, p);
      if (this.treeCache.size > 200) this.treeCache.delete(this.treeCache.keys().next().value!);
    }
    return p;
  }

  /**
   * Tree at the default branch head. With a token the HEAD commit SHA and the HEAD tree are fetched in
   * parallel (one round trip instead of two); without one it is a single git fetch.
   */
  async getTreeAtHead(repo: string): Promise<RepoTree> {
    if (!REPO_RE.test(repo)) throw new Error(`invalid repo: ${repo}`);
    if (this.hasToken && this.coreAvailable(50)) {
      const [ref, entries] = await Promise.all([this.resolveRef(repo, null), this.treeViaApi(repo, 'HEAD').catch(() => null)]);
      if (!ref) throw new Error(`저장소를 찾을 수 없습니다: ${repo}`);
      const key = `${repo.toLowerCase()}@${ref.sha}`;
      if (entries && !this.treeCache.has(key)) {
        this.treeCache.set(key, Promise.resolve({ repo, sha: ref.sha, entries, via: 'api', commitDate: this.store.getRepo(repo)?.pushed_at ?? null }));
      }
      return this.getTree(repo, ref.sha);
    }
    const { sha, entries, commitDate } = await gitTree(repo, 'HEAD', this.workRoot);
    const tree: RepoTree = { repo, sha, entries, via: 'git', commitDate };
    this.treeCache.set(`${repo.toLowerCase()}@${sha}`, Promise.resolve(tree));
    return tree;
  }

  /** Blob entries from the recursive tree API; null when truncated or the quota is short (caller falls back to git). */
  private async treeViaApi(repo: string, ref: string): Promise<TreeEntry[] | null> {
    if (!this.hasToken || !this.coreAvailable(50)) return null;
    try {
      const res = await this.api(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        if (res.status === 404 || res.status === 409 || res.status === 422) throw new GitHubError(`tree ${res.status}`, res.status);
        return null;
      }
      const body = (await res.json()) as { truncated?: boolean; tree: Array<{ path: string; type: string; size?: number; sha?: string }> };
      if (body.truncated) return null;
      return body.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size ?? null, sha: e.sha ?? null }));
    } catch (err) {
      if (err instanceof GitHubError && err.status !== 403 && err.status !== 429) throw err;
      return null;
    }
  }

  private async loadTree(repo: string, sha: string): Promise<RepoTree> {
    if (!REPO_RE.test(repo)) throw new Error(`invalid repo: ${repo}`);
    const entries = await this.treeViaApi(repo, sha);
    if (entries) return { repo, sha, entries, via: 'api', commitDate: this.store.getRepo(repo)?.pushed_at ?? null };
    const git = await gitTree(repo, sha, this.workRoot);
    return { repo, sha, entries: git.entries, via: 'git', commitDate: git.commitDate };
  }

  /**
   * One file from raw.githubusercontent.com. Shares a concurrency cap with every other raw download and
   * retries throttling (429), server errors and network failures, so a busy moment is not mistaken for
   * a missing file. A real 404 comes back as `status: 404, text: null`.
   */
  async getRawText(repo: string, ref: string, path: string, maxBytes = 512 * 1024) {
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.rawSlots.run(() => fetchText(url, { maxBytes, timeoutMs: 15_000 }));
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        return res;
      } catch (err) {
        if (attempt >= 2) throw err;
        await sleep(400 * (attempt + 1));
      }
    }
  }

  /** Repository metadata cached for 24h; returns cached (possibly stale) data when the quota is short. */
  getRepoMeta(repo: string): Promise<RepoRow | null> {
    // Several lookups in one search often ask for the same repo at once; share the request.
    const key = repo.toLowerCase();
    let p = this.metaInFlight.get(key);
    if (!p) {
      p = this.loadRepoMeta(repo).finally(() => this.metaInFlight.delete(key));
      this.metaInFlight.set(key, p);
    }
    return p;
  }

  private async loadRepoMeta(repo: string): Promise<RepoRow | null> {
    const cached = this.store.getRepo(repo);
    if (cached?.fetched_at && Date.now() - Date.parse(cached.fetched_at) < DAY_MS) return cached;
    if (!this.coreAvailable(this.hasToken ? 100 : 10)) return cached ?? null;
    try {
      const res = await this.api(`/repos/${repo}`, { etag: cached?.etag });
      if (res.status === 304 && cached) {
        this.store.touchRepo(cached.full_name);
        return { ...cached, fetched_at: new Date().toISOString() };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return cached ?? null;
      }
      const j = (await res.json()) as {
        full_name: string;
        stargazers_count: number;
        pushed_at: string | null;
        archived: boolean;
        fork: boolean;
        license: { spdx_id?: string | null } | null;
        default_branch: string;
      };
      const row: RepoRow = {
        full_name: cached?.full_name ?? repo,
        stars: j.stargazers_count,
        pushed_at: j.pushed_at,
        archived: j.archived ? 1 : 0,
        fork: j.fork ? 1 : 0,
        license: j.license?.spdx_id ?? null,
        default_branch: j.default_branch,
        etag: res.headers.get('etag'),
        fetched_at: new Date().toISOString(),
      };
      this.store.upsertRepo(row);
      return row;
    } catch {
      return cached ?? null;
    }
  }

  /** `filename:SKILL.md` code search. Requires a token (10/min, we use 9). */
  async searchSkillFiles(keywords: string[], perPage = 50): Promise<CodeSearchItem[]> {
    if (!this.hasToken) throw new GitHubError('GitHub 토큰이 없어 코드 검색을 건너뜁니다', 401);
    const terms = keywords
      .map((k) => k.replace(/[^\p{L}\p{N}\s_-]/gu, ' ').trim())
      .filter(Boolean)
      .map((k) => (/\s/.test(k) ? `"${k}"` : k));
    if (terms.length === 0) return [];
    const q = ['filename:SKILL.md', ...terms].join(' ');
    const res = await this.api(`/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}`, { bucket: this.codeSearch });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(`GitHub 코드 검색 실패 (${res.status}) ${text.slice(0, 120)}`, res.status);
    }
    const body = (await res.json()) as {
      items: Array<{ path: string; html_url: string; repository: { full_name: string; fork?: boolean } }>;
    };
    return body.items
      .filter((i) => i.path === 'SKILL.md' || i.path.endsWith('/SKILL.md'))
      .map((i) => ({ repo: i.repository.full_name, path: i.path, htmlUrl: i.html_url }));
  }

  /** Non-code search endpoints share the 30/min bucket (we use 28). */
  get searchBucket(): TokenBucket {
    return this.search;
  }
}

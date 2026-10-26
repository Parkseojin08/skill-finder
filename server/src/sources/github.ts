import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { RepoRow, Store } from '../db/store.ts';
import { fetchText, USER_AGENT } from '../util/http.ts';
import { sleep, TokenBucket } from '../util/limiter.ts';
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

  private async api(path: string, opts: { etag?: string | null; bucket?: TokenBucket } = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (opts.bucket) await opts.bucket.take();
      const res = await fetch(API + path, {
        headers: this.headers(opts.etag ? { 'If-None-Match': opts.etag } : {}),
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

  /** Commit SHA for a ref (or default branch) via `git ls-remote`, cached for 10 minutes. */
  resolveRef(repo: string, ref?: string | null): Promise<RemoteRef | null> {
    const key = `${repo.toLowerCase()}@${ref ?? 'HEAD'}`;
    const hit = this.refCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    const value = lsRemote(repo, ref).catch(() => null);
    this.refCache.set(key, { at: Date.now(), value });
    return value;
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

  /** Tree at the default branch head. Without a token this is a single git fetch (no ls-remote first). */
  async getTreeAtHead(repo: string): Promise<RepoTree> {
    if (this.hasToken && this.coreAvailable(50)) {
      const ref = await this.resolveRef(repo, null);
      if (!ref) throw new Error(`저장소를 찾을 수 없습니다: ${repo}`);
      return this.getTree(repo, ref.sha);
    }
    if (!REPO_RE.test(repo)) throw new Error(`invalid repo: ${repo}`);
    const { sha, entries, commitDate } = await gitTree(repo, 'HEAD', this.workRoot);
    const tree: RepoTree = { repo, sha, entries, via: 'git', commitDate };
    this.treeCache.set(`${repo.toLowerCase()}@${sha}`, Promise.resolve(tree));
    return tree;
  }

  private async loadTree(repo: string, sha: string): Promise<RepoTree> {
    if (!REPO_RE.test(repo)) throw new Error(`invalid repo: ${repo}`);
    if (this.hasToken && this.coreAvailable(50)) {
      try {
        const res = await this.api(`/repos/${repo}/git/trees/${sha}?recursive=1`);
        if (res.ok) {
          const body = (await res.json()) as {
            truncated?: boolean;
            tree: Array<{ path: string; type: string; size?: number; sha?: string }>;
          };
          if (!body.truncated) {
            const entries = body.tree
              .filter((e) => e.type === 'blob')
              .map((e) => ({ path: e.path, size: e.size ?? null, sha: e.sha ?? null }));
            const commitDate = this.store.getRepo(repo)?.pushed_at ?? null;
            return { repo, sha, entries, via: 'api', commitDate };
          }
        } else {
          await res.body?.cancel().catch(() => {});
          if (res.status === 404 || res.status === 409 || res.status === 422) throw new GitHubError(`tree ${res.status}`, res.status);
        }
      } catch (err) {
        if (err instanceof GitHubError && err.status !== 403 && err.status !== 429) throw err;
      }
    }
    const { entries, commitDate } = await gitTree(repo, sha, this.workRoot);
    return { repo, sha, entries, via: 'git', commitDate };
  }

  async getRawText(repo: string, ref: string, path: string, maxBytes = 512 * 1024) {
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
    return fetchText(url, { maxBytes, timeoutMs: 15_000 });
  }

  /** Repository metadata cached for 24h; returns cached (possibly stale) data when the quota is short. */
  async getRepoMeta(repo: string): Promise<RepoRow | null> {
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

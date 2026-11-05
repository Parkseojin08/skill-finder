import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { RepoRow, Store } from '../db/store.ts';
import { fetchText, USER_AGENT } from '../util/http.ts';
import { SizedCache } from '../util/sizedCache.ts';
import { sanitizeLine } from '../util/sanitize.ts';
import { RateLimitWait, Semaphore, sleep, TokenBucket } from '../util/limiter.ts';
import { gitTree, lsRemote, type RemoteRef, type TreeEntry } from './gitTree.ts';

/** Tree entries the tree cache may hold (perf debate 1-3); kubernetes, the largest seen, has about 42,000. */
export const TREE_CACHE_ENTRIES = 50_000;
const REF_TTL_MS = 10 * 60 * 1000;

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
/** Code and repository search answers are kept this long (the `ghcode:`/`ghrepo:` cache keys). */
const SEARCH_CACHE_MS = DAY_MS;

export type RepoSearchHit = { repo: string; stars: number; description: string | null; topics: string[] };
/** Repos per GraphQL metadata call (the alias form GitHub allows comfortably). */
export const GRAPHQL_BATCH = 100;
type GraphRepo = {
  stargazerCount?: unknown;
  pushedAt?: unknown;
  isArchived?: unknown;
  isFork?: unknown;
  licenseInfo?: { spdxId?: unknown } | null;
  defaultBranchRef?: { name?: unknown } | null;
  nameWithOwner?: unknown;
};
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * P9: GitHub answers for a renamed or transferred repo under its old name with the new one's data; its name then
 * differs from the one asked for (case aside, GitHub names ignore it). The new name, or null when it did not move.
 */
export function movedName(asked: string, answered: unknown): string | null {
  if (typeof answered !== 'string' || !REPO_RE.test(answered)) return null;
  return answered.toLowerCase() === asked.toLowerCase() ? null : answered;
}
/** A relative path inside a repo: no leading slash, backslash, empty, `.` or `..` segment, control character. */
function isSafeRepoPath(path: string): boolean {
  return path.length <= 1024 && !/[\\\x00-\x1f]/.test(path) && path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Raw files (SKILL.md included) are read up to this many bytes; the rest is cut off. */
export const RAW_MAX_BYTES = 512 * 1024;
/** First wait after a raw download got 429, doubled on each retry. */
const RAW_THROTTLE_WAIT_MS = 1000;

export class GitHub {
  private readonly store: Store;
  private readonly config: AppConfig;
  private readonly workRoot: string;
  // GitHub allows 10 code searches a minute; a burst of 5 keeps a refilling minute under that
  private readonly codeSearch = new TokenBucket(9, 5);
  private readonly searchWithToken = new TokenBucket(28);
  private readonly searchNoToken = new TokenBucket(9, 5); // unauthenticated search is 10/min
  private core: { remaining: number | null; reset: number | null } = { remaining: null, reset: null };
  /** Last seen remaining/reset per rate-limit resource (core, search, code_search, graphql). */
  private readonly limits = new Map<string, { remaining: number; reset: number }>();
  private readonly searchInFlight = new Map<string, Promise<unknown>>();
  /** Bounded by tree entries, not count (perf debate 1-3): ~175 bytes each, so about 9MB at most. */
  private readonly treeCache = new SizedCache<RepoTree>({ maxSize: TREE_CACHE_ENTRIES, ttlMs: 30 * 60 * 1000, sizeOf: (t) => t.entries.length });
  private readonly refCache = new Map<string, { at: number; value: Promise<RemoteRef | null> }>();
  /** raw.githubusercontent.com answers bursts of hundreds of parallel downloads with 429s; keep it civil. */
  private readonly rawSlots = new Semaphore(24);
  /** raw.githubusercontent.com said 429: no download starts before this time. */
  private rawPausedUntil = 0;
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

  private get search(): TokenBucket {
    return this.hasToken ? this.searchWithToken : this.searchNoToken;
  }

  /**
   * Throws at once while GitHub has said this resource's quota is used up (until its reset time), so a search
   * does not wait for or spend a call on a certain 403.
   */
  private checkLimit(resource: string): void {
    const l = this.limits.get(resource);
    if (l && l.remaining <= 0 && Date.now() / 1000 < l.reset) {
      const label = ({ code_search: '코드 검색', search: '저장소 검색', graphql: 'GraphQL', core: 'API' } as Record<string, string>)[resource] ?? resource;
      throw new GitHubError(`GitHub ${label} 한도 소진 (${Math.ceil(l.reset - Date.now() / 1000)}초 뒤 다시 가능)`, 429);
    }
  }

  /**
   * `resource` + `maxWaitMs`: search-path calls. They check the remembered quota first, give up instead of
   * queuing past `maxWaitMs`, and never sleep on retry-after (the search would have moved on by then).
   */
  private async api(
    path: string,
    opts: { etag?: string | null; bucket?: TokenBucket; accept?: string; resource?: string; maxWaitMs?: number } = {},
  ): Promise<Response> {
    if (opts.resource) this.checkLimit(opts.resource);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (opts.bucket) {
        try {
          await opts.bucket.take({ maxWaitMs: opts.maxWaitMs });
        } catch (err) {
          if (err instanceof RateLimitWait) throw new GitHubError(`GitHub 호출 한도 대기 (${err.message})`, 429);
          throw err;
        }
      }
      const res = await fetch(API + path, {
        headers: this.headers({ ...(opts.etag ? { 'If-None-Match': opts.etag } : {}), ...(opts.accept ? { Accept: opts.accept } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      const resource = res.headers.get('x-ratelimit-resource');
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (resource === 'core' && remaining != null) {
        this.core = { remaining: Number(remaining), reset: Number(res.headers.get('x-ratelimit-reset')) || null };
      }
      if (resource && remaining != null) {
        this.limits.set(resource, { remaining: Number(remaining), reset: Number(res.headers.get('x-ratelimit-reset')) || 0 });
      }
      if (res.status === 403 || res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter > 0 && opts.resource && opts.maxWaitMs != null) {
          // secondary limit on the search path: remember it as a closed circuit instead of sleeping
          // (background collection has time, so it still sleeps and retries below)
          this.limits.set(opts.resource, { remaining: 0, reset: Date.now() / 1000 + Math.min(retryAfter, 600) });
          await res.body?.cancel().catch(() => {});
          throw new GitHubError('GitHub API 한도 초과', res.status);
        }
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
    if (hit && Date.now() - hit.at < REF_TTL_MS) return hit.value;
    const value = this.shaViaApi(repo, ref ?? 'HEAD')
      .then((sha) => (sha ? { sha, defaultBranch: null } : lsRemote(repo, ref)))
      .catch(() => lsRemote(repo, ref))
      .catch(() => null);
    this.refCache.set(key, { at: Date.now(), value });
    // expired commits are dropped, not only skipped (they used to stay for the life of the app)
    if (this.refCache.size > 200) for (const [k, v] of this.refCache) if (Date.now() - v.at >= REF_TTL_MS) this.refCache.delete(k);
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
      this.treeCache.set(key, p);
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
      if (entries && !this.treeCache.get(key)) {
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
  async getRawText(repo: string, ref: string, path: string, maxBytes = RAW_MAX_BYTES) {
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.rawSlots.run(async () => {
          const pause = this.rawPausedUntil - Date.now();
          if (pause > 0) await sleep(pause);
          return fetchText(url, { maxBytes, timeoutMs: 15_000 });
        });
        if (res.status === 429 && attempt < 3) {
          // Throttled: every download waits (1, 2, 4 s), not only this one. Retrying after 0.4 s still failed
          // while a repo with hundreds of skills was read (2026-11-03).
          this.rawPausedUntil = Math.max(this.rawPausedUntil, Date.now() + RAW_THROTTLE_WAIT_MS * 2 ** attempt);
          continue;
        }
        if (res.status >= 500 && attempt < 2) {
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

  /** true / false when GitHub says the repo exists or not (404: deleted or private); null when unknown. */
  async repoExists(repo: string): Promise<boolean | null> {
    if (!REPO_RE.test(repo)) return false;
    if (this.hasToken && this.coreAvailable(10)) {
      try {
        const res = await this.api(`/repos/${repo}`);
        await res.body?.cancel().catch(() => {});
        if (res.ok) return true;
        if (res.status === 404) return false;
      } catch {
        // fall through to git
      }
    }
    // ls-remote fails the same way for a missing repo and a network problem, so only "exists" is certain.
    return (await lsRemote(repo, null).catch(() => null)) != null ? true : null;
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
        // A deleted or private repo is stored as "stars unknown" for a day, as the GraphQL path does for
        // NOT_FOUND, instead of being asked again in every search (perf debate 1-2).
        if (res.status === 404 && cached?.stars == null) {
          const row: RepoRow = { full_name: cached?.full_name ?? repo, stars: null, pushed_at: null, archived: null, fork: null, license: null, default_branch: null, etag: null, fetched_at: new Date().toISOString() };
          this.store.upsertRepo(row);
          return row;
        }
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
      row.moved_to = movedName(repo, j.full_name);
      this.store.setRepoMovedTo(row.full_name, row.moved_to);
      return row;
    } catch {
      return cached ?? null;
    }
  }

  /**
   * Star counts and metadata for up to GRAPHQL_BATCH repos in one GraphQL call (~1 point of the 5,000/hour
   * budget, against one REST call each). Repos GitHub reports as not found are stored with no stars and no
   * default branch, so they are not asked about again until the next refresh. Returns how many were stored.
   */
  async refreshRepoMeta(repos: string[]): Promise<number> {
    if (!this.hasToken) return 0;
    this.checkLimit('graphql');
    const list = repos.filter((r) => REPO_RE.test(r)).slice(0, GRAPHQL_BATCH);
    if (list.length === 0) return 0;
    const vars: Record<string, string> = {};
    const defs: string[] = [];
    const fields: string[] = [];
    list.forEach((r, i) => {
      const [owner, name] = r.split('/');
      vars[`o${i}`] = owner;
      vars[`n${i}`] = name;
      defs.push(`$o${i}: String!, $n${i}: String!`);
      fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { stargazerCount pushedAt isArchived isFork licenseInfo { spdxId } defaultBranchRef { name } nameWithOwner }`);
    });
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query: `query(${defs.join(', ')}) { ${fields.join(' ')} }`, variables: vars }),
      signal: AbortSignal.timeout(30_000),
    });
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining != null) this.limits.set('graphql', { remaining: Number(remaining), reset: Number(res.headers.get('x-ratelimit-reset')) || 0 });
    if (!res.ok) throw new GitHubError(`GitHub GraphQL 실패 (${res.status})`, res.status);
    const body = (await res.json()) as {
      data?: Record<string, GraphRepo | null> | null;
      errors?: Array<{ type?: string; path?: unknown[] }>;
    };
    if ((body.errors ?? []).some((e) => e.type === 'RATE_LIMITED')) throw new GitHubError('GitHub GraphQL 한도 초과', 429);
    const notFound = new Set((body.errors ?? []).filter((e) => e.type === 'NOT_FOUND').map((e) => String(e.path?.[0] ?? '')));
    const at = new Date().toISOString();
    let stored = 0;
    list.forEach((repo, i) => {
      const g = body.data?.[`r${i}`];
      const cached = this.store.getRepo(repo);
      const base = { full_name: cached?.full_name ?? repo, etag: cached?.etag ?? null, fetched_at: at };
      if (g && typeof g.stargazerCount === 'number') {
        this.store.upsertRepo({
          ...base,
          stars: g.stargazerCount,
          pushed_at: typeof g.pushedAt === 'string' ? g.pushedAt : null,
          archived: g.isArchived ? 1 : 0,
          fork: g.isFork ? 1 : 0,
          license: typeof g.licenseInfo?.spdxId === 'string' ? g.licenseInfo.spdxId : null,
          default_branch: typeof g.defaultBranchRef?.name === 'string' ? g.defaultBranchRef.name : null,
        });
        this.store.setRepoMovedTo(base.full_name, movedName(repo, g.nameWithOwner));
        stored++;
      } else if (notFound.has(`r${i}`)) {
        if (cached?.stars != null) {
          // known before (the token may just not see it now): keep what we had, ask again next refresh
          this.store.touchRepo(cached.full_name);
        } else {
          // deleted or private and never seen: remembered as unknown ("모르면 숨김") instead of asked every search
          this.store.upsertRepo({ ...base, stars: null, pushed_at: null, archived: null, fork: null, license: null, default_branch: null });
        }
        stored++;
      }
      // any other error (a timeout, a permission problem) leaves the row as it was
    });
    return stored;
  }

  /**
   * One answer per key for SEARCH_CACHE_MS and one request in flight per key: the same keywords from the
   * "별 미만 보기"/"위험 모두 보기" re-search, a repeat search, or after a sync no longer spend the 10/min
   * code-search quota. Kept apart from the result cache (`search:`), which syncs clear.
   */
  private cachedSearch<T>(key: string, load: () => Promise<{ value: T; complete: boolean }>): Promise<T> {
    const cached = this.store.getCached(key, SEARCH_CACHE_MS) as T | undefined;
    if (cached !== undefined) return Promise.resolve(cached);
    let p = this.searchInFlight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load()
        .then(({ value, complete }) => {
          if (complete) this.store.putCached(key, value);
          return value;
        })
        .finally(() => this.searchInFlight.delete(key));
      this.searchInFlight.set(key, p);
    }
    return p;
  }

  /** `filename:SKILL.md` code search. Requires a token (10/min, we use 9). */
  async searchSkillFiles(keywords: string[], perPage = 50, opts: { maxWaitMs?: number } = {}): Promise<CodeSearchItem[]> {
    if (!this.hasToken) throw new GitHubError('GitHub 토큰이 없어 코드 검색을 건너뜁니다', 401);
    const terms = keywords
      .map((k) => k.replace(/[^\p{L}\p{N}\s_-]/gu, ' ').trim())
      .filter(Boolean)
      .map((k) => (/\s/.test(k) ? `"${k}"` : k));
    if (terms.length === 0) return [];
    const q = ['filename:SKILL.md', ...terms].join(' ');
    return this.cachedSearch(`ghcode:v1:${perPage}:${q.toLowerCase()}`, async () => {
      const res = await this.api(`/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}`, {
        bucket: this.codeSearch,
        resource: 'code_search',
        maxWaitMs: opts.maxWaitMs,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new GitHubError(`GitHub 코드 검색 실패 (${res.status}) ${text.slice(0, 120)}`, res.status);
      }
      const body = (await res.json()) as {
        incomplete_results?: boolean;
        items: Array<{ path: string; html_url: string; repository: { full_name: string; fork?: boolean } }>;
      };
      // The repo and path go into raw URLs and skill ids later, so only well-formed ones are kept.
      const value = body.items
        .filter((i) => i.path === 'SKILL.md' || i.path.endsWith('/SKILL.md'))
        .filter((i) => REPO_RE.test(i.repository?.full_name ?? '') && isSafeRepoPath(i.path))
        .map((i) => ({ repo: i.repository.full_name, path: i.path, htmlUrl: i.html_url }));
      // a search GitHub cut short is used once, not kept
      return { value, complete: body.incomplete_results !== true };
    });
  }

  /**
   * Repository search (unlike code search it supports `stars:>=N`). Up to 100 per query, most-starred first;
   * star counts are stored so later filters do not need another call.
   */
  /** `fresh`: ask GitHub even if a cached answer exists (popular-repo collection looks for new repos). */
  async searchRepos(q: string, perPage = 100, opts: { maxWaitMs?: number; fresh?: boolean } = {}): Promise<RepoSearchHit[]> {
    if (opts.fresh) return (await this.loadRepos(q, perPage, opts.maxWaitMs)).value;
    return this.cachedSearch(`ghrepo:v1:${this.hasToken ? 't' : 'n'}:${perPage}:${q.toLowerCase()}`, () => this.loadRepos(q, perPage, opts.maxWaitMs));
  }

  private async loadRepos(q: string, perPage: number, maxWaitMs?: number): Promise<{ value: RepoSearchHit[]; complete: boolean }> {
    const res = await this.api(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`, {
      bucket: this.search,
      resource: 'search',
      maxWaitMs,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(`GitHub 저장소 검색 실패 (${res.status}) ${text.slice(0, 120)}`, res.status);
    }
    const body = (await res.json()) as {
      incomplete_results?: boolean;
      items: Array<{
        full_name: string;
        stargazers_count: number;
        description: string | null;
        topics?: string[];
        pushed_at: string | null;
        archived: boolean;
        fork: boolean;
        license: { spdx_id?: string | null } | null;
        default_branch: string;
      }>;
    };
    const out: RepoSearchHit[] = [];
    for (const i of body.items) {
      if (!REPO_RE.test(i.full_name) || i.archived) continue;
      const cached = this.store.getRepo(i.full_name);
      this.store.upsertRepo({
        full_name: cached?.full_name ?? i.full_name,
        stars: i.stargazers_count,
        pushed_at: i.pushed_at,
        archived: i.archived ? 1 : 0,
        fork: i.fork ? 1 : 0,
        license: i.license?.spdx_id ?? null,
        default_branch: i.default_branch,
        etag: cached?.etag ?? null,
        fetched_at: new Date().toISOString(),
      });
      out.push({
        repo: i.full_name,
        stars: i.stargazers_count,
        description: i.description ? sanitizeLine(i.description).slice(0, 300) : null,
        topics: (i.topics ?? []).filter((t) => /^[a-z0-9-]{1,50}$/.test(t)).slice(0, 20),
      });
    }
    return { value: out, complete: body.incomplete_results !== true };
  }
}

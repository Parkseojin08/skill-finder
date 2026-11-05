// P9 (feature review 2026-11-04): a renamed or transferred repo keeps the name GitHub answers with in repos.moved_to.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createContext } from '../src/bootstrap.ts';
import { movedName } from '../src/sources/github.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctxWithToken = () => createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-moved-')), githubToken: 'test-token' }, ':memory:');
const meta = (nameWithOwner?: string) => ({ stargazerCount: 10, pushedAt: null, isArchived: false, isFork: false, licenseInfo: null, defaultBranchRef: { name: 'main' }, ...(nameWithOwner ? { nameWithOwner } : {}) });

describe('저장소 이름 바뀜·이전 (P9)', () => {
  it('대소문자만 다르면 옮긴 것이 아니다', () => {
    assert.equal(movedName('Old/Name', 'old/name'), null);
    assert.equal(movedName('old/name', 'new-owner/name'), 'new-owner/name');
    assert.equal(movedName('old/name', 'not a repo'), null);
    assert.equal(movedName('old/name', undefined), null);
  });

  it('GraphQL의 nameWithOwner가 다르면 moved_to에 두고, 같아지면 지운다', async () => {
    const ctx = ctxWithToken();
    const queries: string[] = [];
    let answer: Record<string, unknown> = { r0: meta('new-owner/new-name'), r1: meta('Same/Repo'), r2: meta() };
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).query);
      return new Response(JSON.stringify({ data: answer }), { status: 200 });
    }) as typeof fetch;
    assert.equal(await ctx.github.refreshRepoMeta(['old/name', 'same/repo', 'plain/repo']), 3);
    assert.match(queries[0], /nameWithOwner/);
    assert.equal(ctx.store.getRepo('old/name')!.moved_to, 'new-owner/new-name');
    assert.equal(ctx.store.getRepo('same/repo')!.moved_to, null);
    assert.equal(ctx.store.getRepo('plain/repo')!.moved_to, null);

    answer = { r0: meta('old/name') };
    await ctx.github.refreshRepoMeta(['old/name']);
    assert.equal(ctx.store.getRepo('old/name')!.moved_to, null);
  });

  it('REST 응답의 full_name이 다르면 moved_to에 둔다', async () => {
    const ctx = ctxWithToken();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ full_name: 'moved/there', stargazers_count: 5, pushed_at: null, archived: false, fork: false, license: null, default_branch: 'main' }), {
        status: 200,
      })) as typeof fetch;
    const row = await ctx.github.getRepoMeta('was/here');
    assert.equal(row?.moved_to, 'moved/there');
    assert.equal(row?.full_name, 'was/here', '행은 요청한 이름 그대로');
    assert.equal(ctx.store.getRepo('was/here')!.moved_to, 'moved/there');
    assert.equal(ctx.store.getRepo('was/here')!.stars, 5);
  });

  it('다른 갱신(upsertRepo)은 moved_to를 지우지 않는다', () => {
    const ctx = ctxWithToken();
    const row = { full_name: 'a/b', stars: 1, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: null };
    ctx.store.upsertRepo(row);
    ctx.store.setRepoMovedTo('a/b', 'c/d');
    ctx.store.upsertRepo({ ...row, stars: 2 });
    assert.equal(ctx.store.getRepo('a/b')!.moved_to, 'c/d');
  });
});

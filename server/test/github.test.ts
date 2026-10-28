import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createContext } from '../src/bootstrap.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { searchSkillsSh } from '../src/sources/skillsSh.ts';
import { RateLimitWait, TokenBucket } from '../src/util/limiter.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function ctxWithToken() {
  return createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-gh-')), githubToken: 'test-token' }, ':memory:');
}

/** A fake GitHub that answers code search with one SKILL.md and counts the calls. */
function fakeCodeSearch(opts: { incomplete?: boolean; remaining?: string; status?: number } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const body = { incomplete_results: opts.incomplete ?? false, items: [{ path: 'skills/x/SKILL.md', html_url: 'https://github.com/a/b', repository: { full_name: 'a/b' } }] };
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { 'x-ratelimit-resource': 'code_search', 'x-ratelimit-remaining': opts.remaining ?? '9', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) },
    });
  }) as typeof fetch;
  return calls;
}

describe('저장소 별 정보 묶음 갱신 (2단계)', () => {
  it('한 번의 GraphQL 호출로 저장하고, 없는 저장소는 "모름"으로 기억하고, 다른 오류는 건드리지 않는다', async () => {
    const ctx = ctxWithToken();
    ctx.store.upsertRepo({ full_name: 'Big/Skills', stars: 10, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: 'e1', fetched_at: '2026-01-01T00:00:00.000Z' });
    const bodies: Array<{ query: string; variables: Record<string, string> }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          data: { r0: { stargazerCount: 42000, pushedAt: '2026-10-01T00:00:00Z', isArchived: false, isFork: false, licenseInfo: { spdxId: 'MIT' }, defaultBranchRef: { name: 'main' } }, r1: null, r2: null, r3: null },
          errors: [{ type: 'NOT_FOUND', path: ['r1'] }, { type: 'FORBIDDEN', path: ['r2'] }, { type: 'NOT_FOUND', path: ['r3'] }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    ctx.store.upsertRepo({ full_name: 'known/repo', stars: 7000, pushed_at: null, archived: 0, fork: 0, license: 'MIT', default_branch: 'main', etag: null, fetched_at: '2026-01-01T00:00:00.000Z' });
    const stored = await ctx.github.refreshRepoMeta(['big/skills', 'gone/repo', 'secret/repo', 'known/repo', 'not a repo']);
    assert.equal(bodies.length, 1);
    assert.ok(!bodies[0].query.includes('big'), '저장소 이름은 쿼리 문자열이 아니라 변수로 넘김');
    assert.equal(bodies[0].variables.o0, 'big');
    assert.equal(stored, 3);
    assert.equal(ctx.store.getRepo('known/repo')!.stars, 7000, '알던 별 수는 NOT_FOUND로 지우지 않음');
    const big = ctx.store.getRepo('big/skills')!;
    assert.equal(big.full_name, 'Big/Skills', '기존 행 이름 유지');
    assert.equal(big.stars, 42000);
    assert.equal(big.etag, 'e1');
    const gone = ctx.store.getRepo('gone/repo')!;
    assert.equal(gone.stars, null);
    assert.equal(gone.default_branch, null);
    assert.equal(ctx.store.getRepo('secret/repo'), undefined);
  });

  it('갱신할 저장소 목록은 스킬이 가리키는데 정보가 없거나 오래된 저장소다', () => {
    const ctx = ctxWithToken();
    const add = (repo: string) => {
      const row = buildSkillRow({ repo, sha: 'a'.repeat(40), dirPath: 's', raw: '---\nname: s\ndescription: d\n---\n', tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
      ctx.store.upsertSkill(row, '');
    };
    add('a/fresh');
    add('a/old');
    add('a/none');
    const repo = (full_name: string, fetched_at: string) =>
      ctx.store.upsertRepo({ full_name, stars: 1, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at });
    repo('A/Fresh', new Date().toISOString());
    repo('a/old', '2026-01-01T00:00:00.000Z');
    const list = ctx.store.listReposToRefresh(new Date(Date.now() - 3_600_000).toISOString(), 100).sort();
    assert.deepEqual(list, ['a/none', 'a/old']);
  });
});

describe('skills.sh (2단계)', () => {
  it('실패하면 일주일 안의 이전 응답을 대신 쓰고, 그보다 오래됐으면 실패한다', async () => {
    const ctx = ctxWithToken();
    const old = [{ id: 'a/b/pdf', source: 'a/b', skillId: 'pdf', name: 'pdf', installs: 5 }];
    ctx.store.putCached('skillssh:20:pdf', old);
    const age = (days: number) =>
      ctx.store.db.prepare("UPDATE search_cache SET created_at = ? WHERE key = 'skillssh:20:pdf'").run(new Date(Date.now() - days * 86_400_000).toISOString());
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
    age(3);
    assert.deepEqual(await searchSkillsSh(ctx.store, 'pdf'), old);
    age(8);
    await assert.rejects(searchSkillsSh(ctx.store, 'pdf'), /503/);
  });
});

describe('GitHub 호출 한도와 검색 캐시 (2단계)', () => {
  it('버킷은 정한 만큼만 몰아서 보내고, 대기가 너무 길면 줄 서지 않고 바로 포기한다', async () => {
    const b = new TokenBucket(9, 2);
    await b.take();
    await b.take();
    assert.ok(b.waitTime() > 0, '버스트 2개 뒤에는 기다려야 함');
    await assert.rejects(b.take({ maxWaitMs: 100 }), RateLimitWait);
  });

  it('같은 키워드의 코드 검색은 한 번만 부르고, 동시에 와도 요청을 합친다', async () => {
    const ctx = ctxWithToken();
    const calls = fakeCodeSearch();
    const [a, b] = await Promise.all([ctx.github.searchSkillFiles(['pdf', 'tables']), ctx.github.searchSkillFiles(['pdf', 'tables'])]);
    await ctx.github.searchSkillFiles(['pdf', 'tables']);
    assert.equal(calls.length, 1);
    assert.deepEqual(a, b);
    assert.equal(a[0].repo, 'a/b');
    // a result-cache clear (sync) keeps it
    ctx.store.clearSearchCache();
    await ctx.github.searchSkillFiles(['pdf', 'tables']);
    assert.equal(calls.length, 1);
  });

  it('GitHub가 잘라 보낸(incomplete) 결과는 저장하지 않는다', async () => {
    const ctx = ctxWithToken();
    const calls = fakeCodeSearch({ incomplete: true });
    await ctx.github.searchSkillFiles(['docker']);
    await ctx.github.searchSkillFiles(['docker']);
    assert.equal(calls.length, 2);
  });

  it('한도가 바닥났다고 들은 뒤에는 reset 전까지 부르지 않고 바로 실패한다', async () => {
    const ctx = ctxWithToken();
    const calls = fakeCodeSearch({ remaining: '0', status: 403 });
    await assert.rejects(ctx.github.searchSkillFiles(['one']));
    await assert.rejects(ctx.github.searchSkillFiles(['two']), /한도 소진/);
    assert.equal(calls.length, 1);
  });
});

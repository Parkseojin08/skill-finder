import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createContext } from '../src/bootstrap.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { Jobs } from '../src/jobs.ts';
import { collectPopularRepos, popularState } from '../src/sources/popularRepos.ts';

function setup() {
  const ctx = createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-pop-')), githubToken: null }, ':memory:');
  const queries: string[] = [];
  const indexed: string[] = [];
  const since: Array<string | null | undefined> = [];
  const heads: Record<string, string> = {};
  ctx.github.searchRepos = async (q) => {
    queries.push(q);
    return q.startsWith('topic:claude-skills')
      ? [
          { repo: 'big/skills', stars: 90000, description: null, topics: [] },
          { repo: 'mid/skills', stars: 7000, description: null, topics: [] },
        ]
      : [{ repo: 'big/skills', stars: 90000, description: null, topics: [] }];
  };
  ctx.indexer.indexRepo = async (repo, opts = {}) => {
    indexed.push(repo);
    since.push(opts.unchangedSince);
    const sha = heads[repo] ?? 'a'.repeat(40);
    if (opts.unchangedSince === sha) return { skills: 0, sha, unchanged: true, removed: 0 };
    return { skills: repo === 'big/skills' ? 12 : 0, sha, unchanged: false, removed: 0 };
  };
  return { ctx, queries, indexed, since, heads };
}

const runJob = (ctx: ReturnType<typeof setup>['ctx'], force = false) =>
  new Promise<void>((resolve, reject) => {
    const jobs = new Jobs();
    const job = jobs.start('collect', 'test', (ctl) => collectPopularRepos(ctx, ctl, false, force));
    const t = setInterval(() => {
      if (job.finishedAt) {
        clearInterval(t);
        job.status === 'done' ? resolve() : reject(new Error(job.errors.join('; ')));
      }
    }, 5);
  });

describe('인기 저장소 수집', () => {
  it('최소 스타 조건으로 저장소를 찾아 스킬을 색인하고, 일주일 안에는 다시 하지 않는다', async () => {
    const { ctx, queries, indexed } = setup();
    await runJob(ctx);
    assert.ok(queries.length > 0 && queries.every((q) => q.endsWith('stars:>=5000')), queries.join(' | '));
    assert.deepEqual(indexed.sort(), ['big/skills', 'mid/skills']);
    const state = popularState(ctx);
    assert.equal(state.repos['big/skills'].skills, 12);
    assert.ok(state.lastRunAt);

    indexed.length = 0;
    await runJob(ctx);
    assert.deepEqual(indexed, [], '최근에 확인한 저장소는 건너뜀');
    await runJob(ctx, true);
    assert.equal(indexed.length, 2, 'force면 다시 확인');
  });

  it('일주일 뒤 다시 볼 때 커밋이 그대로면 읽지 않고 개수를 유지한다', async () => {
    const { ctx, indexed, since, heads } = setup();
    await runJob(ctx);
    const state = popularState(ctx);
    for (const r of Object.values(state.repos)) r.checkedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    ctx.store.setSetting('popularRepos', state);
    heads['mid/skills'] = 'b'.repeat(40); // only mid/skills moved
    indexed.length = 0;
    since.length = 0;
    await runJob(ctx);
    assert.deepEqual(since, ['a'.repeat(40), 'a'.repeat(40)], '지난번 커밋을 넘긴다');
    const after = popularState(ctx);
    assert.equal(after.repos['big/skills'].skills, 12, '그대로면 개수 유지');
    assert.equal(after.repos['mid/skills'].sha, 'b'.repeat(40));
  });

  it('별이 기준 이상인데 한두 개만 색인된 저장소도 통째로 색인한다', async () => {
    const { ctx, indexed } = setup();
    ctx.store.upsertRepo({ full_name: 'Partial/Repo', stars: 8000, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: new Date().toISOString() });
    ctx.store.upsertRepo({ full_name: 'small/repo', stars: 10, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: new Date().toISOString() });
    for (const repo of ['partial/repo', 'small/repo']) {
      ctx.store.upsertSkill(
        buildSkillRow({ repo, sha: '0'.repeat(40), dirPath: 'skills/x', raw: '---\nname: x\ndescription: X.\n---\n', tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null }),
        '',
      );
    }
    await runJob(ctx);
    assert.deepEqual(indexed.sort(), ['Partial/Repo', 'big/skills', 'mid/skills']);
  });
});

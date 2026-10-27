import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createContext } from '../src/bootstrap.ts';
import { Jobs } from '../src/jobs.ts';
import { collectPopularRepos, popularState } from '../src/sources/popularRepos.ts';

function setup() {
  const ctx = createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-pop-')), githubToken: null }, ':memory:');
  const queries: string[] = [];
  const indexed: string[] = [];
  ctx.github.searchRepos = async (q) => {
    queries.push(q);
    return q.startsWith('topic:claude-skills')
      ? [
          { repo: 'big/skills', stars: 90000, description: null, topics: [] },
          { repo: 'mid/skills', stars: 7000, description: null, topics: [] },
        ]
      : [{ repo: 'big/skills', stars: 90000, description: null, topics: [] }];
  };
  ctx.indexer.indexRepo = async (repo) => {
    indexed.push(repo);
    return repo === 'big/skills' ? 12 : 0;
  };
  return { ctx, queries, indexed };
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
});

// Feature review B2 (scheduler, offline, DB check) and F22 (status, activity, task runs, log, token check).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createContext } from '../src/bootstrap.ts';
import type { AppContext } from '../src/context.ts';
import { pruneUnusedRepos, runDbMaintenance } from '../src/dbMaintenance.ts';
import { checkGithubToken, parseLog, seedCreatedAt, tokenCheckDeps } from '../src/routes/status.ts';
import {
  BACKOFF_MS,
  isNetworkError,
  isOffline,
  jobRunKind,
  noteNetworkError,
  noteNetworkOk,
  registerTask,
  resetNetworkState,
  Scheduler,
  schedulerFor,
  unregisterTask,
  type TaskDef,
} from '../src/scheduler.ts';
import { searchActivity } from '../src/search/activity.ts';
import { registerBuiltInTasks, runSync } from '../src/tasks.ts';
import { rawRequest, startTestServer } from './helpers.ts';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function newCtx(token: string | null = null): AppContext {
  const ctx = createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-sched-')), githubToken: token }, ':memory:');
  ctx.store.setSetting('app', { autoCollect: false }); // no popular-repo collection (it would reach GitHub)
  return ctx;
}

const netErr = (code = 'ENOTFOUND') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ${code} api.github.com`), { code }) });

/** A clock the test moves by hand. */
function clock(start = Date.parse('2026-11-05T00:00:00Z')) {
  let t = start;
  return { now: () => t, add: (ms: number) => (t += ms) };
}

type Row = { kind: string; trigger: string; status: string; counts_json: string | null; error: string | null };
const runs = (ctx: AppContext) => ctx.store.db.prepare('SELECT kind, trigger, status, counts_json, error FROM task_runs ORDER BY id').all() as Row[];
const state = (ctx: AppContext, kind: string) =>
  ctx.store.db.prepare('SELECT * FROM task_state WHERE kind = ?').get(kind) as { last_success_at: string | null; next_due_at: string | null; fail_count: number } | undefined;

beforeEach(() => resetNetworkState());
afterEach(() => resetNetworkState());

describe('작업 스케줄러 (B2)', () => {
  it('작업 이름과 주기를 확인한다', () => {
    assert.throws(() => registerTask({ kind: 'Bad Kind', everyMs: 1000, run: async () => {} }));
    assert.throws(() => registerTask({ kind: 'ok-kind', everyMs: 0, run: async () => {} }));
    registerTask({ kind: 'ok-kind', everyMs: 1000, run: async () => {} });
    unregisterTask('ok-kind');
  });

  it('기한이 된 작업만 돌리고 실행 기록과 다음 기한을 남긴다', async () => {
    const ctx = newCtx();
    const c = clock();
    let n = 0;
    const s = new Scheduler(ctx, { now: c.now, tasks: [{ kind: 'count', everyMs: HOUR, run: async () => ({ counts: { n: ++n } }) }] });
    await s.tick();
    assert.equal(n, 1);
    assert.equal(state(ctx, 'count')!.next_due_at, new Date(c.now() + HOUR).toISOString());
    c.add(30 * MIN);
    await s.tick();
    assert.equal(n, 1, '아직 기한 전');
    c.add(31 * MIN);
    await s.tick();
    assert.equal(n, 2);
    assert.deepEqual(
      runs(ctx).map((r) => [r.kind, r.trigger, r.status, r.counts_json]),
      [
        ['count', 'schedule', 'ok', '{"n":1}'],
        ['count', 'schedule', 'ok', '{"n":2}'],
      ],
    );
    s.stop();
  });

  it('실패하면 5분 → 15분 → 1시간 → 6시간으로 늦추고, 성공하면 처음으로', async () => {
    const ctx = newCtx();
    const c = clock();
    let fail = true;
    const s = new Scheduler(ctx, {
      now: c.now,
      tasks: [
        {
          kind: 'flaky',
          everyMs: DAY,
          run: async () => {
            if (fail) throw new SyntaxError('Unexpected end of JSON input'); // a cut-short answer is tried again too
          },
        },
      ],
    });
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      await s.tick();
      const due = Date.parse(state(ctx, 'flaky')!.next_due_at!);
      waits.push(due - c.now());
      c.add(due - c.now());
    }
    assert.deepEqual(waits, [...BACKOFF_MS, BACKOFF_MS[3]]);
    assert.equal(state(ctx, 'flaky')!.fail_count, 5);
    assert.match(runs(ctx)[0]!.error!, /JSON/);
    fail = false;
    await s.tick();
    assert.equal(state(ctx, 'flaky')!.fail_count, 0);
    assert.equal(Date.parse(state(ctx, 'flaky')!.next_due_at!) - c.now(), DAY);
    s.stop();
  });

  it('주기가 짧은 작업은 주기보다 오래 미루지 않는다', async () => {
    const ctx = newCtx();
    const c = clock();
    const s = new Scheduler(ctx, { now: c.now, tasks: [{ kind: 'short', everyMs: 20 * MIN, run: async () => Promise.reject(new Error('x')) }] });
    for (let i = 0; i < 4; i++) {
      await s.tick();
      c.add(Date.parse(state(ctx, 'short')!.next_due_at!) - c.now());
    }
    assert.equal(Date.parse(state(ctx, 'short')!.next_due_at!) - c.now(), 0);
    await s.tick();
    assert.equal(Date.parse(state(ctx, 'short')!.next_due_at!) - c.now(), 20 * MIN);
    s.stop();
  });

  it('시작할 때 startup 작업을 기한과 상관없이 돌린다', async () => {
    const ctx = newCtx();
    const seen: string[] = [];
    const s = new Scheduler(ctx, {
      tasks: [
        { kind: 'boot', everyMs: DAY, startup: true, run: async (_c, info) => void seen.push(`boot:${info.trigger}`) },
        { kind: 'later', everyMs: DAY, manualOnly: true, run: async () => void seen.push('later') },
      ],
    });
    ctx.store.db.prepare(`INSERT INTO task_state (kind, next_due_at, fail_count) VALUES ('boot', ?, 0)`).run(new Date(Date.now() + DAY).toISOString());
    s.start();
    await new Promise((r) => setTimeout(r, 20));
    s.stop();
    assert.deepEqual(seen, ['boot:startup']);
  });

  it('지난 실행에서 끝나지 않은 기록은 실패로 닫는다', () => {
    const ctx = newCtx();
    ctx.store.db.prepare(`INSERT INTO task_runs (kind, trigger, started_at, status) VALUES ('sync', 'startup', '2026-11-01T00:00:00Z', 'running')`).run();
    new Scheduler(ctx, { tasks: [] }).stop();
    assert.equal(runs(ctx)[0]!.status, 'failed');
  });

  it('task_runs는 30일만 남긴다', () => {
    const ctx = newCtx();
    const c = clock();
    const s = new Scheduler(ctx, { now: c.now, tasks: [] });
    const ins = ctx.store.db.prepare(`INSERT INTO task_runs (kind, trigger, started_at, status) VALUES ('x', 'schedule', ?, 'ok')`);
    ins.run(new Date(c.now() - 31 * DAY).toISOString());
    ins.run(new Date(c.now() - 29 * DAY).toISOString());
    assert.equal(s.pruneRuns(), 1);
    assert.equal(runs(ctx).length, 1);
    s.stop();
  });

  it('시간 제한을 넘기면 실패로 적고 signal을 끊는다', async () => {
    const ctx = newCtx();
    let aborted = false;
    const s = new Scheduler(ctx, {
      tasks: [
        {
          kind: 'slow',
          everyMs: DAY,
          timeoutMs: 30,
          run: (_c, info) =>
            new Promise((resolve) => {
              // Work of its own that is still pending, as an unanswered request would be. The time limit's timer
              // does not keep the process alive (in the app the HTTP server does), and with nothing else pending
              // Node 22's test runner cancels this test and every one after it (from Node 24 on it waits). Should
              // the limit never come, the work ends by itself and the run is 'ok', which fails below.
              const work = setTimeout(resolve, 5000);
              info.signal.addEventListener('abort', () => {
                aborted = true;
                clearTimeout(work);
                setTimeout(resolve, 10);
              });
            }),
        },
      ],
    });
    assert.equal(await s.launch(s.task('slow')!, 'manual'), 'failed');
    assert.equal(aborted, true);
    assert.match(runs(ctx)[0]!.error!, /시간 제한/);
    s.stop();
  });

  it('한가할 때만 도는 작업은 검색 중에는 기다린다', async () => {
    const ctx = newCtx();
    let ran = 0;
    const s = new Scheduler(ctx, { tasks: [{ kind: 'idle-one', everyMs: DAY, idle: true, run: async () => void ran++ }] });
    searchActivity.begin();
    try {
      await s.tick();
      assert.equal(ran, 0);
    } finally {
      searchActivity.end();
    }
    await s.tick();
    assert.equal(ran, 1);
    s.stop();
  });

  it('작업이 시작한 job은 그 작업의 기록 하나, 따로 시작한 job은 manual 기록', async () => {
    const ctx = newCtx();
    const s = new Scheduler(ctx, {
      tasks: [
        {
          kind: 'with-job',
          everyMs: DAY,
          run: async (c) => {
            const job = c.jobs.start('sync', '*', async (ctl) => ctl.setTotal(1));
            const second = c.jobs.start('collect', 'popular-repos', async () => {});
            await c.jobs.wait(job.id);
            await c.jobs.wait(second.id);
          },
        },
      ],
    });
    await s.tick();
    const manual = ctx.jobs.start('collect', 'some-market', async (ctl) => {
      ctl.setTotal(2);
      ctl.tick();
      ctl.tick('broken');
    });
    await ctx.jobs.wait(manual.id);
    assert.deepEqual(
      runs(ctx).map((r) => [r.kind, r.trigger, r.status]),
      [
        ['with-job', 'schedule', 'ok'],
        ['popular', 'schedule', 'ok'],
        ['collect:some-market', 'manual', 'ok'],
      ],
    );
    assert.deepEqual(JSON.parse(runs(ctx)[2]!.counts_json!), { done: 2, total: 2, errors: 1, skipped: 0 });
    assert.equal(jobRunKind({ kind: 'sync', label: 'official' }), 'sync:official');
    s.stop();
  });

  it('runNow: 없는 작업은 null, 도는 중이면 running', async () => {
    const ctx = newCtx();
    let release!: () => void;
    const s = new Scheduler(ctx, {
      tasks: [
        { kind: 'hold', everyMs: DAY, run: () => new Promise<void>((r) => (release = r)) },
        { kind: 'no-hand', everyMs: DAY, manual: false, run: async () => {} },
      ],
    });
    assert.equal(s.runNow('nope'), null);
    assert.equal(s.runNow('no-hand'), null);
    const started = s.runNow('hold');
    assert.ok(started && started !== 'running');
    assert.equal(s.runNow('hold'), 'running');
    assert.equal(s.runningView()[0]!.kind, 'hold');
    await new Promise((r) => setImmediate(r));
    release();
    assert.equal(await started.done, 'ok');
    assert.equal(runs(ctx)[0]!.trigger, 'manual');
    s.stop();
  });
});

describe('오프라인 인식 (B2, P10)', () => {
  it('네트워크 오류를 구별한다', () => {
    assert.equal(isNetworkError(netErr()), true);
    assert.equal(isNetworkError(netErr('ECONNREFUSED')), true);
    assert.equal(isNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), false, '중간에 끊긴 연결은 다시 시도만');
    assert.equal(isNetworkError(new SyntaxError('Unexpected end of JSON input')), false);
    assert.equal(isNetworkError(new Error('GitHub API 한도 초과')), false);
    assert.equal(isNetworkError(new AggregateError([netErr('ECONNREFUSED')])), true);
  });

  it('네트워크 오류가 이어지면 오프라인, 성공 보고로 복구', () => {
    assert.equal(noteNetworkError(new Error('403')), false);
    noteNetworkError(netErr());
    assert.equal(isOffline(), false);
    noteNetworkError(netErr());
    assert.equal(isOffline(), true);
    noteNetworkOk();
    assert.equal(isOffline(), false);
  });

  it('10분 넘게 떨어진 오류는 이어진 것으로 보지 않는다', () => {
    noteNetworkError(netErr(), 0);
    noteNetworkError(netErr(), 11 * MIN);
    assert.equal(isOffline(), false);
  });

  it('오프라인이면 네트워크 작업은 미루고, 다시 연결되면 실패했던 작업을 바로 돌린다', async () => {
    const ctx = newCtx();
    let online = false;
    const ran: string[] = [];
    const s = new Scheduler(ctx, {
      probe: async () => online,
      probeMs: 10,
      tickMs: 60 * 60 * 1000,
      tasks: [
        {
          kind: 'net',
          everyMs: DAY,
          network: true,
          startup: true,
          run: async () => {
            ran.push('net');
            if (!online) throw netErr();
          },
        },
        { kind: 'local', everyMs: DAY, run: async () => void ran.push('local') },
      ],
    });
    s.start();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(isOffline(), true, '오류 하나 + 확인이 실패 → 오프라인');
    assert.equal(state(ctx, 'net')!.fail_count, 1);
    // due again, but offline: only the local task may run
    ctx.store.db.prepare(`UPDATE task_state SET next_due_at = '2000-01-01T00:00:00Z'`).run();
    ran.length = 0;
    await s.tick();
    assert.deepEqual(ran, ['local']);
    online = true;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(isOffline(), false);
    assert.ok(ran.includes('net'), '복구되자 바로');
    assert.equal(state(ctx, 'net')!.fail_count, 0);
    s.stop();
  });

  it('켤 때 오프라인이면 동기화는 실패로 남아 5분 뒤 다시 돈다 (P10)', async () => {
    const ctx = newCtx();
    ctx.github.resolveRef = async () => {
      throw netErr();
    };
    await assert.rejects(runSync(ctx), (err) => isNetworkError(err));
    const s = new Scheduler(ctx, { probe: async () => false, tasks: [{ kind: 'sync', everyMs: DAY, network: true, run: runSync }] });
    const before = Date.now();
    assert.equal(await s.launch(s.task('sync')!, 'startup'), 'failed');
    const due = Date.parse(state(ctx, 'sync')!.next_due_at!);
    assert.ok(due - before >= 5 * MIN - 1000 && due - before <= 5 * MIN + 5000);
    s.stop();
  });
});

describe('DB 점검 (B2)', () => {
  it('점검 단계를 돌리고 참조 없는 30일 지난 저장소 행만 지운다', async () => {
    const ctx = newCtx();
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const repo = (full_name: string, fetched_at: string | null) =>
      ctx.store.upsertRepo({ full_name, stars: 1, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at });
    repo('gone/old', old);
    repo('gone/new', new Date().toISOString());
    repo('gone/never', null);
    repo('Fav/Repo', old);
    repo('anthropics/claude-plugins-official', old); // a marketplace's repo
    ctx.store.addFavorite('repo:fav/repo', 'repo');
    const out = await runDbMaintenance(ctx, undefined);
    assert.ok(out);
    assert.equal(out.counts!.quickCheckProblems, 0);
    assert.equal(out.counts!.reposPruned, 1);
    assert.equal(ctx.store.getRepo('gone/old'), undefined);
    assert.ok(ctx.store.getRepo('gone/new') && ctx.store.getRepo('gone/never') && ctx.store.getRepo('fav/repo'));
    assert.equal(pruneUnusedRepos(ctx), 0);
  });

  it('시간 제한을 넘기면 남은 단계는 다음으로 미룬다', async () => {
    const ctx = newCtx();
    let t = 0;
    const out = await runDbMaintenance(ctx, undefined, { budgetMs: 5, now: () => (t += 10) });
    assert.ok(out && out.counts!.skippedSteps! > 0);
    assert.match(out.note!, /미룸/);
  });
});

describe('상태 보기 (F22)', () => {
  it('seed의 만든 날짜를 앞부분만 읽어 얻는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-seed-'));
    const path = join(dir, 'seed.json.gz');
    writeFileSync(path, gzipSync(JSON.stringify({ format: 1, createdAt: '2026-11-01T02:03:04.000Z', skills: Array.from({ length: 5000 }, (_, i) => ({ i })) })));
    assert.equal(seedCreatedAt(path), '2026-11-01T02:03:04.000Z');
    assert.equal(seedCreatedAt(join(dir, 'none.gz')), null);
  });

  it('로그를 수준별로 거르고 여러 줄 메시지를 하나로 둔다', () => {
    const text = [
      '2026-11-05T00:00:00.000Z INFO started',
      '2026-11-05T00:00:01.000Z WARN [repo-meta] slow',
      '2026-11-05T00:00:02.000Z ERROR boom',
      '    at stack line',
      '2026-11-05T00:00:03.000Z INFO token ghp_abcdefghijklmnopqrstuvwxyz0123',
    ].join('\n');
    const warn = parseLog(text, 'warn', 200);
    assert.deepEqual(
      warn.map((e) => e.level),
      ['WARN', 'ERROR'],
    );
    assert.equal(warn[1]!.text, 'boom\n    at stack line');
    assert.equal(parseLog(text, 'info', 1)[0]!.text, 'token [가림]');
    assert.equal(parseLog(text, 'error', 200).length, 1);
  });

  it('512KB 악성 로그도 길이에 비례한 시간에 읽는다', () => {
    const evil = `2026-11-05T${'0'.repeat(512 * 1024)}`;
    const many = '2026-11-05T00:00:00.000Z WARN x\n'.repeat(16 * 1024);
    const t0 = performance.now();
    parseLog(evil, 'info', 200);
    parseLog(`${many}${' '.repeat(512 * 1024)}`, 'warn', 200);
    assert.equal(isNetworkError(Object.assign(new TypeError(`fetch failed${'x'.repeat(512 * 1024)}`), {})), true);
    assert.ok(performance.now() - t0 < 1000, `${performance.now() - t0}ms`);
  });

  it('토큰 확인: classic 넓은 권한, 무효, 연결 안 됨', async () => {
    const answer = (status: number, headers: Record<string, string> = {}) =>
      (async () =>
        new Response(JSON.stringify({ resources: { core: { limit: 5000, remaining: 4990, reset: 1 }, graphql: { limit: 5000, remaining: 5000, reset: 2 } } }), {
          status,
          headers,
        })) as unknown as typeof fetch;
    const broad = await checkGithubToken('ghp_x', answer(200, { 'x-oauth-scopes': 'repo, workflow' }));
    assert.deepEqual([broad.state, broad.kind, broad.limit, broad.remaining, broad.broad, broad.scopes], ['valid', 'classic', 5000, 4990, true, ['repo', 'workflow']]);
    const narrow = await checkGithubToken('ghp_x', answer(200, { 'x-oauth-scopes': '' }));
    assert.equal(narrow.broad, false);
    const fine = await checkGithubToken('github_pat_x', answer(200));
    assert.deepEqual([fine.kind, fine.scopes, fine.broad], ['fine-grained', null, false]);
    assert.equal((await checkGithubToken('ghp_x', answer(401))).state, 'invalid');
    const down = await checkGithubToken('ghp_x', (async () => {
      throw netErr();
    }) as unknown as typeof fetch);
    assert.equal(down.state, 'unknown');
    assert.equal((await checkGithubToken(null)).state, 'none');
  });

  it('GET /api/status, /api/activity, POST /api/tasks/:kind/run, GET /api/logs', async () => {
    registerTask({ kind: 'test-local', label: '시험 작업', everyMs: DAY, run: async () => ({ counts: { one: 1 } }) });
    const srv = await startTestServer();
    try {
      const headers = { 'X-Skill-Finder': '1' };
      const post = { ...headers, Origin: `http://127.0.0.1:${srv.port}`, 'Content-Type': 'application/json' };
      const st = await rawRequest({ port: srv.port, path: '/api/status', headers });
      assert.equal(st.status, 200);
      const body = JSON.parse(st.body);
      assert.ok(['good', 'stale'].includes(body.freshness.level));
      assert.equal(body.github.limits.length, 4);
      assert.deepEqual(
        body.github.limits.map((l: { resource: string }) => l.resource),
        ['core', 'search', 'code_search', 'graphql'],
      );
      assert.ok(body.sources.marketplaces.length > 0);
      assert.ok(body.tasks.some((t: { kind: string }) => t.kind === 'test-local'));
      assert.equal(body.network.offline, false);

      assert.equal((await rawRequest({ port: srv.port, method: 'POST', path: '/api/tasks/nope/run', headers: post })).status, 404);
      const run = await rawRequest({ port: srv.port, method: 'POST', path: '/api/tasks/test-local/run', headers: post });
      assert.equal(run.status, 202);
      await new Promise((r) => setTimeout(r, 20));
      const after = JSON.parse((await rawRequest({ port: srv.port, path: '/api/status', headers })).body);
      assert.deepEqual(after.runs[0].counts, { one: 1 });
      assert.equal(after.runs[0].trigger, 'manual');
      // another origin cannot start a task
      const foreign = await rawRequest({ port: srv.port, method: 'POST', path: '/api/tasks/test-local/run', headers: { ...post, Origin: 'http://evil.example' } });
      assert.equal(foreign.status, 403);

      const act = JSON.parse((await rawRequest({ port: srv.port, path: '/api/activity', headers })).body);
      assert.ok(Array.isArray(act.jobs) && Array.isArray(act.running) && Array.isArray(act.failures));

      const logs = await rawRequest({ port: srv.port, path: '/api/logs?level=warn&lines=5', headers });
      assert.equal(logs.status, 200);
      assert.ok(Array.isArray(JSON.parse(logs.body).entries));

      tokenCheckDeps.fetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
      const none = JSON.parse((await rawRequest({ port: srv.port, method: 'POST', path: '/api/github-token/check', headers: post })).body);
      assert.equal(none.state, 'none', '토큰이 없으면 묻지 않음');
    } finally {
      tokenCheckDeps.fetch = null;
      unregisterTask('test-local');
      schedulerFor(srv.ctx).stop();
      await srv.close();
    }
  });

  it('기본 작업이 모두 등록되고 업데이트 확인은 설치판에서만 보인다', () => {
    registerBuiltInTasks();
    const ctx = newCtx();
    const kinds = schedulerFor(ctx)
      .tasks()
      .map((t: TaskDef) => t.kind);
    for (const k of ['sync', 'risk-recheck', 'prune', 'db-maintenance', 'popular']) assert.ok(kinds.includes(k), k);
    assert.ok(!kinds.includes('repo-meta'), '토큰 없으면 별 정보 갱신은 없음');
    assert.equal(kinds.includes('update-check'), process.env.SKILL_FINDER_UPDATES === '1');
    schedulerFor(ctx).stop();
  });
});

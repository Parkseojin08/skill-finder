// Feature review 2026-11-04, stage 1, the search bundle: B1 (cache generations), B4 (accuracy: decision 4's
// narrower exemption, decision 5's aliases, decision 6's spelling button), F18 (suspected download counts, decision
// 7) with P4 (README picks), and P5 (star refresh going on past a broken answer).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createContext } from '../src/bootstrap.ts';
import type { AppContext } from '../src/context.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow, pluginFtsText } from '../src/indexer.ts';
import { matchSkills } from '../src/recommend/readme.ts';
import { bumpIndexGeneration, indexGeneration, pruneSearchCache, trackIndexChanges } from '../src/search/indexGeneration.ts';
import { installsSuspect } from '../src/search/installsSuspect.ts';
import { ftsAllQuery, ftsQuery, runSearch, type SearchDeps, type SearchEvent } from '../src/search/pipeline.ts';
import { queryAliases } from '../src/search/queryAliases.ts';
import { lexicalMatch } from '../src/search/rank.ts';
import { spellingSuggestion, swapCorrection } from '../src/search/spelling.ts';
import { getSettings, saveSettings } from '../src/settings.ts';
import { REPO_META_RETRY, refreshRepoMeta, startSync } from '../src/tasks.ts';

type Results = Extract<SearchEvent, { type: 'results' }>;

function newCtx(token: string | null = null): AppContext {
  const ctx = createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-sr-')), githubToken: token }, ':memory:');
  ctx.github.getRepoMeta = async (r) => ctx.store.getRepo(r) ?? null;
  ctx.github.searchRepos = async () => [];
  ctx.store.setSetting('app', { minStars: 0 });
  return ctx;
}

function addSkill(ctx: AppContext, repo: string, dir: string, name: string, description: string, body = 'Body'): string {
  const row = buildSkillRow({ repo, sha: 'a'.repeat(40), dirPath: dir, raw: `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`, tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
  ctx.store.upsertSkill(row, '');
  return row.id;
}

function stars(ctx: AppContext, full_name: string, n: number) {
  ctx.store.upsertRepo({ full_name, stars: n, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: new Date().toISOString() });
}

const deps = (ctx: AppContext, patch: Partial<SearchDeps> = {}): SearchDeps => ({ ctx, skillsSh: async () => [], ...patch });

async function search(d: SearchDeps, q: string, filters = {}) {
  const events: SearchEvent[] = [];
  await runSearch(d, q, filters, (e) => events.push(e));
  const all = events.filter((e) => e.type === 'results') as Results[];
  return { events, first: all[0], final: all.at(-1)!, done: events.at(-1) as Extract<SearchEvent, { type: 'done' }> };
}

describe('B1 검색 캐시 세대', () => {
  it('같은 값을 다시 쓰는 작업은 세대를 올리지 않고, 바뀐 작업만 한 번 올린다', async () => {
    const ctx = newCtx();
    const id = addSkill(ctx, 'o/r', 's', 'pdf-tool', 'Extract tables from PDF files.');
    const before = indexGeneration(ctx.store);
    await trackIndexChanges(ctx.store, async () => {
      addSkill(ctx, 'o/r', 's', 'pdf-tool', 'Extract tables from PDF files.'); // read again, same SKILL.md
    });
    assert.equal(indexGeneration(ctx.store), before, '같은 내용 다시 쓰기');
    await trackIndexChanges(ctx.store, async () => {
      addSkill(ctx, 'o/r', 's', 'pdf-tool', 'Extract tables and forms from PDF files.');
      addSkill(ctx, 'o/r', 't', 'pdf-two', 'Second skill.');
      ctx.store.deleteSkill(id);
    });
    assert.equal(indexGeneration(ctx.store), before + 1, '여러 번 바꿔도 작업 단위로 한 번');
    addSkill(ctx, 'o/r', 'u', 'outside', 'Written by a search.');
    assert.equal(indexGeneration(ctx.store), before + 1, '작업 밖의 쓰기(검색 중 색인)는 세지 않음');
    // flush: the first-run sync bumps after each marketplace (D#323b)
    const flushed: boolean[] = [];
    await trackIndexChanges(ctx.store, async (flush) => {
      addSkill(ctx, 'o/r', 'v', 'first', 'First marketplace.');
      flushed.push(flush());
      flushed.push(flush());
    });
    assert.deepEqual(flushed, [true, false]);
    assert.equal(indexGeneration(ctx.store), before + 2, '중간에 올렸으면 끝에서 또 올리지 않음');
  });

  it('바뀐 것이 없는 동기화 뒤에도 저장된 검색이 그대로 나오고, 바뀌면 세대가 오른다', async () => {
    const ctx = newCtx();
    saveSettings(ctx.store, { ...getSettings(ctx.store), autoCollect: false, minStars: 0 });
    let head = 'a'.repeat(40);
    let description = 'PDF helpers';
    ctx.github.resolveRef = async () => ({ sha: head, defaultBranch: null });
    ctx.github.getRawText = async (repo) =>
      ({
        status: 200,
        text: JSON.stringify({ name: 'x', owner: { name: 'o' }, plugins: repo === 'anthropics/skills' ? [{ name: 'pdfkit', source: './pdfkit', description }] : [] }),
      }) as never;
    ctx.indexer.indexPlugin = async (id) => {
      const row = buildSkillRow({ repo: 'anthropics/skills', sha: 'a'.repeat(40), dirPath: 'pdfkit', raw: '---\nname: pdfkit\ndescription: Extract tables from PDF files.\n---\n', tree: new TreeIndex([]), origin: 'plugin', pluginId: id, extraFlags: [], install: null, lastCommitAt: null });
      ctx.store.upsertSkill(row, pluginFtsText(ctx.store.getPlugin(id)!));
      ctx.store.markPluginIndexed(id, ctx.store.getPlugin(id)!.sha, null, null);
      return 1;
    };
    const sync = async () => {
      const job = startSync(ctx);
      while (job.status === 'running') await new Promise((r) => setTimeout(r, 5));
      assert.equal(job.status, 'done');
    };
    await sync();
    const g1 = indexGeneration(ctx.store);
    assert.ok(g1 > 0, '첫 동기화는 색인을 바꿨음');
    const d = deps(ctx);
    assert.equal((await search(d, 'pdf tables')).done.cached, false);
    await sync();
    assert.equal(indexGeneration(ctx.store), g1, '바뀐 것 없음');
    assert.equal((await search(d, 'pdf tables')).done.cached, true, '동기화가 캐시를 지우지 않음');
    head = 'b'.repeat(40);
    description = 'PDF helpers, now with forms';
    await sync();
    assert.ok(indexGeneration(ctx.store) > g1, '플러그인 설명이 바뀜');
    assert.equal((await search(d, 'pdf tables')).done.cached, false, '세대가 바뀐 검색은 다시 찾음');
  });

  it('이전 세대의 검색은 "이전 결과"로 먼저 보내고, 새 결과로 바꾼다', async () => {
    const ctx = newCtx();
    addSkill(ctx, 'o/r', 'a', 'pdf-tables', 'Extract tables from PDF files.');
    const d = deps(ctx, { staleMinSkills: 0 });
    await search(d, 'pdf tables');
    await trackIndexChanges(ctx.store, async () => {
      addSkill(ctx, 'o/r', 'b', 'pdf-tables-pro', 'Extract tables from PDF files, faster.');
    });
    const r = await search(d, 'pdf tables');
    assert.equal(r.first.stale, true);
    assert.deepEqual(r.first.items.map((i) => i.name), ['pdf-tables']);
    assert.ok(r.events.indexOf(r.first) < r.events.findIndex((e) => e.type === 'candidates'), '첫 카드보다 먼저');
    assert.equal(r.final.stale, undefined);
    assert.ok(r.final.items.some((i) => i.name === 'pdf-tables-pro'));
    assert.equal(r.done.cached, false);
    const again = await search(d, 'pdf tables');
    assert.equal(again.done.cached, true, '새 세대로 저장됨');
    assert.equal(again.first.stale, undefined);
  });

  it('색인이 아직 작으면(첫 실행 수집 중) 이전 결과를 먼저 보내지 않는다 (D#323b)', async () => {
    const ctx = newCtx();
    addSkill(ctx, 'o/r', 'a', 'pdf-tables', 'Extract tables from PDF files.');
    await search(deps(ctx), 'pdf tables');
    bumpIndexGeneration(ctx.store);
    const r = await search(deps(ctx), 'pdf tables');
    assert.ok(!r.events.some((e) => e.type === 'results' && e.stale));
  });

  it('캐시 정리는 나이로만 한다', () => {
    const ctx = newCtx();
    ctx.store.putCached('search:new', 1);
    ctx.store.putCached('search:old', 1);
    ctx.store.putCached('skillssh:old', 1);
    ctx.store.putCached('skillssh:week', 1);
    const age = (key: string, days: number) => ctx.store.db.prepare('UPDATE search_cache SET created_at = ? WHERE key = ?').run(new Date(Date.now() - days * 86_400_000).toISOString(), key);
    age('search:old', 2);
    age('skillssh:old', 8);
    age('skillssh:week', 3);
    pruneSearchCache(ctx.store);
    const keys = (ctx.store.db.prepare('SELECT key FROM search_cache ORDER BY key').all() as Array<{ key: string }>).map((r) => r.key);
    assert.deepEqual(keys, ['search:new', 'skillssh:week']);
  });
});

describe('B4 검색 정확도', () => {
  it('결정 4: 로컬 전문 검색에만 걸리고 앱의 단어 일치로는 안 맞는 결과는 숨긴다', async () => {
    const ctx = newCtx();
    // porter stems "localization" and "local" alike; the app's own matching does not
    addSkill(ctx, 'o/r', 'a', 'file-server', 'Serve local files over HTTP.');
    addSkill(ctx, 'o/r', 'b', 'i18n-helper', 'Localization of app strings.');
    const r = (await search(deps(ctx), 'localization')).final;
    const names = r.items.map((i) => i.name);
    assert.ok(names.includes('i18n-helper'), names.join(','));
    assert.ok(!names.includes('file-server'), names.join(','));
    assert.equal(r.hiddenNoMatch, 1);
  });

  it('결정 5: 별칭 8개는 전문 검색과 일치 판정에 들어가고, word는 문서 단어가 있을 때만', () => {
    assert.equal(ftsQuery(['ppt template']), '"ppt" OR "pptx" OR "powerpoint" OR "template"');
    assert.equal(ftsAllQuery(['ppt template']), '("ppt" OR "pptx" OR "powerpoint") AND "template"');
    assert.equal(ftsAllQuery(['security holes']), '"security" AND "holes"', '별칭 없는 검색어는 그대로');
    assert.deepEqual([...queryAliases('k8s deployment')], [['k8s', ['kubernetes']]]);
    assert.deepEqual([...queryAliases('postgres schema design')], [['postgres', ['postgresql']]]);
    assert.deepEqual([...queryAliases('excel formulas')], [['excel', ['xlsx']]]);
    assert.deepEqual([...queryAliases('word count')], [], 'word 혼자는 형식이 아님');
    assert.deepEqual([...queryAliases('edit word document')], [['word', ['docx']], ['document', ['docx']]]);
    const m = lexicalMatch('ppt template', 'pptx', 'Create and edit slide templates.');
    assert.equal(m.name, 0.5);
    assert.equal(m.any, 1);
    assert.deepEqual(m.aliased, [{ from: 'ppt', to: ['pptx'] }]);
    assert.equal(lexicalMatch('pdf tables', 'pdf', 'Extract tables').aliased, undefined);
  });

  it('결정 5: 별칭으로 찾은 결과가 있으면 결과에 그 별칭을 알린다', async () => {
    const ctx = newCtx();
    addSkill(ctx, 'anthropics/skills', 'skills/pptx', 'pptx', 'Create, edit and analyze presentations.');
    addSkill(ctx, 'o/r', 'k', 'kubernetes-deploy', 'Write Kubernetes manifests and roll out deployments.');
    const ppt = (await search(deps(ctx), 'ppt')).final;
    assert.deepEqual(ppt.items.map((i) => i.name), ['pptx']);
    assert.deepEqual(ppt.aliases, [{ from: 'ppt', to: ['pptx'] }]);
    const k8s = (await search(deps(ctx), 'k8s deployment')).final;
    assert.ok(k8s.items.some((i) => i.name === 'kubernetes-deploy'));
    assert.deepEqual(k8s.aliases, [{ from: 'k8s', to: ['kubernetes'] }]);
    assert.equal((await search(deps(ctx), 'pptx')).final.aliases, undefined, '별칭을 쓰지 않았으면 없음');
  });

  it('결정 6: 두 글자 자리 바꿈만 고치고, 색인 단어(3번 이상)로만 고친다', () => {
    const df = new Map([['design', 5], ['docs', 9], ['table', 3], ['rare', 2], ['desk', 4]]);
    assert.equal(swapCorrection('desing', df), 'design');
    assert.equal(swapCorrection('dosc', df), 'docs');
    assert.equal(swapCorrection('tabel', df), 'table');
    assert.equal(swapCorrection('design', df), null, '맞는 단어');
    assert.equal(swapCorrection('raer', df), null, '드문 단어로는 고치지 않음');
    assert.equal(swapCorrection('dseign', new Map([['design', 5]])), 'design');
    assert.equal(swapCorrection('desgn', df), null, '빠진 글자는 고치지 않음');
    assert.equal(swapCorrection('pdf', df), null, '4글자 미만');
  });

  it('결정 6: 결과가 적으면 고친 검색어를 버튼용으로만 보낸다 (자동 적용 없음)', async () => {
    const ctx = newCtx();
    for (const [dir, name] of [['a', 'ui-design'], ['b', 'design-review'], ['c', 'design-tokens']]) addSkill(ctx, 'o/r', dir, name, 'Design systems and patterns.');
    const r = (await search(deps(ctx), 'desing patterns')).final;
    assert.deepEqual(r.spelling, { query: 'design patterns', words: [{ from: 'desing', to: 'design' }] });
    assert.equal(r.items.length, 3, 'patterns로만 찾은 결과 (검색은 입력 그대로)');
    assert.equal(spellingSuggestion(ctx.store, 'design patterns'), null);
    assert.equal((await search(deps(ctx), 'design')).final.spelling, undefined);
  });
});

describe('F18 다운로드 수 의심 (결정 7)', () => {
  it('세 규칙: 별 대비 다운로드, 별 적은 저장소 여러 곳의 같은 스킬, 유명 저장소 이름 흉내', () => {
    const ctx = newCtx();
    const base = { name: 'x', nameDesc: null, origin: 'generic' as const };
    assert.deepEqual(installsSuspect(ctx.store, { ...base, repo: '101-skills/superpowers', installs: 883029, stars: 18 })?.reasons, ['ratio']);
    assert.equal(installsSuspect(ctx.store, { ...base, repo: 'a/b', installs: 50_000, stars: 99 }), null, '505배');
    assert.equal(installsSuspect(ctx.store, { ...base, repo: 'a/b', installs: 900_000, stars: null }), null, '별 수 모름');
    assert.equal(installsSuspect(ctx.store, { ...base, repo: null, installs: 900_000, stars: null, origin: 'wellknown' }), null, 'well-known 출처 제외');
    assert.equal(installsSuspect(ctx.store, { ...base, repo: 'a/b', installs: 900_000, stars: 1, exempt: true }), null, '공식·파트너 제외');

    // copies: the same name + description in three low-star repos, each with big downloads
    const ids = ['c1/kit', 'c2/kit', 'c3/kit'].map((repo) => {
      stars(ctx, repo, 90);
      const id = addSkill(ctx, repo, 's', 'ai-video', 'Generate videos with AI.');
      ctx.store.setSkillInstalls(id, 40_000);
      return id;
    });
    const nd = ctx.store.getSkill(ids[0])!.name_desc_sha256;
    bumpIndexGeneration(ctx.store); // the facts are kept per generation
    assert.deepEqual(installsSuspect(ctx.store, { ...base, repo: 'c1/kit', nameDesc: nd, installs: 40_000, stars: 90 })?.reasons, ['copies']);
    assert.equal(installsSuspect(ctx.store, { ...base, repo: 'c1/kit', nameDesc: nd, installs: 40_000, stars: 150 }), null, '자기 저장소 별이 많으면 아님');

    // impostor: a repo named like a famous one by another owner; a common name ("skills") is not imitation
    stars(ctx, 'obra/superpowers', 300_000);
    stars(ctx, 'anthropics/skills', 180_000);
    bumpIndexGeneration(ctx.store);
    assert.deepEqual(installsSuspect(ctx.store, { ...base, repo: 'qu-skills/superpowers', installs: 5000, stars: 500 })?.reasons, ['impostor']);
    assert.equal(installsSuspect(ctx.store, { ...base, repo: 'obra/superpowers', installs: 5000, stars: 300_000 }), null);
    assert.equal(installsSuspect(ctx.store, { ...base, repo: 'cloudflare/skills', installs: 100_000, stars: 3000 }), null);
    assert.equal(installsSuspect(ctx.store, { ...base, repo: 'qu-skills/superpowers', installs: 900, stars: 500 }), null, '다운로드가 적으면 볼 것 없음');
  });

  it('의심 수는 정렬에서 "모름"이고, 항목에 따로 실린다', async () => {
    const ctx = newCtx();
    stars(ctx, 'big/skills', 9000);
    stars(ctx, 'copycat/tools', 18);
    addSkill(ctx, 'big/skills', 'pdf', 'pdf-tables', 'Extract tables from PDF files.');
    addSkill(ctx, 'copycat/tools', 'pdf', 'pdf-tables-fast', 'Extract tables from PDF files quickly.');
    const hits = [
      { id: 'big/skills/pdf-tables', source: 'big/skills', skillId: 'pdf', name: 'pdf-tables', installs: 1200 },
      { id: 'copycat/tools/pdf-tables-fast', source: 'copycat/tools', skillId: 'pdf', name: 'pdf-tables-fast', installs: 880_000 },
    ];
    const r = await search(deps(ctx, { skillsSh: async () => hits }), 'pdf tables');
    const names = r.final.items.map((i) => i.name);
    assert.ok(names.indexOf('pdf-tables') < names.indexOf('pdf-tables-fast'), names.join(','));
    const copy = r.final.items.find((i) => i.name === 'pdf-tables-fast')!;
    assert.equal(copy.installs, undefined);
    assert.deepEqual(copy.installsSuspect, { installs: 880_000, reasons: ['ratio'] });
    assert.equal(ctx.store.getSkill(copy.id)!.installs, 880_000, '저장값은 그대로(DB 변경 없음)');
    const early = r.events.find((e) => e.type === 'candidates') as Extract<SearchEvent, { type: 'candidates' }> | undefined;
    if (early) assert.ok(!early.items.some((i) => i.installs === 880_000), '첫 카드도 같은 규칙');
  });

  it('README 추천도 의심 수를 "모름"으로 보고 정렬한다 (문제 P4)', () => {
    const ctx = newCtx();
    stars(ctx, 'real/skills', 9000);
    stars(ctx, 'copy/skills2', 4);
    const real = addSkill(ctx, 'real/skills', 'a', 'video-maker', 'Generate marketing videos with avatars.');
    const fake = addSkill(ctx, 'copy/skills2', 'a', 'video-studio', 'Generate marketing videos with avatars.');
    ctx.store.setSkillInstalls(real, 3000);
    ctx.store.setSkillInstalls(fake, 775_000);
    const keywords = ['video', 'marketing', 'avatar'].map((t) => ({ key: t, term: t, weight: 3 }));
    const out = matchSkills(ctx.store, keywords, getSettings(ctx.store).weights);
    assert.deepEqual(out.map((m) => m.item.name), ['video-maker', 'video-studio']);
    const f = out[1].item as typeof out[1]['item'] & { installsSuspect?: unknown };
    assert.equal(f.installs, undefined);
    assert.deepEqual(f.installsSuspect, { installs: 775_000, reasons: ['ratio'] });
  });
});

describe('P5 별 정보 갱신이 깨진 응답 하나에 멈추지 않는다', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function manyRepos(n: number) {
    REPO_META_RETRY.waitMs = 0;
    const ctx = newCtx('test-token');
    for (let i = 0; i < n; i++) addSkill(ctx, `o/r${i}`, 's', 's', 'd');
    return ctx;
  }
  const ok = (init: RequestInit) => {
    const size = Object.keys(JSON.parse(String(init.body)).variables).length / 2;
    const data = Object.fromEntries(Array.from({ length: size }, (_, i) => [`r${i}`, { stargazerCount: 5, pushedAt: null, isArchived: false, isFork: false, licenseInfo: null, defaultBranchRef: { name: 'main' } }]));
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  const firstRepo = (init: RequestInit) => {
    const v = JSON.parse(String(init.body)).variables as Record<string, string>;
    return `${v.o0}/${v.n0}`;
  };

  it('잘린 JSON은 그 묶음만 한 번 더 묻는다', async () => {
    const ctx = manyRepos(150);
    let calls = 0;
    globalThis.fetch = (async (_u: string, init: RequestInit) => (++calls === 1 ? new Response('{"data": {"r0": ', { status: 200 }) : ok(init))) as typeof fetch;
    assert.equal(await refreshRepoMeta(ctx), 150);
    assert.equal(calls, 3);
  });

  it('계속 깨지는 묶음은 건너뛰고 다음 묶음을 계속한다', async () => {
    const ctx = manyRepos(250);
    const asked: string[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      asked.push(firstRepo(init));
      if (firstRepo(init) === asked[0]) throw new TypeError('fetch failed');
      return ok(init);
    }) as typeof fetch;
    assert.equal(await refreshRepoMeta(ctx), 150);
    assert.equal(asked.length, 4, '첫 묶음 두 번, 나머지 두 묶음 한 번씩');
  });

  it('여러 묶음이 잇달아 깨지면 네트워크가 끊긴 것으로 보고 멈춘다', async () => {
    const ctx = manyRepos(500);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as typeof fetch;
    assert.equal(await refreshRepoMeta(ctx), 0);
    assert.equal(calls, 6, '세 묶음 × 두 번');
  });
});

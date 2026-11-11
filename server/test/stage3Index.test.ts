// Feature review stage 3, bundle E: content-addressed re-indexing (B9), near-copy groups (B8), the source card (F5)
// and the daily star counts (F17 stage 2 record).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { RISK_RULES_VERSION } from '../src/analyze/risk.ts';
import { createContext } from '../src/bootstrap.ts';
import { clusterInfo, clusterSignatures, compareRepresentative, runClusterRefresh } from '../src/dedupe/clusters.ts';
import { pluginTreeFingerprint } from '../src/dedupe/fingerprint.ts';
import { bandKeys, computeMinhash, decodeMinhash, encodeMinhash, LSH_BANDS, MINHASH_SIZE, minhashText, similarity, skillMinhash } from '../src/dedupe/minhash.ts';
import { officialTwins, sourceCard } from '../src/dedupe/sourceCard.ts';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow, writeSkillRow } from '../src/indexer.ts';
import { findSimilar } from '../src/routes/similar.ts';
import { bumpIndexGeneration, indexGeneration, trackIndexChanges } from '../src/search/indexGeneration.ts';
import { pruneRepoStars, starsDay } from '../src/sources/github.ts';
import { recheckRiskRules } from '../src/tasks.ts';
import { startTestServer } from './helpers.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const md = (name: string, description: string, body = 'Body.') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
const gitBlob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const newCtx = (token: string | null = null) => createContext({ port: 0, dev: false, dataDir: mkdtempSync(join(tmpdir(), 'sf-s3e-')), githubToken: token }, ':memory:');

const LONG = (topic: string) =>
  `Use this skill to ${topic}. It reads the input files, checks each section against the rules, writes a short report with ` +
  `the problems found and suggests fixes for every one of them, step by step, so the user can apply them quickly.`;

/** A marketplace repo served from memory, with git blob SHAs in its tree (as the tree API and git ls-tree give). */
function marketplace(files: Record<string, string>) {
  const ctx = newCtx();
  const repo = { head: 'a'.repeat(40), files, reads: [] as string[], trees: 0 };
  ctx.github.resolveRef = async () => ({ sha: repo.head, defaultBranch: null });
  ctx.github.getTree = async (r, sha) => (
    repo.trees++, { repo: r, sha, entries: Object.entries(repo.files).map(([path, text]) => ({ path, size: text.length, sha: gitBlob(text) })), via: 'api', commitDate: null }
  );
  ctx.github.getRawText = async (_r, _ref, path) => (repo.reads.push(path), path in repo.files ? { status: 200, text: repo.files[path] } : { status: 404, text: null }) as never;
  ctx.github.getRepoMeta = async () => null;
  ctx.store.upsertMarketplace({ name: 'm', repo: 'o/market', enabled: true, index_mode: 'eager' });
  const plugin = (name: string, path: string, sha: string) =>
    ctx.store.upsertPlugin({ id: `${name}@m`, marketplace: 'm', name, display_name: null, description: null, category: null, keywords: null, source_json: JSON.stringify(`./${path}`), source_kind: 'relative', repo: 'o/market', path, ref: null, sha, strict: null, entry_json: JSON.stringify({ entry: { name, source: `./${path}` }, pluginRoot: null }) });
  return { ctx, repo, plugin };
}

describe('B9 내용 주소 증분 색인', () => {
  it('마켓 커밋만 바뀌고 플러그인 폴더가 같으면 아무것도 내려받지 않고 커밋만 옮긴다', async () => {
    const { ctx, repo, plugin } = marketplace({
      'plugins/a/.claude-plugin/plugin.json': '{"name":"a"}',
      'plugins/a/skills/x/SKILL.md': md('x', LONG('review pull requests')),
      'plugins/a/skills/y/SKILL.md': md('y', LONG('write release notes')),
      'plugins/b/skills/z/SKILL.md': md('z', LONG('lint markdown')),
      'README.md': 'v1',
    });
    plugin('a', 'plugins/a', repo.head);
    plugin('b', 'plugins/b', repo.head);
    assert.equal(await ctx.indexer.indexPlugin('a@m'), 2);
    assert.equal(await ctx.indexer.indexPlugin('b@m'), 1);
    assert.equal(repo.reads.length, 4, 'plugin.json 1개 + SKILL.md 3개');
    const fp = ctx.store.getPlugin('a@m')!.tree_fingerprint;
    assert.match(fp ?? '', /^[0-9a-f]{64}$/);
    const x = ctx.store.getSkill('gh:o/market:plugins/a/skills/x')!;
    assert.equal(x.skill_md_blob, gitBlob(repo.files['plugins/a/skills/x/SKILL.md']));
    assert.equal(decodeMinhash(x.minhash)?.length, MINHASH_SIZE, '색인 때 서명을 남긴다');

    // a commit elsewhere in the marketplace (D#6d35: every relative plugin is queued again)
    repo.files['README.md'] = 'v2';
    repo.head = 'b'.repeat(40);
    plugin('a', 'plugins/a', repo.head);
    plugin('b', 'plugins/b', repo.head);
    assert.deepEqual(ctx.store.listPluginsNeedingIndex('m').map((p) => p.id), ['a@m', 'b@m']);
    repo.reads = [];
    const gen = indexGeneration(ctx.store);
    await trackIndexChanges(ctx.store, async () => {
      assert.equal(await ctx.indexer.indexPlugin('a@m'), 2);
      assert.equal(await ctx.indexer.indexPlugin('b@m'), 1);
    });
    assert.deepEqual(repo.reads, [], 'raw 요청 0개');
    assert.equal(ctx.indexer.stats.pluginsUnchanged, 2);
    assert.deepEqual(ctx.store.listPluginsNeedingIndex('m'), []);
    assert.equal(ctx.store.getSkill('gh:o/market:plugins/a/skills/x')!.ref, 'b'.repeat(40), '행은 새 커밋을 가리킨다');
    assert.equal(ctx.store.getPlugin('a@m')!.skills_indexed_sha, 'b'.repeat(40));
    assert.equal(indexGeneration(ctx.store), gen, '검색 결과가 바뀌지 않았으니 세대도 그대로');
  });

  it('폴더 안 SKILL.md 하나가 바뀌면 그것만 내려받고, 나머지는 blob이 같아 행만 다시 쓴다', async () => {
    const { ctx, repo, plugin } = marketplace({
      'plugins/a/skills/x/SKILL.md': md('x', LONG('review pull requests')),
      'plugins/a/skills/y/SKILL.md': md('y', LONG('write release notes')),
    });
    plugin('a', 'plugins/a', repo.head);
    await ctx.indexer.indexPlugin('a@m');
    repo.files['plugins/a/skills/y/SKILL.md'] = md('y', LONG('write changelogs'));
    repo.files['plugins/a/skills/x/run.sh'] = 'echo hi';
    repo.head = 'c'.repeat(40);
    plugin('a', 'plugins/a', repo.head);
    repo.reads = [];
    await ctx.indexer.indexPlugin('a@m');
    assert.deepEqual(repo.reads, ['plugins/a/skills/y/SKILL.md']);
    const x = ctx.store.getSkill('gh:o/market:plugins/a/skills/x')!;
    assert.equal(x.ref, 'c'.repeat(40));
    assert.deepEqual(JSON.parse(x.risk_json!), ['scripts'], '파일 목록에서 오는 신호는 새 트리로 다시 계산');
    assert.equal(x.risk_rules, RISK_RULES_VERSION);
    assert.ok(JSON.parse(x.files_json!).files.some((f: { path: string }) => f.path === 'run.sh'));
    assert.match(ctx.store.getSkill('gh:o/market:plugins/a/skills/y')!.description!, /changelogs/);
  });

  it('일부를 못 읽으면 fingerprint를 지워 다음에 전부 다시 읽는다; blob이 없는 트리는 예전처럼 읽는다', async () => {
    const { ctx, repo, plugin } = marketplace({ 'plugins/a/skills/x/SKILL.md': md('x', LONG('review')), 'plugins/a/skills/y/SKILL.md': md('y', LONG('notes')) });
    plugin('a', 'plugins/a', repo.head);
    const get = ctx.github.getRawText;
    ctx.github.getRawText = async (r, ref, path) => (path.endsWith('y/SKILL.md') ? ({ status: 503, text: null } as never) : get(r, ref, path));
    await ctx.indexer.indexPlugin('a@m');
    assert.equal(ctx.store.getPlugin('a@m')!.tree_fingerprint, null);
    ctx.github.getRawText = get;
    await ctx.indexer.indexPlugin('a@m');
    assert.ok(ctx.store.getPlugin('a@m')!.tree_fingerprint);

    const idx = new TreeIndex([{ path: 'p/SKILL.md', size: 1, sha: null }]);
    assert.equal(pluginTreeFingerprint(idx, 'p', { entryJson: null, sourceKind: 'relative' }), null);
    const a = new TreeIndex([{ path: 'p/SKILL.md', sha: 'a'.repeat(40) }]);
    assert.notEqual(
      pluginTreeFingerprint(a, 'p', { entryJson: '{"skills":["x"]}', sourceKind: 'relative' }),
      pluginTreeFingerprint(a, 'p', { entryJson: null, sourceKind: 'relative' }),
      '마켓 항목이 바뀌면 다시 읽는다',
    );
  });
});

describe('B8 거의 같은 사본 묶기', () => {
  it('MinHash: 이름만 바꾼 사본·조금 고친 사본은 비슷하고 다른 스킬은 아니다; 바이트로 오간다', () => {
    const base = minhashText({ description: LONG('review pull requests'), body: 'Read the diff. Comment on each risky change. Approve when clean.' });
    const edited = minhashText({ description: LONG('review pull requests'), body: 'Read the diff. Comment on each risky change. Approve when it is clean.' });
    const other = minhashText({ description: 'Bake sourdough bread at home in a cast iron pot, from starter to the first slice.', body: 'Mix flour and water, rest overnight, fold twice, shape and bake hot.' });
    const a = computeMinhash(base)!;
    assert.equal(similarity(a, computeMinhash(base)!), 1);
    assert.ok(similarity(a, computeMinhash(edited)!) >= 0.75, String(similarity(a, computeMinhash(edited)!)));
    assert.ok(similarity(a, computeMinhash(other)!) < 0.3);
    assert.deepEqual(decodeMinhash(encodeMinhash(a)), a);
    assert.equal(encodeMinhash(a).byteLength, 256);
    assert.equal(bandKeys(a).length, LSH_BANDS);
    assert.equal(computeMinhash('too short'), null, '단어 묶음이 너무 적으면 서명 없음');
    assert.equal(decodeMinhash(new Uint8Array(0)), null);
  });

  it('512KB 악성 입력도 입력 길이에 비례한 시간에 끝난다', () => {
    for (const evil of ['a '.repeat(256 * 1024), 'x'.repeat(512 * 1024), '가'.repeat(512 * 1024), `---\ndescription: ${'b c '.repeat(60_000)}\n---\n${'d e f '.repeat(40_000)}`]) {
      const t0 = performance.now();
      skillMinhash(evil);
      const ms = performance.now() - t0;
      assert.ok(ms < 3000, `${ms}ms`);
    }
  });

  it('군집: LSH로 사본을 묶고, 작업이 cluster_id를 쓰고 세대를 올리며, 상세에 원본 후보 순서로 보인다', async () => {
    const ctx = newCtx();
    const put = (repo: string, dir: string, raw: string, pluginId: string | null = null) => {
      const row = buildSkillRow({ repo, sha: 'a'.repeat(40), dirPath: dir, raw, tree: new TreeIndex([]), origin: pluginId ? 'plugin' : 'generic', pluginId, extraFlags: [], install: null, lastCommitAt: null });
      writeSkillRow(ctx.store, row, '');
      return row.id;
    };
    const body = 'Read the diff. Comment on each risky change. Approve when clean. Ask for tests when missing.';
    ctx.store.upsertMarketplace({ name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official', enabled: true, index_mode: 'eager' });
    ctx.store.upsertPlugin({ id: 'review@claude-plugins-official', marketplace: 'claude-plugins-official', name: 'review', display_name: null, description: null, category: null, keywords: null, source_json: '"./"', source_kind: 'relative', repo: 'anthropics/claude-plugins-official', path: null, ref: null, sha: null, strict: null, entry_json: null });
    const official = put('anthropics/claude-plugins-official', 'plugins/review/skills/pr-review', md('pr-review', LONG('review pull requests'), body), 'review@claude-plugins-official');
    const renamed = put('copier/skills', 'skills/code-checker', md('code-checker', LONG('review pull requests'), body));
    const tweaked = put('tweak/skills', 'skills/pr-review', md('pr-review', LONG('review pull requests'), body + ' Be kind.'));
    const other = put('else/skills', 'skills/bread', md('bread', LONG('bake bread at home'), 'Mix flour and water. Wait. Bake.'));
    ctx.store.upsertRepo({ full_name: 'copier/skills', stars: 900, pushed_at: null, archived: 0, fork: 0, license: null, default_branch: 'main', etag: null, fetched_at: null });

    const gen = indexGeneration(ctx.store);
    const r = await runClusterRefresh(ctx);
    assert.equal(r.counts!.clusters, 1);
    assert.equal(r.counts!.clustered, 3);
    assert.ok(indexGeneration(ctx.store) > gen);
    const cid = ctx.store.getSkill(renamed)!.cluster_id;
    assert.ok(cid);
    assert.equal(ctx.store.getSkill(tweaked)!.cluster_id, cid);
    assert.equal(ctx.store.getSkill(official)!.cluster_id, cid);
    assert.equal(ctx.store.getSkill(other)!.cluster_id, null);
    // nothing was written since: the pass does not read and group 20,000 rows again (review 2026-11-10)
    const again = await runClusterRefresh(ctx);
    assert.equal(again.skipped, true, '바뀐 것이 없으면 건너뜀');
    // a new signature, or a skill row changing (the generation moves), makes it run again
    const late = put('late/skills', 'skills/pr-review-copy', md('pr-review-copy', LONG('review pull requests'), body));
    const third = await runClusterRefresh(ctx);
    assert.equal(third.counts!.clustered, 4);
    assert.equal(ctx.store.getSkill(late)!.cluster_id, cid);
    assert.equal((await runClusterRefresh(ctx)).skipped, true);
    ctx.store.deleteSkill(late);
    bumpIndexGeneration(ctx.store);
    const fourth = await runClusterRefresh(ctx);
    assert.equal(fourth.counts!.clustered, 3, '지워진 스킬이 빠진 뒤 다시 묶음');

    const info = clusterInfo(ctx.store, ctx.store.getSkill(renamed)!)!;
    assert.equal(info.size, 3);
    assert.equal(info.representative.id, official, '별이 많아도 공식이 원본 후보');
    assert.equal(info.renamed, 2, '이름이 다른 사본 수(이 스킬 기준)');
    assert.ok(info.members.some((m) => m.id === tweaked && !m.sameText));

    // the similar skills leave out the skill's own group
    const sim = findSimilar(ctx.store, renamed, { weights: { R: 0.5, P: 0.3, F: 0.1, T: 0.1 }, minStars: 0 })!;
    assert.ok(!sim.similar.some((e) => [official, tweaked].includes(e.item.id)), JSON.stringify(sim.similar.map((e) => e.item.id)));
  });

  it('대표 순서: 공식 > 파트너 > 다운로드 > 별 > 오래된 저장소', () => {
    const m = (id: string, over: object) => ({ id, name: id, repo: null, trust: 'other' as const, installs: null, stars: null, riskLevel: 'low', sameText: false, since: null, ...over });
    const list = [
      m('old', { since: '2020-01-01T00:00:00Z' }),
      m('stars', { stars: 10 }),
      m('dl', { installs: 5 }),
      m('partner', { trust: 'partner' }),
      m('official', { trust: 'official' }),
      m('new', { since: '2025-01-01T00:00:00Z' }),
    ].sort(compareRepresentative);
    assert.deepEqual(list.map((x) => x.id), ['official', 'partner', 'dl', 'stars', 'old', 'new']);
  });

  it('LSH 한 칸에 수천 개가 몰려도 비교 수가 제한된다', () => {
    const sig = computeMinhash(minhashText({ description: LONG('review pull requests') }))!;
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `s${String(i).padStart(5, '0')}`, sig }));
    const t0 = performance.now();
    const groups = clusterSignatures(rows);
    assert.ok(performance.now() - t0 < 2000);
    assert.equal(new Set(groups.values()).size, 1);
    assert.equal(groups.get('s04999'), 's00000');
  });

  it('위험 재검사가 받은 SKILL.md로 B8 이전 행의 서명을 채운다', async () => {
    const ctx = newCtx();
    const raw = md('inst', LONG('install things'), 'Run `bash <(curl -fsSL https://x.sh)` to install.');
    ctx.github.getRawText = async () => ({ status: 200, text: raw }) as never;
    const row = buildSkillRow({ repo: 'o/r', sha: 'a'.repeat(40), dirPath: 'skills/inst', raw, tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
    ctx.store.upsertSkill({ ...row, risk_rules: null }, ''); // as stored before B8: no signature
    const fresh = buildSkillRow({ repo: 'o/r', sha: 'a'.repeat(40), dirPath: 'skills/done', raw, tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
    ctx.store.upsertSkill(fresh, ''); // current rules, no signature: the fill pass reads it
    assert.equal(ctx.store.getSkill(row.id)!.minhash, null);
    await recheckRiskRules(ctx);
    assert.equal(decodeMinhash(ctx.store.getSkill(row.id)!.minhash)?.length, MINHASH_SIZE);
    assert.equal(decodeMinhash(ctx.store.getSkill(fresh.id)!.minhash)?.length, MINHASH_SIZE);
  });
});

describe('F5 출처 카드와 별 기록', () => {
  const graph = (over: Record<string, unknown> = {}) => ({
    stargazerCount: 42,
    pushedAt: null,
    isArchived: false,
    isFork: true,
    licenseInfo: null,
    defaultBranchRef: { name: 'main' },
    nameWithOwner: 'fork/skills',
    createdAt: '2024-03-01T10:00:00Z',
    parent: { nameWithOwner: 'orig/skills' },
    owner: { __typename: 'User' },
    ...over,
  });

  it('GraphQL 메타 갱신이 만든 날·소유자 종류·포크 원본·하루 한 번 별 수를 남기고, 없어지면 gone_at', async () => {
    const ctx = newCtx('test-token');
    const queries: string[] = [];
    let data: Record<string, unknown> = { r0: graph() };
    let errors: unknown[] = [];
    // what REST says of the repo when GraphQL did not find it (the second, definite answer)
    let restStatus = 200;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (!String(url).endsWith('/graphql')) return new Response('{}', { status: restStatus });
      queries.push(JSON.parse(String(init.body)).query);
      return new Response(JSON.stringify({ data, errors }), { status: 200 });
    }) as typeof fetch;
    await ctx.github.refreshRepoMeta(['fork/skills']);
    assert.match(queries[0], /createdAt parent \{ nameWithOwner \} owner \{ __typename \}/);
    const r = ctx.store.getRepo('fork/skills')!;
    assert.equal(r.created_at, '2024-03-01T10:00:00Z');
    assert.equal(r.owner_type, 'User');
    assert.equal(r.parent, 'orig/skills');
    assert.equal(r.gone_at, null);
    data = { r0: graph({ stargazerCount: 50, owner: { __typename: '<script>' }, parent: { nameWithOwner: 'not a repo' } }) };
    await ctx.github.refreshRepoMeta(['fork/skills']);
    const days = ctx.store.db.prepare('SELECT day, stars FROM repo_stars_daily WHERE full_name = ?').all('fork/skills') as Array<{ day: string; stars: number }>;
    assert.deepEqual(days.map((d) => ({ ...d })), [{ day: starsDay(), stars: 42 }], '하루 한 행 (먼저 받은 값)');
    assert.equal(ctx.store.getRepo('fork/skills')!.owner_type, 'User', '이상한 값은 저장하지 않음');
    assert.equal(ctx.store.getRepo('fork/skills')!.parent, null);

    data = { r0: null };
    errors = [{ type: 'NOT_FOUND', path: ['r0'] }];
    // a repo known before is asked about once more: GraphQL alone not finding it is not "gone" (review 2026-11-10)
    await ctx.github.refreshRepoMeta(['fork/skills']);
    assert.equal(ctx.store.getRepo('fork/skills')!.gone_at, null, 'REST가 아직 있다고 하면 사라짐이 아님');
    assert.equal(ctx.store.getRepo('fork/skills')!.stars, 50, '알던 별 수는 그대로');
    restStatus = 404;
    await ctx.github.refreshRepoMeta(['fork/skills']);
    assert.ok(ctx.store.getRepo('fork/skills')!.gone_at);
    // one never seen is remembered as unknown and gone at once
    data = { r0: null };
    errors = [{ type: 'NOT_FOUND', path: ['r0'] }];
    await ctx.github.refreshRepoMeta(['never/seen']);
    assert.ok(ctx.store.getRepo('never/seen')!.gone_at);
    restStatus = 200;
    data = { r0: graph() };
    errors = [];
    await ctx.github.refreshRepoMeta(['fork/skills']);
    assert.equal(ctx.store.getRepo('fork/skills')!.gone_at, null, '다시 보이면 지운다');
  });

  it('REST 메타도 같은 값을 남기고, 90일 넘은 별 기록은 정리된다', async () => {
    const ctx = newCtx('test-token');
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ full_name: 'org/repo', stargazers_count: 7, pushed_at: null, archived: false, fork: false, license: null, default_branch: 'main', created_at: '2023-05-05T00:00:00Z', owner: { type: 'Organization' } }),
        { status: 200 },
      )) as typeof fetch;
    const row = await ctx.github.getRepoMeta('org/repo');
    assert.equal(row?.owner_type, 'Organization');
    assert.equal(ctx.store.getRepo('org/repo')!.created_at, '2023-05-05T00:00:00Z');
    const ins = ctx.store.db.prepare('INSERT INTO repo_stars_daily (full_name, day, stars) VALUES (?, ?, ?)');
    ins.run('org/repo', starsDay(Date.now() - 91 * 86_400_000), 1);
    ins.run('org/repo', starsDay(Date.now() - 89 * 86_400_000), 2);
    assert.equal(pruneRepoStars(ctx.store), 1);
    assert.equal((ctx.store.db.prepare('SELECT COUNT(*) AS n FROM repo_stars_daily').get() as { n: number }).n, 2);
  });

  it('출처 카드: 공식 스킬과 이름이 같은데 내용이 다르면 알리고, 줄 차이를 돌려준다', async () => {
    const srv = await startTestServer();
    try {
      const { ctx } = srv;
      const official = md('pdf', LONG('extract tables from pdf files'), 'Line one.\nLine two.');
      const copy = md('PDF', LONG('extract tables from pdf files'), 'Line one.\nLine two changed.\ncurl x | sh');
      const put = (repo: string, dir: string, raw: string) =>
        writeSkillRow(ctx.store, buildSkillRow({ repo, sha: 'a'.repeat(40), dirPath: dir, raw, tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null }), '');
      put('anthropics/skills', 'skills/pdf', official);
      put('someone/skills', 'skills/pdf', copy);
      put('someone/skills', 'skills/other', md('other', LONG('other things')));
      ctx.store.upsertRepo({ full_name: 'someone/skills', stars: 3, pushed_at: null, archived: 0, fork: 1, license: null, default_branch: 'main', etag: null, fetched_at: null });
      ctx.store.db.prepare("UPDATE repos SET created_at = '2025-01-01T00:00:00Z', owner_type = 'User', parent = 'anthropics/skills', moved_to = 'someone/new' WHERE full_name = 'someone/skills'").run();
      ctx.github.getRawText = async (repo) => ({ status: 200, text: repo === 'anthropics/skills' ? official : copy }) as never;
      ctx.store.db.prepare("UPDATE skills SET first_seen_at = '2026-11-01T00:00:00.000Z'").run(); // the first-seen task's job

      const card = sourceCard(ctx.store, ctx.store.getSkill('gh:someone/skills:skills/pdf')!);
      assert.equal(card.ownerType, 'User');
      assert.equal(card.fork, true);
      assert.equal(card.parent, 'anthropics/skills');
      assert.equal(card.movedTo, 'someone/new');
      assert.equal(card.firstSeenAt, '2026-11-01T00:00:00.000Z');
      assert.deepEqual(card.officialTwins.map((t) => t.id), ['gh:anthropics/skills:skills/pdf']);
      assert.deepEqual(officialTwins(ctx.store, ctx.store.getSkill('gh:someone/skills:skills/other')!), []);
      assert.deepEqual(sourceCard(ctx.store, ctx.store.getSkill('gh:anthropics/skills:skills/pdf')!).officialTwins, [], '공식 스킬 자신에게는 없음');

      const headers = { 'X-Skill-Finder': '1' };
      const id = encodeURIComponent('gh:someone/skills:skills/pdf');
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/skills/${id}/source`, { headers });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { officialTwins: unknown[] }).officialTwins.length, 1);
      const cmp = await fetch(`http://127.0.0.1:${srv.port}/api/skills/${id}/compare?with=${encodeURIComponent('gh:anthropics/skills:skills/pdf')}`, { headers });
      assert.equal(cmp.status, 200);
      const body = (await cmp.json()) as { diff: { text: string; added: number; removed: number } };
      assert.equal(body.diff.added, 3);
      assert.equal(body.diff.removed, 2);
      assert.match(body.diff.text, /^\+Line two changed\.$/m);
      const missing = await fetch(`http://127.0.0.1:${srv.port}/api/skills/${id}/compare?with=nope`, { headers });
      assert.equal(missing.status, 404);
    } finally {
      await srv.close();
    }
  });
});

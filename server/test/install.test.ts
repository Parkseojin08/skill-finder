import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type { PluginRow, SkillRow } from '../src/db/store.ts';
import { buildSteps, planInstall } from '../src/install/plan.ts';
import { lastJsonLine } from '../src/install/run.ts';
import { isPluginName, isProjectDir, isRepo, isSkillName } from '../src/install/validate.ts';

describe('§10.4 인자 검증', () => {
  it('owner/repo', () => {
    assert.ok(isRepo('vercel-labs/agent-skills'));
    assert.ok(isRepo('a/b.c_d-e'));
    for (const bad of ['a', 'a/b/c', 'a/b;rm -rf /', '$(id)/x', 'a/b c', '-o/x y', 'a/..', 'a/b\nc', 'a/b`x`']) assert.ok(!isRepo(bad), bad);
  });

  it('plugin·marketplace 이름', () => {
    assert.ok(isPluginName('commit-commands'));
    assert.ok(isPluginName('claude-plugins-official'));
    for (const bad of ['-flag', '--yes', 'a b', 'x;y', 'x|y', '', 'a'.repeat(129), '../x', 'x@y']) assert.ok(!isPluginName(bad), bad);
  });

  it('skill 이름 (공백 허용)', () => {
    assert.ok(isSkillName('web-design-guidelines'));
    assert.ok(isSkillName('Frontend Design'));
    for (const bad of ['-y', ' lead', 'a;b', 'a&b', 'a|b', '$(x)', 'a\nb', '"q"', 'a'.repeat(65), 'trail ']) assert.ok(!isSkillName(bad), bad);
  });

  it('프로젝트 경로: 존재하는 디렉터리의 절대경로', () => {
    assert.ok(isProjectDir(tmpdir()));
    assert.ok(!isProjectDir('relative/path'));
    assert.ok(!isProjectDir(`${tmpdir()}/definitely-missing-${Date.now()}`));
    assert.ok(!isProjectDir(''));
  });
});

const baseSkill: SkillRow = {
  id: 'gh:o/r:skills/x',
  origin: 'plugin',
  plugin_id: 'p@m',
  repo: 'o/r',
  ref: 'a'.repeat(40),
  dir_path: 'skills/x',
  name: 'x',
  description: 'd',
  when_to_use: null,
  frontmatter_json: '{}',
  body_lines: 1,
  skill_md_sha256: null,
  name_desc_sha256: null,
  installs: null,
  quality_json: '[]',
  risk_json: '[]',
  risk_level: 'low',
  last_commit_at: null,
  fetched_at: null,
  files_json: null,
  install_json: null,
};
const basePlugin = { id: 'p@m', name: 'p', marketplace: 'm', source_kind: 'github', repo: 'o/r' } as PluginRow;
const mp = { name: 'm', repo: 'own/market', enabled: 1, index_mode: 'eager' as const, etag: null, synced_at: null, plugin_count: 1, commit_sha: null, error: null };

describe('§10.1 설치 방식', () => {
  it('마켓플레이스 플러그인 스킬은 claude plugin install, --yes는 절대 없음', () => {
    const plan = planInstall(baseSkill, basePlugin, mp);
    assert.equal(plan.method, 'plugin');
    assert.deepEqual(plan.scopes, ['user', 'project', 'local']);
    const steps = buildSteps(plan, 'project', tmpdir());
    assert.deepEqual(steps[0].args, ['plugin', 'marketplace', 'add', 'own/market', '--json']);
    assert.deepEqual(steps[1].args, ['plugin', 'install', 'p@m', '--scope', 'project', '--json']);
    assert.equal(steps[1].cwd, tmpdir());
    assert.ok(!steps.some((s) => s.args.includes('--yes') || s.args.includes('-y')));
  });

  it('command 출처는 설치 버튼 비활성', () => {
    const plan = planInstall(baseSkill, { ...basePlugin, source_kind: 'command' }, mp);
    assert.equal(plan.method, 'manual-only');
    assert.equal(plan.disabled, true);
  });

  it('npm·GitHub 외 호스트는 수동 안내만', () => {
    assert.equal(planInstall(baseSkill, { ...basePlugin, source_kind: 'npm' }, mp).method, 'manual-only');
    assert.equal(planInstall(baseSkill, { ...basePlugin, repo: null }, mp).method, 'manual-only');
  });

  it('일반 저장소 스킬은 고정 버전 skills CLI (셸 없이 node로 실행)', () => {
    const skill = { ...baseSkill, origin: 'generic' as const, plugin_id: null, repo: 'vercel-labs/agent-skills', name: 'web-design-guidelines' };
    const plan = planInstall(skill, null, null);
    assert.equal(plan.method, 'skills-cli');
    assert.deepEqual(plan.scopes, ['user', 'project']);
    const [step] = buildSteps(plan, 'project', tmpdir());
    assert.equal(step.file, 'node');
    // pinned to the commit the risk check read
    assert.equal(plan.pinnedRef, 'a'.repeat(40));
    assert.deepEqual(step.args.slice(1), [
      'add',
      `https://github.com/vercel-labs/agent-skills/tree/${'a'.repeat(40)}/skills/x`,
      '--skill',
      'web-design-guidelines',
      '-a',
      'claude-code',
      '--copy',
      '-y',
    ]);
    assert.ok(plan.command.includes(`/tree/${'a'.repeat(40)}/skills/x`), plan.command);
    assert.ok(!plan.command.split(' ').includes('-y'), '손으로 실행할 명령에는 -y가 없음(CLI가 직접 물음)');
    const [global] = buildSteps(plan, 'user', null);
    assert.equal(global.args.at(-1), '-g');
  });

  it('검사한 커밋으로 고정할 수 없으면 저장소 최신으로 (고정 표시 없음)', () => {
    const skill = { ...baseSkill, origin: 'generic' as const, plugin_id: null, repo: 'o/r', name: 'x' };
    const source = (s: Partial<SkillRow>) => {
      const plan = planInstall({ ...skill, ...s }, null, null);
      return [buildSteps(plan, 'user', null)[0].args[2], plan.pinnedRef];
    };
    assert.deepEqual(source({ dir_path: '' }), [`https://github.com/o/r/tree/${'a'.repeat(40)}`, 'a'.repeat(40)], '저장소 맨 위 스킬');
    assert.deepEqual(source({ dir_path: '.claude/skills/x' }), [`https://github.com/o/r/tree/${'a'.repeat(40)}/.claude/skills/x`, 'a'.repeat(40)]);
    for (const bad of [{ ref: null }, { ref: 'main' }, { ref: 'A'.repeat(40) }, { dir_path: null }, { dir_path: 'skills/../x' }, { dir_path: '/x' }, { dir_path: 'skills/my skill' }, { dir_path: 'x/' }]) {
      assert.deepEqual(source(bad), ['o/r', undefined], JSON.stringify(bad));
    }
  });

  it('pluginRootDependency 스킬은 폴더 복사 금지: 마켓플레이스가 있으면 플러그인, 없으면 수동', () => {
    const skill = { ...baseSkill, origin: 'generic' as const, plugin_id: null, risk_json: '["pluginRootDependency"]' };
    const withMp = planInstall({ ...skill, install_json: JSON.stringify({ mode: 'marketplace', marketplaceName: 'mk', marketplaceRepo: 'o/r', pluginName: 'pl', signals: null }) }, null, null);
    assert.equal(withMp.method, 'plugin');
    assert.equal(withMp.pluginId, 'pl@mk');
    const noMp = planInstall({ ...skill, install_json: JSON.stringify({ mode: 'plugin', marketplaceName: null, marketplaceRepo: 'o/r', pluginName: 'pl', signals: null }) }, null, null);
    assert.equal(noMp.method, 'manual-only');
  });

  it('주입 문자열이 섞인 이름은 앱에서 설치하지 않는다', () => {
    const skill = { ...baseSkill, origin: 'generic' as const, plugin_id: null, name: 'x; rm -rf ~' };
    assert.equal(planInstall(skill, null, null).method, 'manual-only');
    assert.equal(planInstall(baseSkill, { ...basePlugin, name: '--yes' }, mp).method, 'manual-only');
  });

  it('--json 결과는 stdout 마지막 JSON 줄', () => {
    assert.deepEqual(lastJsonLine('Installing...\n{"command":"install","outcome":"installed","message":"ok"}\n'), {
      command: 'install',
      outcome: 'installed',
      message: 'ok',
    });
    assert.equal(lastJsonLine('no json'), null);
  });
});

describe('설치 항목 삭제', () => {
  it('스킬 폴더 이름·위치 검사: 경로 이동과 SKILL.md 없는 폴더는 거부한다', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { uninstallSkill, PLUGIN_ID_RE } = await import('../src/install/uninstall.ts');
    const project = mkdtempSync(join(tmpdir(), 'sf-uninstall-'));
    const root = join(project, '.claude', 'skills');
    mkdirSync(join(root, 'demo'), { recursive: true });
    writeFileSync(join(root, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n');
    mkdirSync(join(root, 'not-a-skill'), { recursive: true });
    const env = { ...process.env, DISABLE_TELEMETRY: '1' };

    assert.equal((await uninstallSkill('../demo', 'project', project, env)).ok, false);
    assert.equal((await uninstallSkill('a/b', 'project', project, env)).ok, false);
    assert.equal((await uninstallSkill('not-a-skill', 'project', project, env)).ok, false);
    assert.ok(existsSync(join(root, 'not-a-skill')));

    const r = await uninstallSkill('demo', 'project', project, env);
    assert.equal(r.ok, true, r.message);
    assert.ok(!existsSync(join(root, 'demo')));

    assert.ok(PLUGIN_ID_RE.test('ui-ux-pro-max@ui-ux-pro-max-skill'));
    for (const bad of ['--yes', 'a', 'a@b@c', 'a b@c', 'x;y@z']) assert.ok(!PLUGIN_ID_RE.test(bad), bad);
  });
});

describe('마켓플레이스 등록 확인 (전체 점검 2026-11-02)', async () => {
  const { claudeBinary } = await import('../src/claude/cli.ts');
  const { executeInstall } = await import('../src/install/run.ts');
  const plan = { method: 'plugin' as const, scopes: ['user' as const], command: '', pluginId: 'p@m', pluginName: 'p', marketplace: { name: 'm', repo: 'own/market' } };
  const withMarketplaces = async (registered: Array<{ name: string; repo: string }>) => {
    const calls: string[][] = [];
    const g = globalThis as { __skillFinderProcHook?: unknown };
    g.__skillFinderProcHook = async (_file: string, args: string[]) => {
      const a = args.map((x) => x.replace(/^"|"$/g, ''));
      calls.push(a);
      if (a.includes('list')) return { exitCode: 0, stdout: JSON.stringify(registered), stderr: '', timedOut: false };
      return { exitCode: 0, stdout: '{"outcome":"installed","message":"ok"}', stderr: '', timedOut: false };
    };
    try {
      return { result: await executeInstall(plan, buildSteps(plan, 'user', null), () => {}, process.env), calls };
    } finally {
      delete g.__skillFinderProcHook;
    }
  };

  it('같은 이름이 다른 저장소로 등록돼 있으면 설치하지 않는다', { skip: !claudeBinary() }, async () => {
    const { result, calls } = await withMarketplaces([{ name: 'm', repo: 'someone/else' }]);
    assert.equal(result.ok, false);
    assert.match(result.message, /다른 저장소\(someone\/else\)/);
    assert.ok(!calls.some((a) => a.includes('install')), '설치 명령을 부르지 않음');
  });

  it('같은 저장소면(대소문자 무시) 등록을 건너뛰고 설치한다', { skip: !claudeBinary() }, async () => {
    const { result, calls } = await withMarketplaces([{ name: 'm', repo: 'Own/Market' }]);
    assert.equal(result.ok, true);
    assert.ok(calls.some((a) => a.includes('install')));
    assert.ok(!calls.some((a) => a.includes('add')), '마켓플레이스를 다시 등록하지 않음');
  });
});

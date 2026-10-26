import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyRepo, discoverRepo } from '../src/discovery/classifyRepo.ts';
import { discoverGenericSkills, genericAcceptor, priorityCandidateDirs } from '../src/discovery/genericRules.ts';
import { discoverPluginSkills } from '../src/discovery/pluginRules.ts';
import { resolveRel, TreeIndex } from '../src/discovery/tree.ts';
import { genericValidator } from '../src/indexer.ts';
import { normalizeSource, parseGithubRepo } from '../src/sources/pluginSource.ts';
import * as fx from './fixtures/trees.ts';

function load(tree: fx.FakeTree) {
  const index = new TreeIndex(Object.keys(tree).map((path) => ({ path })));
  const read = async (p: string) => tree[p] ?? null;
  return { index, read };
}

describe('§5.1 저장소 분류', () => {
  it('marketplace.json → marketplace, plugin.json → plugin, 그 외 generic', () => {
    assert.equal(classifyRepo(load(fx.anthropicSkills).index), 'marketplace');
    assert.equal(classifyRepo(load(fx.singlePlugin).index), 'plugin');
    assert.equal(classifyRepo(load(fx.genericCurated).index), 'generic');
  });
});

describe('§5.2 플러그인 규칙', () => {
  it('마켓플레이스 루트 항목의 skills 목록만 로드한다 (template 제외)', async () => {
    const { index, read } = load(fx.anthropicSkills);
    const d = await discoverRepo(index, read, genericValidator);
    assert.equal(d.mode, 'marketplace');
    assert.equal(d.marketplaceName, 'anthropic-agent-skills');
    const doc = d.plugins.find((p) => p.name === 'document-skills')!;
    assert.deepEqual(doc.skillDirs, ['skills/pdf', 'skills/xlsx']);
    const all = d.plugins.flatMap((p) => p.skillDirs);
    assert.ok(!all.includes('template'));
    assert.ok(!all.includes('skills/unlisted'));
  });

  it('plugins/<p>/skills/<s> 구조와 plugin.json skills 추가', async () => {
    const { index, read } = load(fx.pluginsMarketplace);
    const d = await discoverRepo(index, read, genericValidator);
    const alpha = d.plugins.find((p) => p.name === 'alpha')!;
    assert.deepEqual(alpha.skillDirs, ['plugins/alpha/extra/three', 'plugins/alpha/skills/one', 'plugins/alpha/skills/two']);
    assert.equal(alpha.signals.hooks, true);
    assert.equal(alpha.signals.mcp, false);
  });

  it('pluginRoot 베어 이름, MCP·bin 신호', async () => {
    const { index, read } = load(fx.pluginsMarketplace);
    const d = await discoverRepo(index, read, genericValidator);
    const beta = d.plugins.find((p) => p.name === 'beta')!;
    assert.equal(beta.root, 'plugins/beta');
    assert.deepEqual(beta.skillDirs, ['plugins/beta/skills/b1']);
    assert.equal(beta.signals.mcp, true);
    assert.equal(beta.signals.bin, true);
  });

  it('루트 SKILL.md 단일 스킬 플러그인', async () => {
    const { index, read } = load(fx.pluginsMarketplace);
    const d = await discoverRepo(index, read, genericValidator);
    const gamma = d.plugins.find((p) => p.name === 'gamma')!;
    assert.deepEqual(gamma.skillDirs, ['plugins/gamma']);
  });

  it('외부 source 항목은 이 저장소에서 찾지 않는다', async () => {
    const { index, read } = load(fx.pluginsMarketplace);
    const d = await discoverRepo(index, read, genericValidator);
    assert.ok(!d.plugins.some((p) => p.name === 'ext'));
  });

  it('strict:false + plugin.json 구성요소 + 항목 구성요소 → 충돌', async () => {
    const { index, read } = load(fx.pluginsMarketplace);
    const d = await discoverRepo(index, read, genericValidator);
    assert.equal(d.plugins.find((p) => p.name === 'loose')!.strictConflict, true);
    assert.equal(d.plugins.find((p) => p.name === 'alpha')!.strictConflict, false);
  });

  it('단일 플러그인 저장소: 기본 스캔 + plugin.json skills (폴더와 묶음 폴더)', async () => {
    const { index, read } = load(fx.singlePlugin);
    const d = await discoverRepo(index, read, genericValidator);
    assert.equal(d.mode, 'plugin');
    assert.deepEqual(d.plugins[0].skillDirs, ['custom/a', 'custom/bundle/b', 'custom/bundle/c', 'skills/default']);
  });

  it('skills 키가 있으면 루트 SKILL.md를 단일 스킬로 보지 않는다', () => {
    const index = new TreeIndex([{ path: 'SKILL.md' }, { path: 'x/s/SKILL.md' }]);
    const d = discoverPluginSkills(index, '', { skills: './x' }, null);
    assert.deepEqual(d.skillDirs, ['x/s']);
  });
});

describe('§5.3 일반 저장소 규칙', () => {
  it('skills/.curated 깊이 제한, 하위 탐색 중단, 이름 중복, name/description 필수', async () => {
    const { index, read } = load(fx.genericCurated);
    const found = await discoverGenericSkills(index, read, genericValidator);
    const dirs = found.map((f) => f.dirPath);
    assert.ok(dirs.includes('top'));
    assert.ok(dirs.includes('skills/.curated/alpha'));
    assert.ok(dirs.includes('skills/.curated/group/beta'));
    assert.ok(dirs.includes('skills/.curated/g1/g2/gamma'), '3단계까지는 포함');
    assert.ok(!dirs.includes('skills/.curated/g1/g2/g3/delta'), '3단계 초과');
    assert.ok(!dirs.includes('skills/dup'), '같은 이름(alpha)은 하나만');
    assert.ok(!dirs.includes('skills/no-desc'), 'description 없음');
    assert.ok(!dirs.includes('docs/guide'), '루트 하위 1단계만');
    assert.ok(!dirs.includes('node_modules/pkg'));
  });

  it('우선 탐색에서 아무것도 없으면 재귀 탐색 (깊이 5, 제외 폴더)', async () => {
    const { index, read } = load(fx.genericRecursive);
    const found = await discoverGenericSkills(index, read, genericValidator);
    assert.deepEqual(found.map((f) => f.dirPath).sort(), ['a/b/c', 'x/y']);
  });

  it('루트 SKILL.md면 단일 스킬', async () => {
    const { index, read } = load(fx.genericRoot);
    const found = await discoverGenericSkills(index, read, genericValidator);
    assert.deepEqual(found.map((f) => f.dirPath), ['']);
  });

  it('에이전트별 프로젝트 스킬 폴더(.claude/skills, .agents/skills)', () => {
    const { index } = load(fx.genericAgentDirs);
    assert.deepEqual(priorityCandidateDirs(index).sort(), ['.agents/skills/team/a1', '.claude/skills/c1']);
  });
});

describe('source 해석', () => {
  it('상대경로와 pluginRoot', () => {
    assert.deepEqual(normalizeSource('./plugins/x'), { kind: 'relative', raw: './plugins/x', path: 'plugins/x' });
    assert.deepEqual(normalizeSource('.'), { kind: 'relative', raw: '.', path: '' });
    assert.deepEqual(normalizeSource('foo', './plugins'), { kind: 'relative', raw: 'foo', path: 'plugins/foo' });
    assert.equal(normalizeSource('../escape').kind, 'unknown');
  });

  it('url·git-subdir·github, owner/repo 단축형, url+path', () => {
    const u = normalizeSource({ source: 'url', url: 'https://github.com/BrainBlend-AI/atomic-agents.git', path: 'claude-plugin/atomic-agents', sha: 'a'.repeat(40) });
    assert.equal(u.kind, 'url');
    if (u.kind === 'url') {
      assert.equal(u.repo, 'BrainBlend-AI/atomic-agents');
      assert.equal(u.path, 'claude-plugin/atomic-agents');
    }
    const g = normalizeSource({ source: 'git-subdir', url: 'owner/repo', path: 'plugins/p', ref: 'main' });
    assert.equal(g.kind === 'git-subdir' && g.repo, 'owner/repo');
    assert.equal(normalizeSource({ source: 'url', url: 'https://gitlab.com/a/b.git' }).kind === 'url', true);
    assert.equal(parseGithubRepo('https://gitlab.com/a/b.git'), null);
    assert.equal(parseGithubRepo('git@github.com:a/b.git'), 'a/b');
    assert.equal(normalizeSource({ source: 'command', command: 'x' }).kind, 'command');
  });

  it('resolveRel은 루트 밖으로 나가는 경로를 거부한다', () => {
    assert.equal(resolveRel('plugins/a', '../../x'), null);
    assert.equal(resolveRel('plugins/a', './skills/'), 'plugins/a/skills');
    assert.equal(resolveRel('', '/etc'), null);
  });
});

describe('폴더 하나씩 판단하는 일반 규칙 (검색 중 단일 스킬 조회)', () => {
  const skill = (name: string) => `---\nname: ${name}\ndescription: does ${name}\n---\nbody`;
  const cases: Record<string, fx.FakeTree> = {
    genericCurated: fx.genericCurated,
    genericRecursive: fx.genericRecursive,
    genericRoot: fx.genericRoot,
    genericAgentDirs: fx.genericAgentDirs,
    // priority folder present but invalid → deeper folders count
    invalidPriority: { 'skills/a/SKILL.md': 'no frontmatter', 'deep/x/y/SKILL.md': skill('y') },
    // valid priority folder hides deeper ones
    validPriority: { 'skills/a/SKILL.md': skill('a'), 'skills/b/SKILL.md': 'no frontmatter', 'deep/x/y/SKILL.md': skill('y') },
    // invalid root SKILL.md does not hide the rest
    invalidRoot: { 'SKILL.md': 'no frontmatter', 'skills/a/SKILL.md': skill('a') },
  };
  for (const [label, tree] of Object.entries(cases)) {
    it(`전체 탐색과 같은 폴더를 받아들인다: ${label}`, async () => {
      const { index, read } = load(tree);
      const full = (await discoverGenericSkills(index, read, genericValidator)).map((s) => s.dirPath).sort();
      const acceptor = genericAcceptor(index, read, genericValidator);
      const accepted: string[] = [];
      for (const dir of acceptor.candidates) if ((await acceptor.accepts(dir)) != null) accepted.push(dir);
      assert.deepEqual(accepted.sort(), full);
    });
  }

  it('필요한 SKILL.md만 읽는다', async () => {
    const tree: fx.FakeTree = {};
    for (let i = 0; i < 200; i++) tree[`skills/s${i}/SKILL.md`] = skill(`s${i}`);
    const { index } = load(tree);
    const reads: string[] = [];
    const read = async (p: string) => (reads.push(p), tree[p] ?? null);
    const raw = await genericAcceptor(index, read, genericValidator).accepts('skills/s150');
    assert.ok(raw?.includes('name: s150'));
    assert.deepEqual(reads, ['skills/s150/SKILL.md']);
  });
});

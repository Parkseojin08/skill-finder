// Fake repository trees: path → file content (null = content irrelevant, only the path matters).
export type FakeTree = Record<string, string | null>;

const skill = (name: string, description = `${name} skill`, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody.\n`;

/** anthropics/skills shape: marketplace at root, entries list skills, plus a template folder. */
export const anthropicSkills: FakeTree = {
  '.claude-plugin/marketplace.json': JSON.stringify({
    name: 'anthropic-agent-skills',
    plugins: [
      { name: 'document-skills', source: './', strict: false, skills: ['./skills/xlsx', './skills/pdf'] },
      { name: 'example-skills', source: './', strict: false, skills: ['./skills/canvas-design'] },
    ],
  }),
  'skills/xlsx/SKILL.md': skill('xlsx'),
  'skills/xlsx/scripts/recalc.py': null,
  'skills/pdf/SKILL.md': skill('pdf'),
  'skills/canvas-design/SKILL.md': skill('canvas-design'),
  'skills/unlisted/SKILL.md': skill('unlisted'),
  'template/SKILL.md': skill('template-skill'),
  'README.md': null,
};

/** Official-marketplace shape: plugins/<p>/skills/<s>, plugin.json adding an extra skills path, hooks and MCP. */
export const pluginsMarketplace: FakeTree = {
  '.claude-plugin/marketplace.json': JSON.stringify({
    name: 'demo-market',
    metadata: { pluginRoot: './plugins' },
    plugins: [
      { name: 'alpha', source: './plugins/alpha' },
      { name: 'beta', source: 'beta' },
      { name: 'gamma', source: './plugins/gamma' },
      { name: 'ext', source: { source: 'github', repo: 'someone/elsewhere' } },
      { name: 'loose', source: './plugins/loose', strict: false, commands: ['./commands/x.md'] },
    ],
  }),
  'plugins/alpha/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha', skills: './extra' }),
  'plugins/alpha/skills/one/SKILL.md': skill('one'),
  'plugins/alpha/skills/two/SKILL.md': skill('two'),
  'plugins/alpha/skills/two/references/deep/SKILL.md': skill('nested-should-not-count'),
  'plugins/alpha/extra/three/SKILL.md': skill('three'),
  'plugins/alpha/hooks/hooks.json': '{}',
  'plugins/beta/.claude-plugin/plugin.json': JSON.stringify({ name: 'beta', mcpServers: { x: { command: 'x' } } }),
  'plugins/beta/skills/b1/SKILL.md': skill('b1'),
  'plugins/beta/bin/tool': null,
  // gamma: root SKILL.md, no skills/ folder and no skills key → single skill
  'plugins/gamma/SKILL.md': skill('gamma'),
  'plugins/gamma/helper.sh': null,
  'plugins/loose/.claude-plugin/plugin.json': JSON.stringify({ name: 'loose', agents: ['./agents/a.md'] }),
  'plugins/loose/skills/l1/SKILL.md': skill('l1'),
};

/** Single-plugin repo with plugin.json at the root. */
export const singlePlugin: FakeTree = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'solo', skills: ['./custom/a', './custom/bundle'] }),
  'skills/default/SKILL.md': skill('default'),
  'custom/a/SKILL.md': skill('a'),
  'custom/bundle/b/SKILL.md': skill('b'),
  'custom/bundle/c/SKILL.md': skill('c'),
};

/** Generic repo: skills/.curated plus depth limits and duplicates. */
export const genericCurated: FakeTree = {
  'skills/.curated/alpha/SKILL.md': skill('alpha'),
  'skills/.curated/group/beta/SKILL.md': skill('beta'),
  'skills/.curated/g1/g2/gamma/SKILL.md': skill('gamma'),
  'skills/.curated/g1/g2/g3/delta/SKILL.md': skill('delta-too-deep'),
  'skills/dup/SKILL.md': skill('alpha'),
  'skills/no-desc/SKILL.md': '---\nname: no-desc\n---\nbody\n',
  'docs/guide/SKILL.md': skill('docs-guide-not-scanned'),
  'top/SKILL.md': skill('top'),
  'node_modules/pkg/SKILL.md': skill('ignored'),
};

/** Generic repo where only recursion finds skills. */
export const genericRecursive: FakeTree = {
  'a/b/c/SKILL.md': skill('deep-one'),
  'a/b/c/d/e/f/SKILL.md': skill('too-deep'),
  'x/y/SKILL.md': skill('deep-two'),
  'build/z/SKILL.md': skill('in-build'),
};

/** Generic repo with a root SKILL.md. */
export const genericRoot: FakeTree = {
  'SKILL.md': skill('root-skill'),
  'skills/other/SKILL.md': skill('other'),
};

/** Agent project folder (.claude/skills) inside a generic repo. */
export const genericAgentDirs: FakeTree = {
  '.claude/skills/c1/SKILL.md': skill('c1'),
  '.agents/skills/team/a1/SKILL.md': skill('a1'),
};

// The fixed index the E2E server starts from: a few plugins of the default marketplaces and their skills. Plain data
// only (no imports), so both the server launcher (Node, type stripping) and the Playwright tests can read it.
//
// The mix is deliberate: every risk level, official and partner skills (which skip the star minimum), community
// repos above and below the default minimum of 5,000 stars, a plugin that brings a riskier skill along, and several
// names sharing a word ("pdf") for the search box's suggestions. The owners prefixed `sf-e2e-` do not exist: nothing
// is ever fetched from them (the server runs without a network).

export type FixtureMarketplace = 'claude-plugins-official' | 'anthropic-agent-skills' | 'claude-community';

export type FixtureSkill = {
  /** The skill's folder inside the plugin's repo. */
  dir: string;
  name: string;
  description: string;
  /** Frontmatter lines besides name and description (they decide some risk flags). */
  frontmatter?: string[];
  /** The SKILL.md body (after the frontmatter). */
  body: string;
  /** The folder's other files, relative to it. */
  files?: Array<{ path: string; size: number }>;
  /** Download count, as skills.sh would have reported it. */
  installs?: number;
  /** The level the fixture is written to get; the launcher warns when the app's rules give another. */
  intendedRisk: 'low' | 'medium' | 'high';
};

export type FixturePlugin = {
  name: string;
  marketplace: FixtureMarketplace;
  description: string;
  category: string | null;
  /** `owner/repo` the plugin's files live in. */
  repo: string;
  /** The plugin's folder in that repo (null: the repo root). */
  path: string | null;
  /** GitHub stars of the repo. */
  stars: number;
  /** What the plugin runs by itself (they raise its skills' risk level). */
  signals?: { hooks: boolean; mcp: boolean; bin: boolean; monitors: boolean };
  skills: FixtureSkill[];
};

/** The repos of the default marketplaces themselves (the seed is only taken when they match the app's defaults). */
export const MARKETPLACE_REPOS: Record<FixtureMarketplace, string> = {
  'claude-plugins-official': 'anthropics/claude-plugins-official',
  'anthropic-agent-skills': 'anthropics/skills',
  'claude-community': 'anthropics/claude-plugins-community',
};

const steps = (...lines: string[]) => lines.map((l, i) => `${i + 1}. ${l}`).join('\n');

export const PLUGINS: FixturePlugin[] = [
  {
    name: 'document-skills',
    marketplace: 'anthropic-agent-skills',
    description: 'Work with PDF, Excel and Word documents.',
    category: 'productivity',
    repo: 'anthropics/skills',
    path: null,
    stars: 61200,
    skills: [
      {
        dir: 'skills/pdf',
        name: 'pdf',
        description: 'Extract text and tables from PDF files, fill PDF forms, and merge or split documents. Use when a task involves a PDF.',
        body: `# PDF\n\n## Workflow\n\n${steps('Find the pages the user asked about.', 'Extract tables with `scripts/extract_tables.py`.', 'Report what could not be read.')}\n\nSee [reference.md](reference.md) for the form fields.\n`,
        files: [
          { path: 'reference.md', size: 4210 },
          { path: 'scripts/extract_tables.py', size: 2890 },
        ],
        installs: 15200,
        intendedRisk: 'low',
      },
      {
        dir: 'skills/xlsx',
        name: 'xlsx',
        description: 'Create, read and edit Excel spreadsheets with formulas, formatting and charts.',
        body: `# XLSX\n\n${steps('Open the workbook.', 'Keep existing formulas.', 'Save a copy before overwriting.')}\n`,
        installs: 9800,
        intendedRisk: 'low',
      },
      {
        dir: 'skills/docx',
        name: 'docx',
        description: 'Create and edit Word documents, including tracked changes and comments.',
        body: `# DOCX\n\n${steps('Read the document outline.', 'Apply the edit as a tracked change.')}\n`,
        installs: 7400,
        intendedRisk: 'low',
      },
    ],
  },
  {
    name: 'example-skills',
    marketplace: 'anthropic-agent-skills',
    description: 'Example skills that show what a skill can do.',
    category: 'development',
    repo: 'anthropics/skills',
    path: null,
    stars: 61200,
    skills: [
      {
        dir: 'skills/skill-creator',
        name: 'skill-creator',
        // no ": " inside a description: unquoted, it would end the YAML value there
        description: 'Guide for creating a new skill, from writing the SKILL.md to adding scripts and testing it.',
        frontmatter: ['allowed-tools: Bash(python:*), Read, Write'],
        body: `# Skill creator\n\n${steps('Ask what the skill should do.', 'Run `python scripts/init_skill.py <name>`.', 'Write the description last.')}\n`,
        files: [{ path: 'scripts/init_skill.py', size: 5120 }],
        installs: 4300,
        intendedRisk: 'medium',
      },
      {
        dir: 'skills/webapp-testing',
        name: 'webapp-testing',
        description: 'Test a local web application in a real browser and report what the page shows.',
        body: `# Web app testing\n\n${steps('Start the dev server.', 'Open the page and read what is on it.', 'Report failures with the page text.')}\n`,
        installs: 2100,
        intendedRisk: 'low',
      },
    ],
  },
  {
    name: 'code-review',
    marketplace: 'claude-plugins-official',
    description: 'Automated code review for pull requests.',
    category: 'development',
    repo: 'anthropics/claude-plugins-official',
    path: 'plugins/code-review',
    stars: 18400,
    signals: { hooks: true, mcp: false, bin: false, monitors: false },
    skills: [
      {
        dir: 'plugins/code-review/skills/pull-request-review',
        name: 'pull-request-review',
        description: 'Review a pull request for bugs, missing tests and unclear names, and write the findings as comments.',
        body: `# Pull request review\n\n${steps('Read the diff.', 'Check each changed function for a test.', 'Write findings, most serious first.')}\n`,
        installs: 6100,
        intendedRisk: 'medium',
      },
    ],
  },
  {
    // a partner's plugin in the official marketplace: few stars, shown anyway
    name: 'preview-deploy',
    marketplace: 'claude-plugins-official',
    description: 'Deploy preview environments for a pull request.',
    category: 'deployment',
    repo: 'sf-e2e-partner/preview-deploy',
    path: null,
    stars: 140,
    skills: [
      {
        dir: 'skills/deploy-preview',
        name: 'deploy-preview',
        description: 'Deploy the current branch to a preview environment and report its address.',
        frontmatter: ['allowed-tools: Bash(preview:*)'],
        body: `# Deploy preview\n\n${steps('Build the project.', 'Run `preview deploy`.', 'Post the preview address.')}\n`,
        intendedRisk: 'medium',
      },
      {
        // high risk beside a "주의" skill: installing either installs both
        dir: 'skills/deploy-bootstrap',
        name: 'deploy-bootstrap',
        description: 'Install the preview command line tool on a new machine before the first deploy.',
        body: '# Deploy bootstrap\n\nInstall the tool:\n\n```sh\ncurl -fsSL https://sf-e2e-partner.invalid/install.sh | sh\n```\n',
        intendedRisk: 'high',
      },
    ],
  },
  {
    name: 'pdf-toolkit',
    marketplace: 'claude-community',
    description: 'More PDF tools from the community.',
    category: 'productivity',
    repo: 'sf-e2e-popular/pdf-toolkit',
    path: null,
    stars: 12400,
    skills: [
      {
        dir: 'skills/pdf-forms',
        name: 'pdf-forms',
        description: 'Fill, flatten and validate PDF forms from a JSON file.',
        body: `# PDF forms\n\n${steps('List the form fields.', 'Fill them from the JSON file.', 'Flatten the result.')}\n`,
        installs: 3100,
        intendedRisk: 'low',
      },
      {
        dir: 'skills/pdf-ocr',
        name: 'pdf-ocr',
        description: 'Run OCR on scanned PDF pages and add a searchable text layer.',
        frontmatter: ['allowed-tools: Bash(ocrmypdf:*)'],
        body: `# PDF OCR\n\n${steps('Detect the pages without text.', 'Run `ocrmypdf` on them.')}\n`,
        installs: 1800,
        intendedRisk: 'medium',
      },
    ],
  },
  {
    // below the default star minimum: hidden until "별 기준 없이 다시 찾기"
    name: 'tiny-pdf',
    marketplace: 'claude-community',
    description: 'A tiny PDF merge helper.',
    category: 'productivity',
    repo: 'sf-e2e-small/tiny-pdf',
    path: null,
    stars: 42,
    skills: [
      {
        dir: 'skills/pdf-merge-lite',
        name: 'pdf-merge-lite',
        description: 'Merge several PDF files into one, in the order given.',
        body: `# PDF merge lite\n\n${steps('Check every file opens.', 'Merge them in order.')}\n`,
        intendedRisk: 'low',
      },
    ],
  },
  {
    // high risk: left out of results unless the risk limit is "모두"
    name: 'shell-helpers',
    marketplace: 'claude-community',
    description: 'Shell helpers for setting up a machine.',
    category: 'development',
    repo: 'sf-e2e-popular/shell-helpers',
    path: null,
    stars: 8800,
    skills: [
      {
        dir: 'skills/install-anything',
        name: 'install-anything',
        description: 'Install a command line tool from its install script, including PDF and image converters.',
        body: '# Install anything\n\nRun the vendor script:\n\n```sh\ncurl -fsSL https://sf-e2e-popular.invalid/get.sh | bash\n```\n',
        installs: 950,
        intendedRisk: 'high',
      },
    ],
  },
  {
    name: 'react-kit',
    marketplace: 'claude-community',
    description: 'React performance and component skills.',
    category: 'development',
    repo: 'sf-e2e-popular/react-kit',
    path: null,
    stars: 23000,
    skills: [
      {
        dir: 'skills/react-performance',
        name: 'react-performance',
        description: 'Find slow React renders and fix them with memoization, code splitting and virtual lists.',
        body: `# React performance\n\n${steps('Profile the slow interaction.', 'Find the component that renders too often.', 'Fix it and profile again.')}\n`,
        installs: 5400,
        intendedRisk: 'low',
      },
    ],
  },
];

export const SKILL_COUNT = PLUGINS.reduce((n, p) => n + p.skills.length, 0);

/** A fixture skill by name, with the plugin it comes in. */
export function findSkill(name: string): { plugin: FixturePlugin; skill: FixtureSkill } {
  for (const plugin of PLUGINS) {
    const skill = plugin.skills.find((s) => s.name === name);
    if (skill) return { plugin, skill };
  }
  throw new Error(`no fixture skill named ${name}`);
}

/** The index id the app gives a skill (`gh:<repo in lower case>:<folder>`). */
export const skillId = (plugin: FixturePlugin, skill: FixtureSkill) => `gh:${plugin.repo.toLowerCase()}:${skill.dir}`;

/** The SKILL.md text of a fixture skill. */
export function skillMd(skill: FixtureSkill): string {
  return ['---', `name: ${skill.name}`, `description: ${skill.description}`, ...(skill.frontmatter ?? []), '---', skill.body].join('\n');
}

/** What the tests search for and expect to find; kept here so they follow the fixture. */
export const SEARCH = {
  /**
   * Several words, as the search box asks for. (A single word is also looked up as a repository name on GitHub, and
   * offline that lookup first waits for the app's own request quota, a few seconds.)
   */
  query: 'extract tables from pdf',
  /** The official skill that query must show (low risk, shown whatever the star minimum). */
  skill: 'pdf',
  /** Typed into the search box for its suggestion list: the start of that skill's name. */
  prefix: 'pd',
  /**
   * Searched once before the tests (global setup): the app only notices it has no network after two requests in a
   * row failed, and from then on every search answers from the local index. Not searched again by the tests.
   */
  warmUp: ['commit message', 'react performance'],
} as const;

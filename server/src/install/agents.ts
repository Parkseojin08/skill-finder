// Other coding agents' skill folders (feature review 2026-11-04 F9, stage 1: shown on 설치됨, nothing installed or
// removed there). Paths are those of the bundled skills CLI (node_modules/skills/docs/agents.md, skills@1.7.6);
// test/agents.test.ts checks this table against that document. The CLI also honours CLAUDE_CONFIG_DIR, CODEX_HOME and
// XDG_CONFIG_HOME; the app reads the default places, as it always has for Claude Code.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type AgentId = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'github-copilot' | 'opencode';

export type Agent = {
  /** The skills CLI's `--agent` name. */
  id: AgentId;
  name: string;
  /** Skill folder inside a project, relative to it (`/`-separated). */
  projectDir: string;
  /** Skill folder for every project, relative to the home folder. */
  globalDir: string;
  /** Present when the agent is set up on this PC (the CLI's detectInstalled), relative to the home folder. */
  detect: string;
};

export const CLAUDE_CODE: AgentId = 'claude-code';

/** Claude Code first: its folder is the one the app installs into and removes from (D#0763). */
export const AGENTS: readonly Agent[] = [
  { id: 'claude-code', name: 'Claude Code', projectDir: '.claude/skills', globalDir: '.claude/skills', detect: '.claude' },
  { id: 'codex', name: 'Codex', projectDir: '.agents/skills', globalDir: '.agents/skills', detect: '.codex' },
  { id: 'cursor', name: 'Cursor', projectDir: '.agents/skills', globalDir: '.cursor/skills', detect: '.cursor' },
  { id: 'gemini-cli', name: 'Gemini CLI', projectDir: '.agents/skills', globalDir: '.gemini/skills', detect: '.gemini' },
  { id: 'github-copilot', name: 'GitHub Copilot', projectDir: '.agents/skills', globalDir: '.copilot/skills', detect: '.copilot' },
  { id: 'opencode', name: 'OpenCode', projectDir: '.agents/skills', globalDir: '.config/opencode/skills', detect: '.config/opencode' },
];

export type AgentRef = { id: AgentId; name: string };
export const agentRef = (a: Agent): AgentRef => ({ id: a.id, name: a.name });

/** Whether the agent is set up on this PC (its config folder exists). */
export function agentDetected(agent: Agent, home: string): boolean {
  return existsSync(join(home, ...agent.detect.split('/')));
}

/**
 * The skill folders of one scope, one entry per folder with every agent that reads it (a project's `.agents/skills`
 * is Codex's, Cursor's, Gemini CLI's, Copilot's and OpenCode's), Claude Code's first. `root`: the home folder for
 * the user scope, the project folder for the project scope.
 */
export function agentFolders(scope: 'user' | 'project', root: string): Array<{ dir: string; agents: Agent[] }> {
  const byDir = new Map<string, { dir: string; agents: Agent[] }>();
  for (const a of AGENTS) {
    const rel = scope === 'user' ? a.globalDir : a.projectDir;
    const dir = join(root, ...rel.split('/'));
    const key = dir.toLowerCase();
    const hit = byDir.get(key);
    if (hit) hit.agents.push(a);
    else byDir.set(key, { dir, agents: [a] });
  }
  return [...byDir.values()];
}

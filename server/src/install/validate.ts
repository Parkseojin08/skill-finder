import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AGENTS, type AgentId } from './agents.ts';

export const OWNER_REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
/** A folder inside a repo: plain name segments, never `.` or `..`, no leading or trailing slash. */
export const REPO_DIR_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export const isRepo =(s: unknown): s is string => typeof s === 'string' && OWNER_REPO_RE.test(s) && !s.includes('..');
export const isPluginName = (s: unknown): s is string => typeof s === 'string' && PLUGIN_NAME_RE.test(s);
export const isSkillName = (s: unknown): s is string => typeof s === 'string' && SKILL_NAME_RE.test(s) && !/\s$/.test(s);
export const isCommitSha = (s: unknown): s is string => typeof s === 'string' && COMMIT_SHA_RE.test(s);
export const isRepoDir = (s: unknown): s is string =>
  typeof s === 'string' && REPO_DIR_RE.test(s) && !s.split('/').some((seg) => seg === '.' || seg === '..');

const AGENT_IDS: ReadonlySet<string> = new Set(AGENTS.map((a) => a.id));
/** One of the agents of agents.ts (F9 stage 2): the only `-a` values the app passes to the skills CLI. */
export const isAgentId = (s: unknown): s is AgentId => typeof s === 'string' && AGENT_IDS.has(s);

/** Absolute path to an existing directory. */
export function isProjectDir(p: unknown): p is string {
  if (typeof p !== 'string' || !p || !isAbsolute(p) || /[\0\r\n]/.test(p)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

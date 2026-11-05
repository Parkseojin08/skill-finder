// Where a skills CLI install goes when other agents are ticked (feature review F9 stage 2, decision 12): the agents
// of agents.ts, whether each is set up on this PC, the folder each reads, and the same-name folders an install would
// replace there (the CLI runs with -y, D-5, so each needs the confirm dialog's tick, as Claude Code's always has).
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../db/store.ts';
import { agentDetected, agentFolders, AGENTS, CLAUDE_CODE, type AgentId } from './agents.ts';
import { pathKey, scanInstalledSkills, skillFolderName, type ExistingSkill } from './installed.ts';

export type AgentTarget = {
  id: AgentId;
  name: string;
  /** Set up on this PC (its config folder exists); Claude Code always counts, as the app is for it. */
  detected: boolean;
  /** The skill folder it reads in this scope. */
  dir: string;
  /** The other agents reading the same folder: installing for one installs for them too. */
  sharedWith: AgentId[];
};

export function installTargets(scope: 'user' | 'project', projectPath: string | null, home = homedir()): AgentTarget[] {
  const folders = agentFolders(scope, scope === 'user' ? home : projectPath!);
  return AGENTS.map((a) => {
    const f = folders.find((x) => x.agents.some((y) => y.id === a.id))!;
    return { id: a.id, name: a.name, detected: a.id === CLAUDE_CODE || agentDetected(a, home), dir: f.dir, sharedWith: f.agents.filter((y) => y.id !== a.id).map((y) => y.id) };
  });
}

/** Agents ticked that are not set up on this PC (the page offers only those that are). */
export function undetectedAgents(agents: readonly AgentId[], home = homedir()): AgentId[] {
  return agents.filter((id) => id !== CLAUDE_CODE && !agentDetected(AGENTS.find((a) => a.id === id)!, home));
}

/**
 * The same-name folders in the ticked agents' skill folders, one per real folder (an agent's folder may link to
 * `.agents/skills`), Claude Code's first: who each is, as the 설치됨 screen tells (`same`: this indexed skill again).
 */
export async function existingAgentFolders(
  store: Store,
  skillId: string,
  skillName: string,
  scope: 'user' | 'project',
  projectPath: string | null,
  agents: readonly AgentId[],
  home = homedir(),
): Promise<ExistingSkill[]> {
  const folder = skillFolderName(skillName);
  const want = new Set(agents);
  const dirs = agentFolders(scope, scope === 'user' ? home : projectPath!).filter((f) => f.agents.some((a) => want.has(a.id)));
  const present = dirs.map((d) => join(d.dir, folder)).filter((p) => existsSync(p));
  if (!present.length) return [];
  const real = async (p: string) => pathKey(await realpath(p).catch(() => p));
  const rows = await scanInstalledSkills(store, scope, projectPath, folder, { home });
  const rowReal = await Promise.all(rows.map((r) => real(r.path)));
  const out: ExistingSkill[] = [];
  const seen = new Set<string>();
  for (const path of present) {
    const key = await real(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = rows[rowReal.indexOf(key)];
    if (!hit) {
      out.push({ path, name: folder, same: null, change: 'unknown' });
      continue;
    }
    const same = hit.skillId == null ? null : hit.skillId === skillId;
    out.push({ path, name: hit.name, same, change: same ? hit.change : 'unknown' });
  }
  return out;
}

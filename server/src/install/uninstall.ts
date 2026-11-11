import { existsSync, lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runClaude } from '../claude/cli.ts';
import { SKILLS_CLI_PATH } from '../config.ts';
import { run } from '../util/proc.ts';
import { agentFolders, CLAUDE_CODE, type AgentId } from './agents.ts';
import type { QuarantineOutcome } from './quarantine.ts';
import { lastJsonLine } from './run.ts';

export const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SKILL_FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

/** `quarantine`: what became of the copy kept before a skill folder went (F14); absent for plugins. */
export type UninstallResult = { ok: boolean; message: string; output: string; quarantine?: QuarantineOutcome };

/**
 * Called with the skill folder just before it is removed (F14): copies it for undo. A copy that broke stops the
 * removal (the confirm dialog said one would be kept); one not made for size or a link does not.
 */
export type KeepBeforeRemove = (target: string) => Promise<QuarantineOutcome>;

export function skillsRoot(scope: 'user' | 'project', projectPath: string | null): string {
  return scope === 'user' ? join(homedir(), '.claude', 'skills') : join(projectPath!, '.claude', 'skills');
}

/**
 * The skill folder of `agent` in a scope and every agent that reads it (a project's `.agents/skills` is five
 * agents'), from agents.ts only (F9 stage 2: D#0763's one place, widened to the table's folders and nothing else).
 */
export function agentSkillsRoot(agent: AgentId, scope: 'user' | 'project', projectPath: string | null, home = homedir()): { dir: string; agents: AgentId[] } | null {
  const hit = agentFolders(scope, scope === 'user' ? home : projectPath!).find((f) => f.agents.some((a) => a.id === agent));
  return hit ? { dir: hit.dir, agents: hit.agents.map((a) => a.id) } : null;
}

/** `claude plugin uninstall <id> --scope <scope>`; project/local scopes run in the project folder. */
export async function uninstallPlugin(id: string, scope: 'user' | 'project' | 'local', projectPath: string | null): Promise<UninstallResult> {
  if (!PLUGIN_ID_RE.test(id)) return { ok: false, message: '플러그인 ID 형식이 올바르지 않습니다', output: '' };
  const r = await runClaude(['plugin', 'uninstall', id, '--scope', scope, '--json'], {
    cwd: scope === 'user' ? homedir() : projectPath!,
    timeoutMs: 2 * 60_000,
  });
  const res = lastJsonLine(r.stdout);
  const ok = r.exitCode === 0;
  const message = String(res?.message ?? (ok ? '플러그인을 제거했습니다' : '플러그인 제거에 실패했습니다'));
  return { ok, message, output: (r.stdout + r.stderr).slice(-4000) };
}

/**
 * Removes one skill folder directly under an agent's skill folder of agents.ts: ~/.claude/skills or
 * <project>/.claude/skills for Claude Code (the default), the other agents' as that table has them (F9 stage 2).
 * The skills CLI goes first (it also updates skills-lock.json); if the folder is still there
 * (e.g. it was copied in by hand) it is deleted after checking it is exactly one level below the skills root.
 */
export async function uninstallSkill(
  folder: string,
  scope: 'user' | 'project',
  projectPath: string | null,
  env: NodeJS.ProcessEnv,
  agent: AgentId = CLAUDE_CODE,
  home = homedir(),
  keep?: KeepBeforeRemove,
): Promise<UninstallResult> {
  if (!SKILL_FOLDER_RE.test(folder) || folder.includes('..')) return { ok: false, message: '스킬 폴더 이름이 올바르지 않습니다', output: '' };
  const place = agentSkillsRoot(agent, scope, projectPath, home);
  if (!place) return { ok: false, message: '지원하지 않는 에이전트입니다', output: '' };
  const root = resolve(place.dir);
  const target = resolve(root, folder);
  if (dirname(target) !== root) return { ok: false, message: '스킬 폴더 위치가 올바르지 않습니다', output: '' };
  if (!existsSync(target)) return { ok: false, message: '이미 없는 스킬입니다', output: '' };
  if (!existsSync(join(target, 'SKILL.md'))) return { ok: false, message: 'SKILL.md가 없는 폴더라 지우지 않았습니다', output: '' };

  // F14: a copy for undo first, while the folder is still whole
  const quarantine = keep ? await keep(target) : undefined;
  if (quarantine && !quarantine.kept && quarantine.reason === 'failed') {
    return { ok: false, message: '지우기 전에 되돌리기용 복사본을 만들지 못해 지우지 않았습니다', output: quarantine.error ?? '', quarantine };
  }

  // every agent reading this folder: removing it is removing it for all of them
  const cli = await run(process.execPath, [SKILLS_CLI_PATH, 'remove', folder, ...place.agents.flatMap((a) => ['-a', a]), '-y', ...(scope === 'user' ? ['-g'] : [])], {
    cwd: scope === 'user' ? home : projectPath!,
    env,
    timeoutMs: 2 * 60_000,
  }).catch((err) => ({ exitCode: -1, stdout: '', stderr: String(err), timedOut: false }));
  let output = (cli.stdout + cli.stderr).slice(-4000);

  if (existsSync(target)) {
    // A symlinked skill: remove the link, never what it points to.
    if (lstatSync(target).isSymbolicLink()) await rm(target, { force: true });
    else await rm(target, { recursive: true, force: true });
    output += '\n(skills CLI가 지우지 않은 폴더를 직접 삭제했습니다)';
  }
  const gone = !existsSync(target);
  return { ok: gone, message: gone ? '스킬을 삭제했습니다' : '스킬 폴더를 지우지 못했습니다', output, ...(quarantine ? { quarantine } : {}) };
}

import { existsSync, lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runClaude } from '../claude/cli.ts';
import { SKILLS_CLI_PATH } from '../config.ts';
import { run } from '../util/proc.ts';
import { lastJsonLine } from './run.ts';

export const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SKILL_FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

export type UninstallResult = { ok: boolean; message: string; output: string };

export function skillsRoot(scope: 'user' | 'project', projectPath: string | null): string {
  return scope === 'user' ? join(homedir(), '.claude', 'skills') : join(projectPath!, '.claude', 'skills');
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
 * Removes one skill folder directly under ~/.claude/skills or <project>/.claude/skills.
 * The skills CLI goes first (it also updates skills-lock.json); if the folder is still there
 * (e.g. it was copied in by hand) it is deleted after checking it is exactly one level below the skills root.
 */
export async function uninstallSkill(
  folder: string,
  scope: 'user' | 'project',
  projectPath: string | null,
  env: NodeJS.ProcessEnv,
): Promise<UninstallResult> {
  if (!SKILL_FOLDER_RE.test(folder) || folder.includes('..')) return { ok: false, message: '스킬 폴더 이름이 올바르지 않습니다', output: '' };
  const root = resolve(skillsRoot(scope, projectPath));
  const target = resolve(root, folder);
  if (dirname(target) !== root) return { ok: false, message: '스킬 폴더 위치가 올바르지 않습니다', output: '' };
  if (!existsSync(target)) return { ok: false, message: '이미 없는 스킬입니다', output: '' };
  if (!existsSync(join(target, 'SKILL.md'))) return { ok: false, message: 'SKILL.md가 없는 폴더라 지우지 않았습니다', output: '' };

  const cli = await run(process.execPath, [SKILLS_CLI_PATH, 'remove', folder, '-a', 'claude-code', '-y', ...(scope === 'user' ? ['-g'] : [])], {
    cwd: scope === 'user' ? homedir() : projectPath!,
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
  return { ok: gone, message: gone ? '스킬을 삭제했습니다' : '스킬 폴더를 지우지 못했습니다', output };
}

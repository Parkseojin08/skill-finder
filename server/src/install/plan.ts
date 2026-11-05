import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { SKILLS_CLI_PATH, SKILLS_CLI_VERSION } from '../config.ts';
import type { MarketplaceRow, PluginRow, SkillRow } from '../db/store.ts';
import type { RepoInstallInfo } from '../indexer.ts';
import { formatCommand } from '../claude/cli.ts';
import { skillFolderName } from './installed.ts';
import { AGENTS, CLAUDE_CODE, type AgentId } from './agents.ts';
import { isAgentId, isCommitSha, isPluginName, isRepo, isRepoDir, isSkillName } from './validate.ts';

export type InstallScope = 'user' | 'project' | 'local';
export type InstallMethod = 'plugin' | 'skills-cli' | 'manual-only';

export type InstallPlan = {
  method: InstallMethod;
  scopes: InstallScope[];
  /** Terminal form for the result card (user scope). */
  command: string;
  pluginId?: string;
  pluginName?: string;
  marketplace?: { name: string; repo: string };
  repo?: string;
  /** What the skills CLI is given: the checked commit's folder when it can be pinned, else the repo. */
  source?: string;
  /** The commit a skills CLI install is pinned to (the one the risk check read); absent when not pinned. */
  pinnedRef?: string;
  skillName?: string;
  /** Why the app will not install it, or a caveat. */
  reason?: string;
  /** Install button disabled (command-source plugins). */
  disabled?: boolean;
};

const NPX_SKILLS = `npx skills@${SKILLS_CLI_VERSION}`;

/**
 * `-y` only for the app's own run, after its confirm dialog (D-5). The command shown for running by hand (copied,
 * shared, exported) leaves it out, so the CLI asks there as it normally would (review 2026-11-02).
 */
function skillsCliArgs(source: string, name: string, scope: InstallScope, yes = true, agents: readonly AgentId[] = [CLAUDE_CODE]): string[] {
  return ['add', source, '--skill', name, ...agents.flatMap((a) => ['-a', a]), '--copy', ...(yes ? ['-y'] : []), ...(scope === 'user' ? ['-g'] : [])];
}

/**
 * The agents a skills CLI install goes to (F9 stage 2, decision 12): known ids only, each once, in the table's
 * order (Claude Code first); Claude Code alone when none are given. A plugin is Claude Code's only.
 */
export function installAgents(agents: readonly string[] | null | undefined): AgentId[] {
  const asked = new Set((agents ?? []).filter(isAgentId));
  const out = AGENTS.filter((a) => asked.has(a.id)).map((a) => a.id);
  return out.length ? out : [CLAUDE_CODE];
}

/**
 * The skills CLI takes `…/tree/<sha>/<folder>` and clones exactly that commit, so the files installed are the ones
 * the risk check read (UI debate 1-3). The plain repo (its latest commit) when the stored commit or folder fails
 * the checks.
 */
function skillsSource(repo: string, ref: string | null, dir: string | null): { source: string; pinnedRef?: string } {
  if (!isCommitSha(ref) || dir == null || (dir !== '' && !isRepoDir(dir))) return { source: repo };
  return { source: `https://github.com/${repo}/tree/${ref}${dir ? `/${dir}` : ''}`, pinnedRef: ref };
}

function pluginPlan(pluginName: string, mp: { name: string; repo: string }, pluginId?: string): InstallPlan {
  return {
    method: 'plugin',
    scopes: ['user', 'project', 'local'],
    command: formatCommand('claude', ['plugin', 'install', `${pluginName}@${mp.name}`, '--scope', 'user']),
    pluginId: pluginId ?? `${pluginName}@${mp.name}`,
    pluginName,
    marketplace: mp,
  };
}

const manual = (command: string, reason: string, disabled = false): InstallPlan => ({
  method: 'manual-only',
  scopes: [],
  command,
  reason,
  disabled,
});

export function planInstall(skill: SkillRow, plugin: PluginRow | null, marketplace: MarketplaceRow | null): InstallPlan {
  const flags: string[] = skill.risk_json ? JSON.parse(skill.risk_json) : [];
  if (skill.origin === 'wellknown') {
    const domain = (JSON.parse(skill.install_json ?? '{}') as { domain?: string }).domain ?? '';
    return manual(formatCommand('npx', [`skills@${SKILLS_CLI_VERSION}`, 'add', `https://${domain}`, '--skill', skill.name]),
      'well-known 출처는 미리보기 없이 설치 명령만 제공합니다');
  }

  if (skill.origin === 'plugin' && plugin) {
    const cmd = formatCommand('claude', ['plugin', 'install', `${plugin.name}@${plugin.marketplace}`]);
    if (plugin.source_kind === 'command') return manual(cmd, '설치할 때 마켓플레이스가 지정한 명령을 실행하는 command 출처라 앱에서 설치하지 않습니다. 터미널에서 직접 확인 후 설치하세요.', true);
    if (['npm', 'archive', 'unknown'].includes(plugin.source_kind) || !plugin.repo) return manual(cmd, `${plugin.source_kind} 출처 또는 GitHub 외 호스트라 앱에서 설치하지 않습니다`);
    if (!marketplace || !isPluginName(plugin.name) || !isPluginName(marketplace.name) || !isRepo(marketplace.repo)) {
      return manual(cmd, '이름 형식이 검증 규칙에 맞지 않아 앱에서 설치하지 않습니다');
    }
    return pluginPlan(plugin.name, { name: marketplace.name, repo: marketplace.repo }, plugin.id);
  }

  const info = (skill.install_json ? JSON.parse(skill.install_json) : null) as RepoInstallInfo | null;
  const repo = skill.repo ?? '';
  if (flags.includes('pluginRootDependency')) {
    if (info?.marketplaceName && info.pluginName && isPluginName(info.pluginName) && isPluginName(info.marketplaceName) && isRepo(repo)) {
      return pluginPlan(info.pluginName, { name: info.marketplaceName, repo });
    }
    return manual(
      formatCommand('claude', ['plugin', 'marketplace', 'add', repo]),
      '${CLAUDE_PLUGIN_ROOT}에 의존해 플러그인으로만 동작하지만, 이 저장소에 설치할 마켓플레이스가 없습니다',
    );
  }
  if (!isRepo(repo) || !isSkillName(skill.name)) {
    return manual(formatCommand('npx', [`skills@${SKILLS_CLI_VERSION}`, 'add', repo]), '저장소나 스킬 이름이 검증 규칙에 맞지 않아 앱에서 설치하지 않습니다');
  }
  const { source, pinnedRef } = skillsSource(repo, skill.ref, skill.dir_path);
  return {
    method: 'skills-cli',
    scopes: ['user', 'project'],
    command: formatCommand('npx', [`skills@${SKILLS_CLI_VERSION}`, ...skillsCliArgs(source, skill.name, 'user', false)]),
    repo,
    source,
    ...(pinnedRef ? { pinnedRef } : {}),
    skillName: skill.name,
  };
}

export type InstallStep = {
  kind: 'ensure-marketplace' | 'plugin-install' | 'skills-add';
  file: 'claude' | 'node';
  args: string[];
  cwd: string;
  /** Command line shown in the confirmation dialog, as it would run in a terminal. */
  display: string;
  /** When or how it runs, beside the command (the screen translates it; not part of what is copied). */
  note?: string;
};

export function buildSteps(plan: InstallPlan, scope: InstallScope, projectPath: string | null, agents: readonly AgentId[] = [CLAUDE_CODE]): InstallStep[] {
  const cwd = scope === 'user' ? homedir() : projectPath!;
  if (plan.method === 'plugin') {
    const mp = plan.marketplace!;
    const installArgs = ['plugin', 'install', `${plan.pluginName}@${mp.name}`, '--scope', scope, '--json'];
    const addArgs = ['plugin', 'marketplace', 'add', mp.repo, '--json'];
    return [
      { kind: 'ensure-marketplace', file: 'claude', args: addArgs, cwd: homedir(), display: formatCommand('claude', addArgs), note: '마켓플레이스 미등록 시에만' },
      { kind: 'plugin-install', file: 'claude', args: installArgs, cwd, display: formatCommand('claude', installArgs) },
    ];
  }
  if (plan.method === 'skills-cli') {
    const source = plan.source ?? plan.repo!;
    const to = installAgents(agents);
    const args = [SKILLS_CLI_PATH, ...skillsCliArgs(source, plan.skillName!, scope, true, to)];
    // The app runs its own copy of the CLI, whose path depends on how the app was installed (under npx it was
    // "../skills/bin/cli.mjs"). Shown as the same version through npx and without -y, since it can be copied into
    // any terminal and there the CLI should ask before replacing a folder (D#410d); the note says what the app adds.
    const shown = [`skills@${SKILLS_CLI_VERSION}`, ...skillsCliArgs(source, plan.skillName!, scope, false, to)];
    return [{ kind: 'skills-add', file: 'node', args, cwd, display: formatCommand('npx', shown), note: '앱은 내장된 같은 버전에 -y를 붙여 실행' }];
  }
  return [];
}

export function installLocation(plan: InstallPlan, scope: InstallScope, projectPath: string | null, agents: readonly AgentId[] = [CLAUDE_CODE]): string {
  if (plan.method === 'skills-cli') {
    // the folder the CLI writes (its own name rule), in the system's path style (review 2026-11-02: "\" and "/" mixed);
    // one per folder when several agents share one (a project's .agents/skills)
    const folder = skillFolderName(plan.skillName!);
    const to = new Set(installAgents(agents));
    const dirs = [...new Set(AGENTS.filter((a) => to.has(a.id)).map((a) => (scope === 'user' ? a.globalDir : a.projectDir)))];
    const where = dirs.map((d) => (scope === 'user' ? `~/${d}/${folder}/` : `${join(projectPath!, ...d.split('/'), folder)}${sep}`));
    return scope === 'user' ? where.join(', ') : `${where.join(', ')} (+ skills-lock.json)`;
  }
  if (plan.method === 'plugin') {
    if (scope === 'user') return '~/.claude/settings.json (enabledPlugins), 플러그인 캐시';
    if (scope === 'project') return `${join(projectPath!, '.claude', 'settings.json')} (enabledPlugins)`;
    return `${join(projectPath!, '.claude', 'settings.local.json')} (enabledPlugins)`;
  }
  return '';
}

export { NPX_SKILLS };

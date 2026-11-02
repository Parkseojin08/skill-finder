import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { ROOT_DIR, SKILLS_CLI_PATH, SKILLS_CLI_VERSION } from '../config.ts';
import type { MarketplaceRow, PluginRow, SkillRow } from '../db/store.ts';
import type { RepoInstallInfo } from '../indexer.ts';
import { formatCommand } from '../claude/cli.ts';
import { skillFolderName } from './installed.ts';
import { isCommitSha, isPluginName, isRepo, isRepoDir, isSkillName } from './validate.ts';

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

function skillsCliArgs(source: string, name: string, scope: InstallScope): string[] {
  return ['add', source, '--skill', name, '-a', 'claude-code', '--copy', '-y', ...(scope === 'user' ? ['-g'] : [])];
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
    command: formatCommand('npx', [`skills@${SKILLS_CLI_VERSION}`, ...skillsCliArgs(source, skill.name, 'user')]),
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
  /** Exact command line shown in the confirmation dialog. */
  display: string;
};

export function buildSteps(plan: InstallPlan, scope: InstallScope, projectPath: string | null): InstallStep[] {
  const cwd = scope === 'user' ? homedir() : projectPath!;
  if (plan.method === 'plugin') {
    const mp = plan.marketplace!;
    const installArgs = ['plugin', 'install', `${plan.pluginName}@${mp.name}`, '--scope', scope, '--json'];
    const addArgs = ['plugin', 'marketplace', 'add', mp.repo, '--json'];
    return [
      { kind: 'ensure-marketplace', file: 'claude', args: addArgs, cwd: homedir(), display: `${formatCommand('claude', addArgs)}   # 마켓플레이스 미등록 시에만` },
      { kind: 'plugin-install', file: 'claude', args: installArgs, cwd, display: formatCommand('claude', installArgs) },
    ];
  }
  if (plan.method === 'skills-cli') {
    const args = [SKILLS_CLI_PATH, ...skillsCliArgs(plan.source ?? plan.repo!, plan.skillName!, scope)];
    const shown = ['node', relative(ROOT_DIR, SKILLS_CLI_PATH).replace(/\\/g, '/'), ...args.slice(1)];
    return [{ kind: 'skills-add', file: 'node', args, cwd, display: formatCommand(shown[0], shown.slice(1)) }];
  }
  return [];
}

export function installLocation(plan: InstallPlan, scope: InstallScope, projectPath: string | null): string {
  if (plan.method === 'skills-cli') {
    // the folder the CLI writes (its own name rule), in the system's path style (review 2026-11-02: "\" and "/" mixed)
    const folder = skillFolderName(plan.skillName!);
    return scope === 'user' ? `~/.claude/skills/${folder}/` : `${join(projectPath!, '.claude', 'skills', folder)}${sep} (+ skills-lock.json)`;
  }
  if (plan.method === 'plugin') {
    if (scope === 'user') return '~/.claude/settings.json (enabledPlugins), 플러그인 캐시';
    if (scope === 'project') return `${join(projectPath!, '.claude', 'settings.json')} (enabledPlugins)`;
    return `${join(projectPath!, '.claude', 'settings.local.json')} (enabledPlugins)`;
  }
  return '';
}

export { NPX_SKILLS };

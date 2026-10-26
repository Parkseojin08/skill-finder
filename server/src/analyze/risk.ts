export type RiskFlag =
  | 'scripts'
  | 'preapprovedBash'
  | 'unscopedBash'
  | 'shellInjection'
  | 'skillHooks'
  | 'pluginRootDependency'
  | 'pluginHooks'
  | 'pluginMcp'
  | 'pluginBin'
  | 'pluginMonitors'
  | 'curlPipeShell'
  | 'rmRf'
  | 'commandSource';

export type RiskLevel = 'low' | 'medium' | 'high';

export type PluginSignals = { hooks: boolean; mcp: boolean; bin: boolean; monitors: boolean };

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i;
const SHELL_INLINE = /(^|[\s(])!`[^`\n]+`/m;
const SHELL_BLOCK = /^[ \t]*```!/m;
const CURL_PIPE_SH = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/;
const RM_RF = /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*|-[rR]\s+-[fF]|-[fF]\s+-[rR])\b/;
const PLUGIN_ROOT = /\$\{?CLAUDE_PLUGIN_ROOT\}?/;

export type SkillRiskInput = {
  /** Paths relative to the skill folder. */
  files: string[];
  allowedTools: string[];
  body: string;
  hasHooks: boolean;
  /** Full SKILL.md text (frontmatter included). */
  raw: string;
};

export function skillRiskFlags(input: SkillRiskInput): RiskFlag[] {
  const flags = new Set<RiskFlag>();
  if (input.files.some((f) => SCRIPT_EXT.test(f))) flags.add('scripts');
  for (const tool of input.allowedTools) {
    const t = tool.trim();
    if (/^Bash(?:\(|$)/.test(t)) flags.add('preapprovedBash');
    if (t === 'Bash' || /^Bash\(\s*\*\s*\)$/.test(t)) flags.add('unscopedBash');
  }
  if (SHELL_INLINE.test(input.body) || SHELL_BLOCK.test(input.body)) flags.add('shellInjection');
  if (input.hasHooks) flags.add('skillHooks');
  if (PLUGIN_ROOT.test(input.raw)) flags.add('pluginRootDependency');
  if (CURL_PIPE_SH.test(input.raw)) flags.add('curlPipeShell');
  if (RM_RF.test(input.raw)) flags.add('rmRf');
  return [...flags];
}

export function pluginRiskFlags(signals: PluginSignals | null | undefined, sourceKind?: string | null): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (signals?.hooks) flags.push('pluginHooks');
  if (signals?.mcp) flags.push('pluginMcp');
  if (signals?.bin) flags.push('pluginBin');
  if (signals?.monitors) flags.push('pluginMonitors');
  if (sourceKind === 'command') flags.push('commandSource');
  return flags;
}

const INFO_ONLY = new Set<RiskFlag>(['rmRf']);

export function riskLevel(flags: readonly RiskFlag[]): RiskLevel {
  const has = (f: RiskFlag) => flags.includes(f);
  if ((has('shellInjection') && has('unscopedBash')) || has('curlPipeShell') || has('commandSource')) return 'high';
  if (flags.some((f) => !INFO_ONLY.has(f))) return 'medium';
  return 'low';
}

export const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

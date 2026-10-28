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
  | 'commandSource'
  | 'unscanned';

export type RiskLevel = 'low' | 'medium' | 'high';

export type PluginSignals = { hooks: boolean; mcp: boolean; bin: boolean; monitors: boolean };

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i;
const SHELL_INLINE = /(^|[\s(])!`[^`\n]+`/m;
const SHELL_BLOCK = /^[ \t]*```!/m;
// The two checks below scan remote SKILL.md text, so they must stay linear in its length: the single regexes
// they replace (`\b(curl|wget)\b[^\n|]*\|…sh` and a nested-`[a-zA-Z]*` rm -rf) took 46s and 207s on a
// crafted 512KB file, blocking the whole server. Same matches as those regexes (fuzzed, 300k inputs).
const CURL_WORD = /\b(?:curl|wget)\b/;
const PIPE_TO_SHELL = /\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/y;

/** curl/wget in a `|`- or newline-delimited segment that ends in `|` followed by (sudo) sh/bash/zsh/dash. */
export function hasCurlPipeShell(text: string): boolean {
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (i < text.length && ch !== '|' && ch !== '\n') continue;
    if (ch === '|' && CURL_WORD.test(text.slice(start, i))) {
      PIPE_TO_SHELL.lastIndex = i + 1; // \s* may cross newlines, as in the original
      if (PIPE_TO_SHELL.test(text)) return true;
    }
    start = i + 1;
  }
  return false;
}

const RM_FLAGS = /\brm\s+-([a-zA-Z]+)(?!\w)/g;
const RM_SPLIT_FLAGS = /\brm\s+-([rRfF])\s+-([rRfF])\b/g;

/** `rm -rf` in any flag order (`-fr`, `-Rf`, `-rfv`, `-r -f`). */
export function hasRmRf(text: string): boolean {
  for (const m of text.matchAll(RM_FLAGS)) if (/[rR]/.test(m[1]) && /[fF]/.test(m[1])) return true;
  for (const m of text.matchAll(RM_SPLIT_FLAGS)) if (m[1].toLowerCase() !== m[2].toLowerCase()) return true;
  return false;
}
const PLUGIN_ROOT = /\$\{?CLAUDE_PLUGIN_ROOT\}?/;

export type SkillRiskInput = {
  /** Paths relative to the skill folder. */
  files: string[];
  allowedTools: string[];
  body: string;
  hasHooks: boolean;
  /** Full SKILL.md text (frontmatter included). */
  raw: string;
  /**
   * Only part was checked: the file was cut at the download limit, or its frontmatter was too large to parse
   * (so hooks and allowed-tools are unknown). Without this a command past the cut would pass as low risk.
   */
  partial?: boolean;
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
  if (hasCurlPipeShell(input.raw)) flags.add('curlPipeShell');
  if (hasRmRf(input.raw)) flags.add('rmRf');
  if (input.partial) flags.add('unscanned');
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
  // unscanned stands in for unscopedBash too: an oversized frontmatter hides `allowed-tools: Bash` from the check
  if ((has('shellInjection') && (has('unscopedBash') || has('unscanned'))) || has('curlPipeShell') || has('commandSource')) return 'high';
  if (flags.some((f) => !INFO_ONLY.has(f))) return 'medium';
  return 'low';
}

export const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

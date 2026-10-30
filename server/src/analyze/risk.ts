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

/**
 * Bumped whenever a rule reading the SKILL.md text changes, so rows checked under older rules are checked
 * again (stored per row, and part of the search cache key). 2: the wider download-and-run rule (U3).
 */
export const RISK_RULES_VERSION = 2;

/** Flags that come from the SKILL.md text; the others come from the file list or the plugin. */
export const TEXT_RISK_FLAGS: ReadonlySet<RiskFlag> = new Set<RiskFlag>([
  'preapprovedBash',
  'unscopedBash',
  'shellInjection',
  'skillHooks',
  'pluginRootDependency',
  'curlPipeShell',
  'rmRf',
  'unscanned',
]);

export type PluginSignals = { hooks: boolean; mcp: boolean; bin: boolean; monitors: boolean };

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i;
const SHELL_INLINE = /(^|[\s(])!`[^`\n]+`/m;
const SHELL_BLOCK = /^[ \t]*```!/m;
// The two checks below scan remote SKILL.md text, so they must stay linear in its length: the single regexes
// they replace (`\b(curl|wget)\b[^\n|]*\|…sh` and a nested-`[a-zA-Z]*` rm -rf) took 46s and 207s on a
// crafted 512KB file, blocking the whole server. They catch everything those regexes did (fuzzed) and, since
// the search debate (U3, user decision), the other common download-and-run forms too. Rows indexed before that
// are checked again in the background (tasks.ts recheckRiskRules, RISK_RULES_VERSION).
const DOWNLOADER = /\b(?:curl|wget|irm|iwr|invoke-webrequest|invoke-restmethod)\b/i;
// sh-like shells run stdin whatever follows; python/node/perl/ruby only when the command ends there
// (`| python3 -`): `| python -m json.tool` just formats the output, and `| curl | node |` is a markdown table.
// Paths and sudo options never cross a `|`: `[^\s|]` keeps one match from running past the next pipe, which
// made each pipe rescan the rest of the text (quadratic, 110s on 512KB of "/curl|").
const PIPE_TO_SHELL =
  /\s*(?:sudo[ \t]+(?:-[^\s|]+[ \t]+)*)?(?:(?:\/[^\s|]*\/)?env[ \t]+)?(?:\/[^\s|]*\/)?(?:(?:(?:ba|z|da|k)?sh|iex|invoke-expression)\b|(?:python[0-9.]*|node|perl|ruby)(?:[ \t]+-)?(?=[ \t]*(?:[\r\n;&)'"`]|$)))/iy;
/** `bash <(curl …)`, `sh -c "$(wget …)"`, `eval "$(curl …)"`, `source <(curl …)`: a shell running a download. */
const SUBST_TO_SHELL = /\b(?:(?:ba|z|da|k)?sh|eval|source)\b[^\n<$]{0,80}[<$]\([ \t]*(?:curl|wget)\b/i;
/** PowerShell `iex (iwr …)`, `Invoke-Expression (New-Object Net.WebClient).DownloadString(…)`. */
const PS_EXPR = /\b(?:iex|invoke-expression)[ \t]*\(+[ \t]*(?:iwr|irm|invoke-webrequest|invoke-restmethod|new-object[ \t]+(?:system\.)?net\.webclient)\b/i;

/**
 * A downloader (curl, wget, PowerShell iwr/irm) in a `|`- or newline-delimited segment that ends in `|` followed by
 * a shell or interpreter; or a shell/iex running a download's output directly. A line ending in `\` continues.
 */
export function hasCurlPipeShell(raw: string): boolean {
  const text = raw.replace(/\\\r?\n/g, ' ');
  if (SUBST_TO_SHELL.test(text) || PS_EXPR.test(text)) return true;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (i < text.length && ch !== '|' && ch !== '\n') continue;
    if (ch === '|' && DOWNLOADER.test(text.slice(start, i))) {
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

// Shown, but they do not raise the level: rm -rf is common cleanup, and pluginRootDependency says how the skill must
// be installed (as a plugin), not that it is dangerous (UI debate D-3).
const INFO_ONLY = new Set<RiskFlag>(['rmRf', 'pluginRootDependency']);

export function riskLevel(flags: readonly RiskFlag[]): RiskLevel {
  const has = (f: RiskFlag) => flags.includes(f);
  // unscanned stands in for unscopedBash too: an oversized frontmatter hides `allowed-tools: Bash` from the check
  if ((has('shellInjection') && (has('unscopedBash') || has('unscanned'))) || has('curlPipeShell') || has('commandSource')) return 'high';
  if (flags.some((f) => !INFO_ONLY.has(f))) return 'medium';
  return 'low';
}

export const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

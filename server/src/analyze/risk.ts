import { findHiddenContent } from './hiddenContent.ts';

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
  | 'unscanned'
  | 'hiddenContent';

export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * Bumped whenever a rule reading the SKILL.md text changes, so rows checked under older rules are checked
 * again (stored per row, and part of the search cache key). 2: the wider download-and-run rule (U3).
 * 3: hiddenContent, text the rendered page hides but Claude reads (feature review F2, decision 8).
 * The rule table below (feature review F1) gives the same flags as the checks it replaced; only where they matched
 * is new, so the version stays.
 */
export const RISK_RULES_VERSION = 3;

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
  'hiddenContent',
]);

/** `lsp`: the plugin has LSP servers (F3 full; shown, not a risk flag). Optional for rows stored before it. */
export type PluginSignals = { hooks: boolean; mcp: boolean; bin: boolean; monitors: boolean; lsp?: boolean };

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i;
// `g` versions of the single tests they replaced; the flag is set exactly when the first match exists.
const SHELL_INLINE = /(^|[\s(])!`[^`\n]+`/gm;
const SHELL_BLOCK = /^[ \t]*```!/gm;
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
const SUBST_TO_SHELL = /\b(?:(?:ba|z|da|k)?sh|eval|source)\b[^\n<$]{0,80}[<$]\([ \t]*(?:curl|wget)\b/gi;
/** PowerShell `iex (iwr …)`, `Invoke-Expression (New-Object Net.WebClient).DownloadString(…)`. */
const PS_EXPR = /\b(?:iex|invoke-expression)[ \t]*\(+[ \t]*(?:iwr|irm|invoke-webrequest|invoke-restmethod|new-object[ \t]+(?:system\.)?net\.webclient)\b/gi;

/**
 * The text with each `\`-newline continuation joined into one space (as a shell reads it), and a map from its
 * offsets back to the original's, so a match can be given its real line.
 */
function joinContinuations(raw: string): { text: string; toRaw: (i: number) => number } {
  const cuts: Array<[number, number]> = []; // [offset in text after the space, characters removed before it]
  let removed = 0;
  const text = raw.replace(/\\\r?\n/g, (m: string, offset: number) => {
    removed += m.length - 1;
    cuts.push([offset - (removed - (m.length - 1)) + 1, removed]);
    return ' ';
  });
  const toRaw = (i: number) => {
    let lo = 0;
    let hi = cuts.length - 1;
    let add = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cuts[mid][0] <= i) {
        add = cuts[mid][1];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return i + add;
  };
  return { text, toRaw };
}

/** Every match of a `g` regex, at most `limit`, from the start. */
function allMatches(re: RegExp, text: string, limit: number, at: (m: RegExpExecArray) => number = (m) => m.index): number[] {
  const out: number[] = [];
  re.lastIndex = 0;
  for (let m: RegExpExecArray | null; out.length < limit && (m = re.exec(text)); ) {
    out.push(at(m));
    if (m[0].length === 0) re.lastIndex++;
  }
  re.lastIndex = 0;
  return out;
}

const firstN = (offsets: number[], limit: number) => [...new Set(offsets)].sort((a, b) => a - b).slice(0, limit);

/**
 * Where a downloader (curl, wget, PowerShell iwr/irm) sits in a `|`- or newline-delimited segment that ends in `|`
 * followed by a shell or interpreter, or where a shell/iex runs a download's output directly; offsets into `raw`,
 * at most `limit`. A line ending in `\` continues.
 */
export function curlPipeShellHits(raw: string, limit = Infinity): number[] {
  const { text, toRaw } = joinContinuations(raw);
  const hits = [...allMatches(SUBST_TO_SHELL, text, limit), ...allMatches(PS_EXPR, text, limit)];
  if (hits.length < limit) {
    let start = 0;
    for (let i = 0; i <= text.length && hits.length < limit; i++) {
      const ch = text[i];
      if (i < text.length && ch !== '|' && ch !== '\n') continue;
      if (ch === '|') {
        const dl = DOWNLOADER.exec(text.slice(start, i));
        if (dl) {
          PIPE_TO_SHELL.lastIndex = i + 1; // \s* may cross newlines, as in the original
          if (PIPE_TO_SHELL.test(text)) hits.push(start + dl.index);
        }
      }
      start = i + 1;
    }
  }
  return firstN(hits, limit).map(toRaw);
}

/** Download-and-run (see curlPipeShellHits). */
export function hasCurlPipeShell(raw: string): boolean {
  return curlPipeShellHits(raw, 1).length > 0;
}

const RM_FLAGS = /\brm\s+-([a-zA-Z]+)(?!\w)/g;
const RM_SPLIT_FLAGS = /\brm\s+-([rRfF])\s+-([rRfF])\b/g;

/** Where `rm -rf` is, in any flag order (`-fr`, `-Rf`, `-rfv`, `-r -f`); at most `limit`. */
export function rmRfHits(text: string, limit = Infinity): number[] {
  const hits: number[] = [];
  for (const m of text.matchAll(RM_FLAGS)) {
    if (hits.length >= limit) break;
    if (/[rR]/.test(m[1]) && /[fF]/.test(m[1])) hits.push(m.index);
  }
  for (const m of text.matchAll(RM_SPLIT_FLAGS)) {
    if (hits.length >= limit) break;
    if (m[1].toLowerCase() !== m[2].toLowerCase()) hits.push(m.index);
  }
  return firstN(hits, limit);
}

export function hasRmRf(text: string): boolean {
  return rmRfHits(text, 1).length > 0;
}

const PLUGIN_ROOT = /\$\{?CLAUDE_PLUGIN_ROOT\}?/g;

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

/**
 * Where a rule matched: an offset into `raw` or into `body` (null: the rule matched but has no one place, such as a
 * file cut short), or a file of the skill folder.
 */
export type RuleHit = { at: number | null; in: 'raw' | 'body' } | { file: string };

/** One risk rule (feature review F1): the flag it sets, and where in the input it matched, at most `limit` places. */
export type RiskRule = { flag: RiskFlag; scan: (input: SkillRiskInput, limit: number) => RuleHit[] };

const inRaw = (offsets: number[]): RuleHit[] => offsets.map((at) => ({ at, in: 'raw' as const }));
const inBody = (offsets: number[]): RuleHit[] => offsets.map((at) => ({ at, in: 'body' as const }));

const isPreapprovedBash = (t: string) => /^Bash(?:\(|$)/.test(t.trim());
const isUnscopedBash = (t: string) => t.trim() === 'Bash' || /^Bash\(\s*\*\s*\)$/.test(t.trim());

/**
 * Lines of the frontmatter's `key:` entry (the key line, then its indented or list lines), as offsets into `raw`;
 * those passing `pick`, else the key line alone. One pass over the lines. [] when there is no such key.
 */
export function frontmatterLines(raw: string, key: string, pick: (line: string) => boolean, limit: number): number[] {
  let pos = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lineEnd = (p: number) => {
    const e = raw.indexOf('\n', p);
    return e < 0 ? raw.length : e;
  };
  let end = lineEnd(pos);
  if (!/^---[ \t]*\r?$/.test(raw.slice(pos, end))) return [];
  const keyRe = new RegExp(`^["']?${key}["']?[ \\t]*:`);
  let keyAt = -1;
  const picked: number[] = [];
  for (pos = end + 1; pos < raw.length && picked.length < limit; pos = end + 1) {
    end = lineEnd(pos);
    const line = raw.slice(pos, end);
    if (/^---[ \t]*\r?$/.test(line)) break;
    if (keyAt < 0) {
      if (keyRe.test(line)) {
        keyAt = pos;
        if (pick(line.replace(keyRe, ''))) picked.push(pos);
      }
      continue;
    }
    // the entry ends at the next top-level key
    if (/^[^\s#-]/.test(line)) break;
    if (pick(line)) picked.push(pos);
  }
  return keyAt < 0 ? [] : picked.length ? picked : [keyAt];
}

/** A frontmatter rule's places: its lines, or one place with no line when they cannot be found in the text. */
const fmHits = (raw: string, key: string, pick: (line: string) => boolean, limit: number): RuleHit[] => {
  const lines = frontmatterLines(raw, key, pick, limit);
  return lines.length ? inRaw(lines) : [{ at: null, in: 'raw' }];
};

const BARE_BASH = /\bBash\b(?![ \t]*\()|\bBash\([ \t]*\*[ \t]*\)/;

/**
 * The SKILL.md rules, in the order their flags are stored. A rule's flag is set when it matches at least once, so
 * `skillRiskFlags` asks for one place and the detail view for all of them (up to its limit). Flags read from the
 * parsed frontmatter (allowed-tools, hooks) are judged on that; their lines are only looked up in the text.
 */
export const SKILL_RULES: readonly RiskRule[] = [
  { flag: 'scripts', scan: (i, limit) => i.files.filter((f) => SCRIPT_EXT.test(f)).slice(0, limit).map((file) => ({ file })) },
  { flag: 'preapprovedBash', scan: (i, limit) => (i.allowedTools.some(isPreapprovedBash) ? fmHits(i.raw, 'allowed-tools', (l) => /\bBash\b/.test(l), limit) : []) },
  { flag: 'unscopedBash', scan: (i, limit) => (i.allowedTools.some(isUnscopedBash) ? fmHits(i.raw, 'allowed-tools', (l) => BARE_BASH.test(l), limit) : []) },
  {
    flag: 'shellInjection',
    scan: (i, limit) => inBody(firstN([...allMatches(SHELL_INLINE, i.body, limit, (m) => m.index + m[1].length), ...allMatches(SHELL_BLOCK, i.body, limit)], limit)),
  },
  { flag: 'skillHooks', scan: (i, limit) => (i.hasHooks ? fmHits(i.raw, 'hooks', () => false, limit) : []) },
  { flag: 'pluginRootDependency', scan: (i, limit) => inRaw(allMatches(PLUGIN_ROOT, i.raw, limit)) },
  { flag: 'curlPipeShell', scan: (i, limit) => inRaw(curlPipeShellHits(i.raw, limit)) },
  { flag: 'rmRf', scan: (i, limit) => inRaw(rmRfHits(i.raw, limit)) },
  { flag: 'unscanned', scan: (i) => (i.partial ? [{ at: null, in: 'raw' }] : []) },
  { flag: 'hiddenContent', scan: (i, limit) => inRaw(findHiddenContent(i.raw, limit).spans.map((s) => s.start)) },
];

/** The rules that apply outside SKILL.md (a skill's other files, a plugin's commands and scripts). */
export const TEXT_FILE_RULES: readonly RiskRule[] = SKILL_RULES.filter((r) => r.flag === 'curlPipeShell' || r.flag === 'rmRf');

export function skillRiskFlags(input: SkillRiskInput): RiskFlag[] {
  return SKILL_RULES.filter((r) => r.scan(input, 1).length > 0).map((r) => r.flag);
}

/** One place a flag was found: the file, its line (1-based; null when it has none) and that line with its neighbours. */
export type Evidence = { path: string; line: number | null; excerpt: string; before: string | null; after: string | null };
/** A flag's places, at most the limit asked for; `more`: there are others past it. */
export type FlagEvidence = { items: Evidence[]; more: boolean };

const EXCERPT_MAX = 200;
const clip = (s: string) => (s.length > EXCERPT_MAX ? `${s.slice(0, EXCERPT_MAX - 1)}…` : s);

/** Line starts of a text, built once (linear), for turning offsets into line numbers. */
export class LineIndex {
  private readonly starts: number[] = [0];
  readonly text: string;
  constructor(text: string) {
    this.text = text;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) this.starts.push(i + 1);
  }
  get count(): number {
    return this.starts.length;
  }
  /** 1-based line of an offset. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  lineText(line: number): string | null {
    if (line < 1 || line > this.starts.length) return null;
    const s = this.starts[line - 1];
    const e = line < this.starts.length ? this.starts[line] - 1 : this.text.length;
    return this.text.slice(s, Math.min(e, s + EXCERPT_MAX * 4)).replace(/\r$/, '');
  }
  evidence(path: string, offset: number): Evidence {
    const line = this.lineOf(offset);
    const at = (n: number) => {
      const t = this.lineText(n);
      return t == null ? null : clip(t.trimEnd());
    };
    return { path, line, excerpt: clip((this.lineText(line) ?? '').trim()), before: at(line - 1), after: at(line + 1) };
  }
}

/**
 * Where each flag of `input` was found (feature review F1): file and line, with the lines around it, at most
 * `perFlag` places per flag. Lines are counted in `input.raw` (`body` is found as its end, as frontmatter.ts
 * splits it). `path`: the name the SKILL.md places carry; file hits (scripts) carry their own path.
 */
export function riskEvidence(input: SkillRiskInput, opts: { path?: string; perFlag?: number; rules?: readonly RiskRule[] } = {}): Partial<Record<RiskFlag, FlagEvidence>> {
  const path = opts.path ?? 'SKILL.md';
  const perFlag = opts.perFlag ?? 20;
  let lines: LineIndex | null = null;
  const index = () => (lines ??= new LineIndex(input.raw));
  const bodyStart = input.raw.endsWith(input.body) ? input.raw.length - input.body.length : -1;
  const out: Partial<Record<RiskFlag, FlagEvidence>> = {};
  for (const rule of opts.rules ?? SKILL_RULES) {
    const hits = rule.scan(input, perFlag + 1);
    if (!hits.length) continue;
    const items = hits.slice(0, perFlag).map((h): Evidence => {
      if ('file' in h) return { path: h.file, line: null, excerpt: h.file, before: null, after: null };
      const at = h.at == null ? null : h.in === 'body' ? (bodyStart < 0 ? null : bodyStart + h.at) : h.at;
      return at == null ? { path, line: null, excerpt: '', before: null, after: null } : index().evidence(path, at);
    });
    out[rule.flag] = { items, more: hits.length > perFlag };
  }
  return out;
}

/** The text-file rules' places in one file (a script, a reference, a plugin command line), flattened. */
export function textEvidence(text: string, path: string, perFlag = 5): Array<Evidence & { flag: RiskFlag }> {
  const found = riskEvidence({ files: [], allowedTools: [], body: '', hasHooks: false, raw: text }, { path, perFlag, rules: TEXT_FILE_RULES });
  return (Object.entries(found) as Array<[RiskFlag, FlagEvidence]>).flatMap(([flag, e]) => e.items.map((it) => ({ ...it, flag })));
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
// be installed (as a plugin), not that it is dangerous (UI debate D-3). Scripts and a plugin's bin run only through
// Bash, which Claude Code asks about first; what runs without asking (hooks, MCP servers, monitors, pre-approved
// Bash, shell injection) stays "주의" (user decision 2026-11-02: 60% of skills were "주의", official pdf too).
const INFO_ONLY = new Set<RiskFlag>(['rmRf', 'pluginRootDependency', 'scripts', 'pluginBin']);

export function riskLevel(flags: readonly RiskFlag[]): RiskLevel {
  const has = (f: RiskFlag) => flags.includes(f);
  // unscanned stands in for unscopedBash too: an oversized frontmatter hides `allowed-tools: Bash` from the check
  if ((has('shellInjection') && (has('unscopedBash') || has('unscanned'))) || has('curlPipeShell') || has('commandSource')) return 'high';
  if (flags.some((f) => !INFO_ONLY.has(f))) return 'medium';
  return 'low';
}

export const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

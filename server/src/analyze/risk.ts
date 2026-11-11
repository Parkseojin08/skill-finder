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
  | 'hiddenContent'
  // B5 (feature review 3.3, decision 9)
  | 'obfuscatedExec'
  | 'claudeConfigTamper'
  | 'credentialAccess'
  | 'exfilEndpoint'
  | 'persistence'
  | 'promptInjectionPhrase'
  | 'preapprovedNetwork'
  | 'preapprovedWrite'
  | 'sensitiveReadNetwork';

export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * Bumped whenever a rule reading the SKILL.md text changes, so rows checked under older rules are checked
 * again (stored per row, and part of the search cache key). 2: the wider download-and-run rule (U3).
 * 3: hiddenContent, text the rendered page hides but Claude reads (feature review F2, decision 8).
 * The rule table below (feature review F1) gives the same flags as the checks it replaced; only where they matched
 * is new, so the version stays. 4: the malicious-pattern rules (B5, decision 9): obfuscated execution, Claude
 * settings tampering, credential access, exfiltration endpoints, persistence, prompt-injection phrases and the
 * allowed-tools network / write signals.
 */
export const RISK_RULES_VERSION = 4;

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
  'obfuscatedExec',
  'claudeConfigTamper',
  'credentialAccess',
  'exfilEndpoint',
  'persistence',
  'promptInjectionPhrase',
  'preapprovedNetwork',
  'preapprovedWrite',
  'sensitiveReadNetwork',
]);

/**
 * Text signals as serious as download-and-run: a file or command with one needs the install's confirm tick, as
 * `curlPipeShell` does (install/record.ts scanNeedsTick and the page's scanIsHigh read this set).
 */
export const TICK_FLAGS: ReadonlySet<RiskFlag> = new Set<RiskFlag>(['curlPipeShell', 'obfuscatedExec', 'claudeConfigTamper']);

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
  /**
   * The whole text is code (a script, a hook or MCP command line), so the command rules of B5 read all of it. Off
   * (Markdown: SKILL.md, references), they read only where commands are written: the frontmatter, fenced blocks
   * and inline code of more than one word (commandSpans), so a sentence that warns against a command is not one.
   */
  wholeCode?: boolean;
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

// ── allowed-tools kinds (feature review F1; permissions.ts re-exports these) ─────────────────────────────────────

export type PermissionKind = 'shell' | 'read' | 'write' | 'network' | 'mcp' | 'autorun';
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const NET_TOOLS = new Set(['WebFetch', 'WebSearch']);
/** A pre-approved shell command that reaches the network: `Bash(curl:*)`, `Bash(git push:*)`. */
const NET_COMMAND = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|ssh|scp|rsync|ftp|nc|gh|git[ \t]+(?:push|pull|fetch|clone))\b/i;

/** The kinds one allowed-tools entry grants, by its tool name (`Bash(git:*)` → shell; `Bash(curl:*)` also network). */
export function toolKinds(tool: string): PermissionKind[] {
  const t = tool.trim();
  const name = t.match(/^[A-Za-z_][\w-]*/)?.[0] ?? '';
  const open = t.indexOf('(');
  const inner = open >= 0 && t.endsWith(')') ? t.slice(open + 1, -1) : '';
  if (name.startsWith('mcp__')) return ['mcp'];
  if (SHELL_TOOLS.has(name)) return NET_COMMAND.test(inner) ? ['shell', 'network'] : ['shell'];
  if (READ_TOOLS.has(name)) return ['read'];
  if (WRITE_TOOLS.has(name)) return ['write'];
  if (NET_TOOLS.has(name)) return ['network'];
  return [];
}

// ── B5: malicious-pattern rules (feature review 3.3, decision 9) ─────────────────────────────────────────────────
// Every check is linear in the text (D#4de9): the regexes start with a fixed word and never scan past a bounded
// stretch, and the per-line checks run once per line on that line alone. In Markdown the command rules count only
// where commands are written (commandSpans): "never read ~/.ssh/id_rsa" in a sentence, or a lone `~/.ssh/id_rsa`
// in backticks, is a warning, not a command. Address and phrase rules read the prose too: Claude follows prose.

/** [start, end) and, for inline code, a third element 1. */
type Span = [number, number] | [number, number, 1];
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;
/** Fences whose contents are prose or an example document, not commands. */
const PROSE_FENCE = /^(?:markdown|md|mdx|text|txt|plain|plaintext|prompt)$/i;
const FM_LINE = /^(?:---|\.\.\.)[ \t]*\r?$/;

/**
 * Where a Markdown file writes commands, as sorted [start, end) offsets: its YAML frontmatter, fenced code blocks
 * (other than markdown/text ones) and inline code that holds more than one word or follows `!` (`!`cmd``). One pass.
 */
export function commandSpans(raw: string): Span[] {
  const spans: Span[] = [];
  const lineEnd = (p: number) => {
    const e = raw.indexOf('\n', p);
    return e < 0 ? raw.length : e;
  };
  let pos = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const first = lineEnd(pos);
  if (/^---[ \t]*\r?$/.test(raw.slice(pos, Math.min(first, pos + 20)))) {
    for (let ls = first + 1; ls < raw.length; ) {
      const le = lineEnd(ls);
      if (FM_LINE.test(raw.slice(ls, Math.min(le, ls + 20)))) {
        spans.push([0, le]);
        pos = le + 1;
        break;
      }
      ls = le + 1;
    }
  }
  let fence: { ch: string; len: number; start: number; prose: boolean } | null = null;
  let nextTick = -1;
  for (let ls = pos; ls <= raw.length; ) {
    const le = lineEnd(ls);
    const m = FENCE_LINE.exec(raw.slice(ls, Math.min(le, ls + 200)));
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && raw.slice(ls + m[0].length, le).trim() === '') {
        if (!fence.prose) spans.push([fence.start, le]);
        fence = null;
      }
    } else if (m && !(m[1][0] === '`' && raw.slice(ls + m[0].length, le).includes('`'))) {
      const info = raw.slice(ls + m[0].length, Math.min(le, ls + m[0].length + 100)).trim().split(/[\s{,]/)[0];
      fence = { ch: m[1][0], len: m[1].length, start: ls, prose: PROSE_FENCE.test(info) };
    } else {
      if (nextTick >= 0 && nextTick < ls) nextTick = -1;
      if (nextTick < 0) {
        nextTick = raw.indexOf('`', ls);
        if (nextTick < 0) nextTick = raw.length + 1;
      }
      if (nextTick < le) inlineCode(raw, nextTick, le, spans);
    }
    ls = le + 1;
  }
  if (fence && !fence.prose) spans.push([fence.start, raw.length]);
  return spans;
}

/** Inline code spans of one line (from its first backtick `from` to its end `le`): a run of n backticks closes at the next run of n. */
function inlineCode(raw: string, from: number, le: number, spans: Span[]): void {
  const runs: Array<[number, number]> = [];
  for (let i = from; i < le; ) {
    if (raw.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i;
    while (j < le && raw.charCodeAt(j) === 96) j++;
    runs.push([i, j - i]);
    i = j;
  }
  const next = new Array<number>(runs.length);
  const last = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    next[i] = last.get(runs[i][1]) ?? -1;
    last.set(runs[i][1], i);
  }
  for (let i = 0; i < runs.length; ) {
    const j = next[i];
    if (j < 0) {
      i++;
      continue;
    }
    const [s, n] = runs[i];
    const inner = raw.slice(s + n, runs[j][0]).trim();
    if (/\s/.test(inner) || (s > 0 && raw.charCodeAt(s - 1) === 33)) spans.push([s, runs[j][0] + n, 1]);
    i = j + 1;
  }
}

const spanCache = new WeakMap<SkillRiskInput, Span[]>();
const joinCache = new WeakMap<SkillRiskInput, ReturnType<typeof joinContinuations>>();
const joined = (i: SkillRiskInput) => {
  let j = joinCache.get(i);
  if (!j) joinCache.set(i, (j = joinContinuations(i.raw)));
  return j;
};

/** The command span holding a `raw` offset (all of the text when `wholeCode`), or null. */
function commandSpanAt(input: SkillRiskInput): (offset: number) => Span | null {
  if (input.wholeCode) {
    const all: Span = [0, input.raw.length];
    return () => all;
  }
  let spans = spanCache.get(input);
  if (!spans) spanCache.set(input, (spans = commandSpans(input.raw)));
  const s = spans;
  return (o) => {
    let lo = 0;
    let hi = s.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid][1] <= o) lo = mid + 1;
      else if (s[mid][0] > o) hi = mid - 1;
      else return s[mid];
    }
    return null;
  };
}

/**
 * Offsets (into `text`) of the first accepted `re` match on each line for which `ok(line, at)` holds (`at`: the match's
 * offset in the line), at most `limit`. `accept` gives the stretch of `text` the match may be judged in (its command
 * span, so an inline `base64 -d` is not joined with a `| sh` in the sentence around it), or null to pass it over. Each
 * line is sliced and tested once, then the search moves to the next line.
 */
function lineMatches(
  text: string,
  re: RegExp,
  accept: (offset: number) => Span | null,
  ok: ((line: string, at: number) => boolean) | null,
  limit: number,
  skipComments: boolean,
): number[] {
  const out: number[] = [];
  // the current line's [start, end), moved forward only (matches come in order), so finding lines stays linear
  let ls = 0;
  let le = -1;
  re.lastIndex = 0;
  for (let m: RegExpExecArray | null; out.length < limit && (m = re.exec(text)); ) {
    if (m[0].length === 0) re.lastIndex++;
    if (m.index > le) {
      if (le >= 0) ls = le + 1;
      for (let nl = text.indexOf('\n', ls); nl >= 0 && nl < m.index; nl = text.indexOf('\n', ls)) ls = nl + 1;
      le = text.indexOf('\n', m.index);
      if (le < 0) le = text.length;
    }
    // a comment line of a script or code block (`# check crontab persistence`) runs nothing
    if (skipComments && COMMENT_LINE.test(text.slice(ls, Math.min(le, ls + 40)))) {
      re.lastIndex = Math.max(re.lastIndex, le + 1);
      continue;
    }
    const span = accept(m.index);
    if (!span) continue;
    if (!ok) {
      out.push(m.index);
      continue;
    }
    const s = Math.max(ls, span[0]);
    const e = Math.min(le, span[1]);
    if (ok(text.slice(s, e), m.index - s)) out.push(m.index);
    // inline code ends inside the line: the rest of the line may hold other inline code
    re.lastIndex = Math.max(re.lastIndex, e < le ? e : le + 1);
  }
  re.lastIndex = 0;
  return out;
}

const COMMENT_LINE = /^[ \t]*(?:#(?!!)|\/\/|--[ \t]|;|REM\b|::)/i;

type LineRule = { re: RegExp; ok?: (line: string, at: number) => boolean; anywhere?: boolean };

/**
 * Words that make the sentence around an inline command a warning or a prohibition ("Do not run `cat .env`", "Same
 * risk for `cat .env`"). Read in the paragraph before the inline code only, at most 300 characters.
 */
const WARNING_WORDS =
  /\b(?:never|don'?t|do[ \t]+not|must[ \t]+not|mustn'?t|should[ \t]+not|shouldn'?t|avoid|forbid(?:den)?|prohibit(?:ed)?|not[ \t]+allowed|refuse|risk|danger(?:ous)?|unsafe|malicious|malware|attacks?|attackers?|instead[ \t]+of)\b|금지|하지[ \t]*마|않도록|禁止|しない/i;

/** An inline command inside a warning: the paragraph before it (up to a blank line) says not to, or why it is risky. */
function warnedAbout(raw: string, start: number): boolean {
  let before = raw.slice(Math.max(0, start - 300), start);
  let para = -1;
  for (const m of before.matchAll(/\n[ \t]*\r?\n/g)) para = m.index;
  if (para >= 0) before = before.slice(para);
  return WARNING_WORDS.test(before);
}

/** Hits of line rules over the input's text (continuations joined), as `raw` offsets; command-only unless `anywhere`. */
function scanLines(input: SkillRiskInput, rules: readonly LineRule[], limit: number): number[] {
  const { text, toRaw } = joined(input);
  const spanAt = commandSpanAt(input);
  const all: Span = [0, text.length];
  // a raw span as offsets of the joined text around the match at `o` (inline spans hold no continuation); inline code
  // in a warning is passed over
  const toText = (o: number): Span | null => {
    const r = toRaw(o);
    const s = spanAt(r);
    if (!s || (s[2] === 1 && warnedAbout(input.raw, s[0]))) return null;
    return [o - (r - s[0]), o + (s[1] - r)];
  };
  const hits: number[] = [];
  for (const r of rules) {
    if (hits.length >= limit) break;
    hits.push(...lineMatches(text, r.re, r.anywhere ? () => all : toText, r.ok ?? null, limit - hits.length, !r.anywhere));
  }
  return firstN(hits.map(toRaw), limit);
}

const after = (line: string, at: number, re: RegExp) => re.test(line.slice(at));
const before = (line: string, at: number, re: RegExp) => re.test(line.slice(0, at));

// obfuscatedExec (high): decoded text run by a shell or interpreter.
const TO_SHELL = /\|[ \t]*(?:sudo[ \t]+(?:-[^\s|]+[ \t]+)*)?(?:\/[^\s|]*\/)?(?:env[ \t]+)?(?:(?:(?:ba|z|da|k)?sh|iex|invoke-expression)\b|(?:python[0-9.]*|node|perl|ruby)(?:[ \t]+-)?(?=[ \t]*(?:[;&)'"`]|$)))/i;
/**
 * The decode's output is what gets run: at the decode it is inside a substitution that a runner takes (`eval "$(… |
 * base64 -d)"`, `sh -c "$(…)"`, `source <(…)`), or the substitution is itself the command (`$(echo … | base64 -d)`).
 * Read on the text before the decode, to its end: the substitution must still be open there (no `)` since), within
 * 300 characters. A runner merely earlier on the line is not it: `docker exec app sh -c "echo $CERT | base64 -d >
 * cert.pem"`, `source .env && echo "$KEY" | base64 -d > key.bin` and `eval "$(ssh-agent -s)" && echo "$KEY" | base64
 * -d | ssh-add -` decode into a file or another program (they were "높음"; review 2026-11-10).
 */
const RUNS_SUBST =
  /\b(?:eval|source)[ \t]+["']?(?:(?:\$\(|<\()[^)\n]{0,300}|`[^`\n]{0,300})$|\b(?:(?:ba|z|da|k)?sh|python[0-9.]*|node|perl|ruby)[ \t]+-[ce][ \t]+["']?(?:\$\([^)\n]{0,300}|`[^`\n]{0,300})$|(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh|\.)[ \t]+<\([^)\n]{0,300}$|(?:^|[;&|])[ \t]*\$\([^)\n]{0,300}$/i;
const OBFUSCATED: readonly LineRule[] = [
  // `echo … | base64 -d | sh`, `eval "$(echo … | base64 --decode)"`, `certutil -decode`, `xxd -r -p | sh`
  { re: /\bbase64\b[ \t]+(?:-[a-zA-Z]*[dD][a-zA-Z]*\b|--decode\b)|\bcertutil(?:\.exe)?[ \t]+-decode\b|\bxxd[ \t]+-r\b/gi, ok: (l, at) => after(l, at, TO_SHELL) || before(l, at, RUNS_SUBST) },
  // `powershell -EncodedCommand <base64>` (also -enc, -ec, -e)
  { re: /\b(?:powershell|pwsh)(?:\.exe)?\b/gi, ok: (l, at) => after(l, at, /(?:^|[ \t])[-/](?:e|ec|enc[a-z]*)[ \t]+["']?[A-Za-z0-9+/]{20,}/i) },
  // `iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(…)))`
  { re: /FromBase64String/gi, ok: (l) => /\b(?:iex|invoke-expression)\b|\[scriptblock\]::create/i.test(l) },
  // `exec(base64.b64decode(…))`, `eval(atob(…))`, `exec(__import__('zlib').decompress(…))`, `eval(Buffer.from(…))`
  {
    re: /\b(?:exec|eval)[ \t]*\([ \t]*(?:(?:[\w$]+\.){0,3}(?:b64decode|b32decode|b16decode|b85decode|a85decode|decodebytes|decodestring|atob|unhexlify|fromhex|decompress|fromCharCode|loads)[ \t]*\(|__import__[ \t]*\([ \t]*['"](?:base64|zlib|codecs|binascii|marshal|bz2|lzma)['"]|Buffer\.from[ \t]*\()|\bFunction[ \t]*\([ \t]*atob[ \t]*\(/g,
  },
];

// claudeConfigTamper (high): writing Claude Code's settings, or turning its permission checks off.
// the file itself, not a copy named after it: `settings.json.bak` and `settings.json-old` are backups (copying the
// settings to one was "높음"; review 2026-11-10)
const SETTINGS_PATH = /\.claude[\\/]+settings(?:\.local)?\.json(?!\.?[\w-])|["']\.claude["'][ \t]*[,/][ \t]*["']settings(?:\.local)?\.json["']/i;
const WRITE_CALL = /\b(?:writeFile(?:Sync)?|write_text|write_bytes|writeText|json\.dump|Set-Content|Out-File|Add-Content|WriteAllText|appendFile(?:Sync)?)\b|\bopen[ \t]*\([^\n]{0,300}?['"][wax]\+?b?['"]/i;
const SEGMENT_WRITER = /^(?:sudo[ \t]+)?(?:cp|mv|copy|move|install|ln|tee|sed|Copy-Item|Move-Item|New-Item)\b/i;

/** The settings file is written on this line: redirected into, a writer command's argument, or a write call's. */
function writesSettings(line: string): boolean {
  if (/>{1,2}[ \t]*["']?[^\s"'<>|;&]*\.claude[\\/]+settings(?:\.local)?\.json(?!\.?[\w-])/i.test(line)) return true;
  if (WRITE_CALL.test(line) && SETTINGS_PATH.test(line)) return true;
  for (const seg of line.split(/[|;&]+/)) {
    const s = seg.trim();
    if (!SEGMENT_WRITER.test(s) || !SETTINGS_PATH.test(s)) continue;
    // sed edits in place only with -i; the others write the last argument (cp a b, tee file)
    if (/^(?:sudo[ \t]+)?sed\b/i.test(s)) {
      if (/(?:^|[ \t])-[a-zA-Z]*i/.test(s)) return true;
    } else if (/^(?:sudo[ \t]+)?tee\b/i.test(s) || SETTINGS_PATH.test(s.split(/[ \t]+/).pop() ?? '')) return true;
  }
  return false;
}

const CONFIG_TAMPER: readonly LineRule[] = [
  { re: /\.claude[\\/]+settings(?:\.local)?\.json\b|["']\.claude["'][ \t]*[,/][ \t]*["']settings/gi, ok: (l) => writesSettings(l) },
  // a launch that skips every permission prompt: `claude --dangerously-skip-permissions`
  { re: /--(?:allow-)?dangerously-skip-permissions\b/g, ok: (l, at) => before(l, at, /\bclaude(?:\.exe|\.cmd)?\b/i) },
  // the permission mode set to bypass in settings, an agent's frontmatter or SDK options: "defaultMode":
  // "bypassPermissions", `permissionMode: bypassPermissions`, `permission_mode="bypassPermissions"`. The `:`/`=` is
  // required and sits between the two runs of blanks: with both optional and adjacent, a long run of spaces after the
  // key was quadratic (16KB took 0.8s; found by the timing sweep, 2026-11-10).
  { re: /\b(?:defaultMode|permissionMode|permission_mode)["']?[ \t]*[:=][ \t]*["']?bypassPermissions\b/gi },
  // the same as a launch flag: `claude --permission-mode bypassPermissions` (with `claude` on the line, as for the
  // skip flag: a sentence comparing `--permission-mode bypassPermissions` with another option launches nothing; one
  // of 800 sampled skills went to "높음" for that), or as two arguments of a spawn: "--permission-mode", "bypassPermissions"
  { re: /--permission-mode(?:[ \t]+|=)["']?bypassPermissions\b/g, ok: (l, at) => before(l, at, /\bclaude(?:\.exe|\.cmd)?\b/i) },
  { re: /["']--permission-mode["'][ \t]*,[ \t]*["']bypassPermissions["']/g },
];

// credentialAccess (medium): reading key and token files, the browser's saved logins, the keychain; secrets sent off.
// Case kept: `git reset HEAD .env` is not `head`, a JSON "type" key is not Windows `type`.
const READ_VERB =
  /\b(?:cat|less|more|head|tail|strings|xxd|od|base64|cp|scp|rsync|tar|zip|7z|curl|wget|nc|ncat|openssl|Get-Content|get-content|gc|readFile(?:Sync)?|read_text|read_bytes|readlines|Copy-Item|copy-item|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b|\bopen[ \t]*\(|^[ \t]*open\b|<[ \t]*["']?(?:~|\$HOME)/;
const DOTENV_READ = /\b(?:cat|less|more|head|tail|strings|xxd|base64|curl|wget|nc|scp|Get-Content|get-content|gc|readFile(?:Sync)?|read_text)\b/;
const OPEN_CALL = /\bopen[ \t]*\(/;
/** `open(".env", "w")`: the file is created or written, not read (a set-up script writing its own config). */
const OPEN_FOR_WRITE = /\bopen[ \t]*\([ \t]*["'][^"'\n]{0,200}\.env["'][ \t]*,[ \t]*["'][wax]/;
/** Lines about tracking `.env` in git, not reading it: `git rm --cached .env`, `echo .env >> .gitignore`. */
const DOTENV_GIT = /\bgit[ \t]+(?:rm|add|reset|restore|checkout|update-index|ls-files|check-ignore|status)\b|\.gitignore\b/;
const SECRET_HOSTS: Array<[RegExp, string[]]> = [
  [/ANTHROPIC|CLAUDE_CODE_OAUTH/, ['anthropic.com', 'claude.ai']],
  [/OPENAI/, ['openai.com', 'azure.com']],
  [/AWS_/, ['amazonaws.com', 'amazon.com']],
  [/GITHUB|GH_TOKEN/, ['github.com', 'githubusercontent.com', 'ghcr.io']],
  [/NPM_TOKEN/, ['npmjs.org', 'npmjs.com']],
  [/GOOGLE|GEMINI/, ['googleapis.com', 'google.com']],
  [/HF_TOKEN/, ['huggingface.co', 'hf.co']],
  [/SLACK/, ['slack.com']],
  [/STRIPE/, ['stripe.com']],
];
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[\w-]+\.(?:localhost|local|test|example|invalid)|example\.(?:com|org|net))$/i;

/** A secret variable on a line that also sends to a host other than the secret's own service (or this PC). */
function sendsSecretAway(line: string, at: number): boolean {
  const name = /[A-Z][A-Z0-9_]*/.exec(line.slice(at).replace(/^[^A-Z]*/, ''))?.[0] ?? '';
  const own = SECRET_HOSTS.find(([re]) => re.test(name))?.[1] ?? [];
  // the host after any `user:token@` (a token in a GitHub remote URL goes to github.com)
  for (const m of line.matchAll(/\b(?:https?|wss?):\/\/(?:[^\s/@'"`]{0,200}@)?([A-Za-z0-9.-]{1,253})/g)) {
    const host = m[1].toLowerCase().replace(/\.$/, '');
    if (LOCAL_HOST.test(host)) continue;
    if (!own.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  }
  return false;
}

const CREDENTIALS: readonly LineRule[] = [
  // private keys and token files, read or copied (not used: `ssh -i ~/.ssh/id_rsa`, `ssh-add`, a `.pub` key)
  {
    re: /\.ssh[\\/]+(?:id_[A-Za-z0-9_-]+(?![A-Za-z0-9_-]|\.pub)|identity\b(?!\.pub))|\.aws[\\/]+credentials\b|\.claude[\\/]+\.credentials\.json|\.config[\\/]+gh[\\/]+hosts\.ya?ml|\.docker[\\/]+config\.json|\.kube[\\/]+config\b|\.gnupg[\\/]|(?:^|[\s"'/\\=])\.(?:netrc|git-credentials|pgpass)\b/gi,
    ok: (l) => READ_VERB.test(l),
  },
  // `.env` printed, sent or read in code (not `cp .env.example .env`, `cat > .env <<EOF`, `source .env`, a file
  // opened for writing, or `process\.env` inside a search pattern: both were hits among 800 sampled skills)
  {
    re: /(?:^|[\s"'(/\\=@])(?<!process\\)\.env(?![\w.-])/g,
    ok: (l) => (DOTENV_READ.test(l) || (OPEN_CALL.test(l) && !OPEN_FOR_WRITE.test(l))) && !DOTENV_GIT.test(l) && !/>{1,2}[ \t]*["']?(?:\.\/)?\.env\b/.test(l) && !/^[ \t]*(?:sudo[ \t]+)?(?:cp|mv)\b/.test(l),
  },
  // a secret variable sent to another host
  {
    re: /(?:\$\{?|\$env:|process\.env\.|process\.env\[["']|os\.environ(?:\.get)?[[(]["']|getenv\(["'])(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|GOOGLE_API_KEY|GEMINI_API_KEY|HF_TOKEN|SLACK_BOT_TOKEN|STRIPE_SECRET_KEY)\b/g,
    ok: sendsSecretAway,
  },
  // the whole environment sent off or dumped as JSON
  { re: /\b(?:printenv|env|set|Get-ChildItem[ \t]+env:|gci[ \t]+env:)[ \t]*\|[ \t]*(?:curl|wget|nc|ncat|base64|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b|JSON\.stringify\([ \t]*process\.env[ \t]*[,)]|json\.dumps?\([ \t]*(?:dict\([ \t]*)?os\.environ\b/g },
  // browsers' saved passwords and cookies, the macOS keychain, the Windows vault
  { re: /\bLogin Data\b|\bkey4\.db\b|\b(?:Chrome|Chromium|Edge|Brave)[^\n]{0,80}[\\/](?:Default|Profile[ \w]{0,10})[\\/](?:Network[\\/])?Cookies\b/g },
  { re: /\bsecurity[ \t]+(?:find-generic-password|find-internet-password|dump-keychain)\b|\bvaultcmd(?:\.exe)?[ \t]+\/list|\bcmdkey(?:\.exe)?[ \t]+\/list\b/gi },
];

// exfilEndpoint (medium): request catchers, tunnels, paste sites, chat webhooks and bare public IP addresses. In prose
// only as an address (`https://webhook.site/…`): a list of such services in a security skill names them, nothing more.
// subdomains (abc.m.pipedream.net, x.ngrok-free.app) match at the name: a word boundary follows the dot
const EXFIL_NAMES = String.raw`(?:webhook\.site|requestbin\.(?:com|net)|pipedream\.net|discord(?:app)?\.com\/api\/webhooks\/|pastebin\.com|paste\.ee|hastebin\.com|ghostbin\.\w+|transfer\.sh|interact\.sh|burpcollaborator\.net|canarytokens\.com|requestcatcher\.com|beeceptor\.com|hookbin\.com|ngrok(?:-free)?\.(?:io|app|dev)|oast\.(?:fun|live|me|online|pro|site))\b`;
const EXFIL_URL = new RegExp(String.raw`\b(?:https?|wss?):\/\/(?:[^\s/@'"\x60]{0,200}@)?(?:[A-Za-z0-9-]{1,63}\.){0,4}${EXFIL_NAMES}`, 'gi');
const EXFIL_HOST = new RegExp(String.raw`\b${EXFIL_NAMES}`, 'gi');
const IP_URL = /\b(?:https?|ftp|wss?|tcp):\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])|\/dev\/(?:tcp|udp)\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\//gi;

const PUBLIC_RESOLVERS = new Set(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', '208.67.222.222', '208.67.220.220']);

/** A public IPv4 address (not private, loopback, link-local, shared, documentation, multicast or reserved). */
export function isPublicIp(o: number[]): boolean {
  const [a, b, c] = o;
  if (o.some((x) => !(x >= 0 && x <= 255))) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || (a === 198 && (b === 18 || b === 19))) return false;
  // public DNS resolvers' own pages (https://1.1.1.1/purge-cache/), not someone's server
  if (PUBLIC_RESOLVERS.has(o.join('.'))) return false;
  return true;
}

function exfilHits(input: SkillRiskInput, limit: number): number[] {
  const hits = scanLines(input, [{ re: EXFIL_URL, anywhere: true }, { re: EXFIL_HOST }], limit);
  IP_URL.lastIndex = 0;
  for (let m: RegExpExecArray | null; hits.length < limit && (m = IP_URL.exec(input.raw)); ) {
    const octets = (m[1] != null ? m.slice(1, 5) : m.slice(5, 9)).map(Number);
    if (isPublicIp(octets)) hits.push(m.index);
  }
  IP_URL.lastIndex = 0;
  return firstN(hits, limit);
}

// persistence (medium): something set to run again later: cron, shell start-up files, scheduled tasks, Run keys, launchd.
const RC_FILE = String.raw`\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|zlogin|config[\\/]fish[\\/]config\.fish)\b`;
const PERSISTENCE: readonly LineRule[] = [
  // installing a crontab: `crontab -e`, `… | crontab -`, `crontab - < jobs.txt`, `crontab jobs.txt` (not `crontab -l`,
  // which lists). The `-` alone reads stdin: at a line's end too (`$` is the text's end without the m flag).
  { re: /\|[ \t]*crontab\b|\bcrontab[ \t]+(?:-u[ \t]+\S+[ \t]+)?(?:-e\b|-(?=[ \t]*(?:$|[;&|)<\r\n]))|["']?[~$\w.-]*[/.][^\s;&|]*)/g },
  { re: /\/etc\/cron(?:\.d|\.daily|\.hourly|\.weekly|\.monthly|tab)\b/g, ok: (l) => />|\btee\b|\b(?:cp|mv|install)\b/.test(l) },
  { re: new RegExp(String.raw`>{1,2}[ \t]*["']?(?:~|\$HOME|\$\{HOME\}|\/root|\/home\/[\w.-]+|\/Users\/[\w.-]+)?[\\/]?${RC_FILE}`, 'g') },
  { re: new RegExp(String.raw`\btee[ \t]+(?:-a[ \t]+)?["']?[^\s"']*${RC_FILE}`, 'g') },
  { re: />{1,2}[ \t]*["']?\$PROFILE\b|\b(?:Add-Content|Set-Content|Out-File)\b[^\n|;]{0,200}\$PROFILE\b/gi },
  { re: /\bschtasks(?:\.exe)?[ \t]+\/create\b|\bRegister-ScheduledTask\b/gi },
  // a Run key or the Startup folder written (not `reg query …\Run`, a list of IOCs, an analysis report)
  { re: /CurrentVersion\\+Run(?:Once|Services)?\b|\\Start Menu\\+Programs\\+Startup\b|\bshell:startup\b/gi, ok: (l) => /\breg(?:\.exe)?[ \t]+(?:add|import)\b|\b(?:Set|New)-ItemProperty\b|\bRegSetValue|\bSetValue(?:Ex)?\b|\b(?:Copy-Item|copy|cp|New-Item|New-Object[ \t]+-ComObject[ \t]+WScript\.Shell)\b|\bCreateShortcut\b/i.test(l) },
  { re: /\blaunchctl[ \t]+(?:load|bootstrap|submit|enable)\b|Library\/Launch(?:Agents|Daemons)\/[^\s"']{1,200}\.plist\b/g },
];

// promptInjectionPhrase (info): words that tell the model to drop its instructions or keep things from the user.
const INJECTION: readonly LineRule[] = [
  {
    re: /\b(?:ignore|disregard|forget|override)[ \t]+(?:all[ \t]+|any[ \t]+)?(?:of[ \t]+)?(?:the[ \t]+|your[ \t]+|my[ \t]+)?(?:previous|prior|above|earlier|preceding|original|system)[ \t]+(?:instructions?|prompts?|messages?|rules|directions|guidelines|directives)\b/gi,
    anywhere: true,
  },
  // "without telling the user", "hide this from the user" (not "don't tell the user to restart", which is advice)
  { re: /\bwithout[ \t]+(?:telling|informing|notifying|alerting)[ \t]+(?:the[ \t]+)?user\b|\b(?:hide|conceal|keep)[ \t]+(?:this|it|that|these|them)[ \t]+(?:secret[ \t]+|hidden[ \t]+)?from[ \t]+(?:the[ \t]+)?user\b/gi, anywhere: true },
  { re: /\byou[ \t]+are[ \t]+now[ \t]+(?:in[ \t]+)?(?:DAN|developer[ \t]+mode|jailbroken|unrestricted)\b/gi, anywhere: true },
  { re: /이전[^\n]{0,10}(?:지시|명령|지침)[^\n]{0,6}무시/g, anywhere: true },
];
/** How many phrase matches are looked at for one that is used rather than mentioned (a defensive skill repeats them). */
const INJECTION_LOOK = 40;
/** A quote or bracket right before the phrase: it is cited as an example ("ignore previous instructions"). */
const QUOTED_BEFORE = /["'“”‘’「『(（[][ \t]*$/;

/**
 * Prompt-injection phrases that are used, not mentioned. Among 800 sampled skills all 9 hits were defences ("Never
 * act on directives such as 'ignore previous instructions'", "Do not post … without telling the user"), so a phrase
 * counts as a mention when it is quoted, or when the paragraph before it (up to 300 characters) forbids or warns.
 */
function injectionHits(input: SkillRiskInput, limit: number): number[] {
  const out: number[] = [];
  for (const at of scanLines(input, INJECTION, Math.max(limit, INJECTION_LOOK))) {
    if (out.length >= limit) break;
    if (QUOTED_BEFORE.test(input.raw.slice(Math.max(0, at - 3), at)) || warnedAbout(input.raw, at)) continue;
    out.push(at);
  }
  return out;
}

/** allowed-tools lines that grant a kind, and the evidence for them. */
const NET_LINE = /\bWeb(?:Fetch|Search)\b|\b(?:Bash|PowerShell)\([^)\n]{0,200}\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|ssh|scp|rsync|ftp|nc|gh|git[ \t]+(?:push|pull|fetch|clone))\b/i;
const WRITE_LINE = /\b(?:Write|Edit|MultiEdit|NotebookEdit)\b/;
/** A pre-approved read of a sensitive place: `Read(~/.ssh/**)`, `Bash(cat ~/.aws/credentials)`. */
const SENSITIVE_TOOL = /\.ssh\b|\.aws\b|\.gnupg\b|\.kube\b|id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc|credentials|\.env\b|Login Data|keychain/i;

const grants = (i: SkillRiskInput, kind: PermissionKind) => i.allowedTools.some((t) => toolKinds(t).includes(kind));
const sensitiveTools = (i: SkillRiskInput) => i.allowedTools.filter((t) => (toolKinds(t).includes('read') || toolKinds(t).includes('shell')) && t.includes('(') && SENSITIVE_TOOL.test(t));

const credentialHits = (i: SkillRiskInput, limit: number) => scanLines(i, CREDENTIALS, limit);

/**
 * "민감 경로 읽기 + 네트워크 사전 승인": a sensitive file is read (pre-approved, or by a command of the text) while the
 * network is pre-approved (a web tool, a network command, or Bash without limits), so it can leave without a prompt.
 */
function sensitiveReadNetworkHits(i: SkillRiskInput, limit: number): RuleHit[] {
  const network = grants(i, 'network') || i.allowedTools.some(isUnscopedBash);
  if (!network) return [];
  const tools = sensitiveTools(i);
  const reads: RuleHit[] = tools.length ? fmHits(i.raw, 'allowed-tools', (l) => SENSITIVE_TOOL.test(l), limit) : inRaw(credentialHits(i, limit));
  if (!reads.length) return [];
  const net = fmHits(i.raw, 'allowed-tools', (l) => NET_LINE.test(l) || BARE_BASH.test(l), limit);
  const seen = new Set<number | null>();
  return [...reads, ...net].filter((h) => 'at' in h && !seen.has(h.at) && (seen.add(h.at), true)).slice(0, limit);
}

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
  // B5 (decision 9)
  { flag: 'obfuscatedExec', scan: (i, limit) => inRaw(scanLines(i, OBFUSCATED, limit)) },
  { flag: 'claudeConfigTamper', scan: (i, limit) => inRaw(scanLines(i, CONFIG_TAMPER, limit)) },
  { flag: 'credentialAccess', scan: (i, limit) => inRaw(credentialHits(i, limit)) },
  { flag: 'exfilEndpoint', scan: (i, limit) => inRaw(exfilHits(i, limit)) },
  { flag: 'persistence', scan: (i, limit) => inRaw(scanLines(i, PERSISTENCE, limit)) },
  { flag: 'promptInjectionPhrase', scan: (i, limit) => inRaw(injectionHits(i, limit)) },
  { flag: 'preapprovedNetwork', scan: (i, limit) => (grants(i, 'network') ? fmHits(i.raw, 'allowed-tools', (l) => NET_LINE.test(l), limit) : []) },
  { flag: 'preapprovedWrite', scan: (i, limit) => (grants(i, 'write') ? fmHits(i.raw, 'allowed-tools', (l) => WRITE_LINE.test(l), limit) : []) },
  { flag: 'sensitiveReadNetwork', scan: sensitiveReadNetworkHits },
];

/** Flags of the rules that read text alone, so they also run on a skill's other files and a plugin's commands. */
const TEXT_FILE_FLAGS = new Set<RiskFlag>(['curlPipeShell', 'rmRf', 'obfuscatedExec', 'claudeConfigTamper', 'credentialAccess', 'exfilEndpoint', 'persistence', 'promptInjectionPhrase']);

/** The rules that apply outside SKILL.md (a skill's other files, a plugin's commands and scripts). */
export const TEXT_FILE_RULES: readonly RiskRule[] = SKILL_RULES.filter((r) => TEXT_FILE_FLAGS.has(r.flag));

/** Markdown and plain-text documents: their command rules read only where commands are written (commandSpans). */
const DOC_PATH = /\.(?:md|mdx|markdown|txt|rst)$/i;

/** The input the text-file rules read for one file: Markdown by its path, else all of it is code. */
export function textFileInput(text: string, path?: string): SkillRiskInput {
  return { files: [], allowedTools: [], body: '', hasHooks: false, raw: text, wholeCode: !(path && DOC_PATH.test(path)) };
}

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
  const found = riskEvidence(textFileInput(text, path), { path, perFlag, rules: TEXT_FILE_RULES });
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
// A prompt-injection phrase is shown but does not raise the level either (decision 9): the words also appear in
// skills that teach how to detect them.
const INFO_ONLY = new Set<RiskFlag>(['rmRf', 'pluginRootDependency', 'scripts', 'pluginBin', 'promptInjectionPhrase']);

export function riskLevel(flags: readonly RiskFlag[]): RiskLevel {
  const has = (f: RiskFlag) => flags.includes(f);
  // unscanned stands in for unscopedBash too: an oversized frontmatter hides `allowed-tools: Bash` from the check
  if ((has('shellInjection') && (has('unscopedBash') || has('unscanned'))) || has('curlPipeShell') || has('commandSource')) return 'high';
  // decision 9: decoded text run as code, and Claude Code's settings written or its permission checks turned off
  if (has('obfuscatedExec') || has('claudeConfigTamper')) return 'high';
  if (flags.some((f) => !INFO_ONLY.has(f))) return 'medium';
  return 'low';
}

export const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

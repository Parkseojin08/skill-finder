// What runs without asking and what is approved ahead, as the agents' own config files say (feature review F10).
// Read only: nothing here is changed, run or started (`claude mcp list` is not called: it can start servers). The
// files are Claude Code's (settings*.json, ~/.claude.json, .mcp.json, agents, commands, enabled plugins), Codex's
// (~/.codex/config.toml, hooks.json), Cursor's (mcp.json) and Gemini CLI's (settings.json). Their formats are the
// tools' own and partly undocumented: a file that cannot be read is listed as such, never guessed at.
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { extractSkillMeta } from '../analyze/frontmatter.ts';
import { skillRiskFlags, type RiskFlag } from '../analyze/risk.ts';
import { runConfigCommands } from '../indexer.ts';
import { pathKey } from '../install/installed.ts';
import { textFileFlags } from '../install/scan.ts';
import { MAX_FILE_BYTES } from '../util/textFiles.ts';
import { maskArgs, maskLine, unpinnedRunner, urlHost, type Unpinned } from './commands.ts';
import { parseToml, TomlError } from './toml.ts';

/** Largest config file read (a busy ~/.claude.json is a few MB), and most lines. */
export const CONFIG_MAX_BYTES = 8 * 1024 * 1024;
export const CONFIG_MAX_LINES = 200_000;
/** Most rows per group, and most agent/command files per folder. */
export const MAX_ROWS = 1000;
export const MAX_COMPONENT_FILES = 200;
/** Longest command shown (the rules still read all of it). */
const SHOW_MAX = 4000;

export type AgentKey = 'claude' | 'codex' | 'cursor' | 'gemini';
export type ConfigScope = 'user' | 'project' | 'local' | 'plugin';
export type Source = { agent: AgentKey; file: string; line: number | null; scope: ConfigScope; plugin?: string };
/** `tooLarge`/`tooManyLines`: over the caps above; `format`: not JSON/TOML as expected; `io`: could not be opened. */
export type Unreadable = 'tooLarge' | 'tooManyLines' | 'format' | 'io';
export type FileState = { agent: AgentKey; path: string; scope: ConfigScope; plugin?: string; state: 'read' | 'missing' | 'unreadable'; reason?: Unreadable; detail?: string };

export type RunKind = 'hook' | 'mcp' | 'monitor' | 'lsp' | 'statusLine' | 'helper';
export type RunRow = {
  kind: RunKind;
  /** hook: its event; mcp/lsp: the server's name; helper: the setting (apiKeyHelper …); monitor: its name if any. */
  name: string;
  matcher: string | null;
  /** A hook's type (command, http, prompt, agent). */
  hookType: string | null;
  transport: 'stdio' | 'http' | 'sse' | null;
  /** Program and args as written, secrets covered (maskArgs); `command` is the two joined, cut to SHOW_MAX. */
  program: string | null;
  args: string[];
  command: string | null;
  /** A remote server's host only. */
  host: string | null;
  envKeys: string[];
  headerKeys: string[];
  /** The text rules of the install check (download-and-run, rm -rf) on the whole command line. */
  flags: RiskFlag[];
  unpinned: Unpinned | null;
  /** off: switched off in the config; ask: a project .mcp.json server not yet approved (asked first). */
  state: 'on' | 'off' | 'ask';
  source: Source;
};
export type PermKind = 'allow' | 'defaultMode' | 'directory' | 'approval' | 'sandbox' | 'network' | 'trust' | 'autoAccept' | 'disableAllHooks';
export type PermRow = { kind: PermKind; value: string; note: 'broad' | 'sensitive' | null; flags: RiskFlag[]; source: Source };
export type ComponentRow = { kind: 'agent' | 'command'; name: string; path: string; allowedTools: string[]; flags: RiskFlag[]; source: Source };
export type PluginState = { id: string; scope: string; enabled: boolean; installPath: string | null };

export type AgentConfig = {
  projectPath: string | null;
  files: FileState[];
  run: RunRow[];
  permissions: PermRow[];
  components: ComponentRow[];
  plugins: PluginState[];
  /** Some group reached MAX_ROWS. */
  truncated: boolean;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const keysOf = (v: unknown): string[] => (isObj(v) ? Object.keys(v) : []);
const cut = (s: string) => (s.length > SHOW_MAX ? `${s.slice(0, SHOW_MAX)}…` : s);

/** A file read for its text, with a line lookup: positions of its line breaks, searched by halves. */
type Text = { text: string; lineAt: (pos: number) => number; cursor: number };

async function readText(path: string): Promise<{ text: string } | { state: 'missing' } | { state: 'unreadable'; reason: Unreadable }> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return { state: 'missing' };
  }
  if (!st.isFile()) return { state: 'unreadable', reason: 'io' };
  if (st.size > CONFIG_MAX_BYTES) return { state: 'unreadable', reason: 'tooLarge' };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { state: 'unreadable', reason: 'io' };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let lines = 1;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) if (++lines > CONFIG_MAX_LINES) return { state: 'unreadable', reason: 'tooManyLines' };
  return { text };
}

function textIndex(text: string): Text {
  const breaks: number[] = [];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) breaks.push(at);
  const lineAt = (pos: number) => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  return { text, lineAt, cursor: 0 };
}

/** The line of `needle`, looked for after the last one found (rows come in the file's order), else anywhere. */
function lineOf(t: Text | null, needle: string): number | null {
  if (!t || !needle) return null;
  let at = t.text.indexOf(needle, t.cursor);
  if (at < 0) at = t.text.indexOf(needle);
  if (at < 0) return null;
  t.cursor = at + needle.length;
  return t.lineAt(at);
}
const keyNeedle = (k: string) => `${JSON.stringify(k)}`;

/** JSON with // and /* *\/ comments (Gemini and Cursor allow them), comments dropped outside strings. One pass. */
function stripJsonComments(text: string): string {
  if (!text.includes('/')) return text;
  let out = '';
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '/' && text[i + 1] === '/') {
      out += text.slice(start, i);
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end - 1;
      start = i + 1;
    } else if (c === '/' && text[i + 1] === '*') {
      out += text.slice(start, i);
      const end = text.indexOf('*/', i + 2);
      // keep the line breaks of the comment so line numbers stay right
      const body = text.slice(i, end < 0 ? text.length : end + 2);
      out += body.replace(/[^\n]/g, ' ');
      i = end < 0 ? text.length : end + 1;
      start = i + 1;
    }
  }
  return out + text.slice(start);
}

type Collector = {
  home: string;
  projectPath: string | null;
  files: FileState[];
  run: RunRow[];
  permissions: PermRow[];
  components: ComponentRow[];
  truncated: boolean;
};

function push<T>(c: Collector, list: T[], row: T): void {
  if (list.length >= MAX_ROWS) c.truncated = true;
  else list.push(row);
}

/** Reads one config file and records how it went; the parsed value, or null. */
async function openConfig(c: Collector, agent: AgentKey, path: string, scope: ConfigScope, kind: 'json' | 'toml', plugin?: string): Promise<{ value: unknown; t: Text; tableLines?: Map<string, number> } | null> {
  const r = await readText(path);
  const base: FileState = { agent, path, scope, ...(plugin ? { plugin } : {}), state: 'read' };
  if (!('text' in r)) {
    c.files.push({ ...base, ...r });
    return null;
  }
  try {
    if (kind === 'toml') {
      const { data, tableLines } = parseToml(r.text);
      c.files.push(base);
      return { value: data, t: textIndex(r.text), tableLines };
    }
    const value = JSON.parse(stripJsonComments(r.text)) as unknown;
    c.files.push(base);
    return { value, t: textIndex(r.text) };
  } catch (err) {
    c.files.push({ ...base, state: 'unreadable', reason: 'format', detail: err instanceof TomlError ? `line ${err.line}` : undefined });
    return null;
  }
}

function commandRow(kind: RunKind, name: string, program: string | null, args: string[], source: Source, extra: Partial<RunRow> = {}): RunRow {
  const whole = [program ?? '', ...args].join(' ').trim();
  const shownProgram = program == null ? null : (args.length ? maskArgs([program])[0] : maskLine(program));
  const shownArgs = maskArgs(args);
  const command = shownProgram == null ? null : cut([shownProgram, ...shownArgs].join(' '));
  return {
    kind,
    name,
    matcher: null,
    hookType: null,
    transport: null,
    program: shownProgram,
    args: shownArgs,
    command,
    host: null,
    envKeys: [],
    headerKeys: [],
    flags: whole ? textFileFlags(whole) : [],
    unpinned: whole ? unpinnedRunner(program, args) : null,
    state: 'on',
    source,
    ...extra,
  };
}

/**
 * Hooks as Claude Code, Codex and Gemini CLI write them: `{ Event: [{ matcher?, hooks: [{ type, command | url }] }] }`.
 * Anything else under an event is read for its command lines only.
 */
function hookRows(c: Collector, hooks: unknown, src: Omit<Source, 'line'>, t: Text | null): void {
  if (!isObj(hooks)) return;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    lineOf(t, keyNeedle(event));
    for (const g of groups) {
      if (!isObj(g)) continue;
      const matcher = typeof g.matcher === 'string' ? g.matcher : null;
      const list = Array.isArray(g.hooks) ? g.hooks : [g];
      for (const h of list) {
        if (!isObj(h)) continue;
        const type = typeof h.type === 'string' ? h.type : 'command';
        if (typeof h.command === 'string' || Array.isArray(h.command)) {
          const line = typeof h.command === 'string' ? h.command : strings(h.command).join(' ');
          push(c, c.run, commandRow('hook', event, line, [], { ...src, line: lineOf(t, JSON.stringify(h.command)) }, { matcher, hookType: type }));
        } else if (typeof h.url === 'string') {
          push(c, c.run, commandRow('hook', event, null, [], { ...src, line: lineOf(t, keyNeedle('url')) }, { matcher, hookType: type, transport: 'http', host: urlHost(h.url), headerKeys: keysOf(h.headers) }));
        } else {
          // prompt / agent hooks: a model is asked, nothing is run on the PC
          push(c, c.run, commandRow('hook', event, null, [], { ...src, line: lineOf(t, keyNeedle('type')) }, { matcher, hookType: type }));
        }
      }
    }
  }
}

/** MCP (and LSP) servers: `{ name: { command, args, env, url, headers, … } }` in any of the four tools' shapes. */
function serverRows(c: Collector, servers: unknown, src: Omit<Source, 'line'>, t: Text | null, kind: 'mcp' | 'lsp' = 'mcp', lines?: (name: string) => number | null, state?: (name: string) => RunRow['state']): void {
  if (!isObj(servers)) return;
  for (const [name, s] of Object.entries(servers)) {
    if (!isObj(s)) continue;
    const program = typeof s.command === 'string' ? s.command : Array.isArray(s.command) ? (strings(s.command)[0] ?? null) : null;
    const args = Array.isArray(s.command) ? [...strings(s.command).slice(1), ...strings(s.args)] : strings(s.args);
    const url = typeof s.url === 'string' ? s.url : typeof s.httpUrl === 'string' ? s.httpUrl : typeof s.serverUrl === 'string' ? s.serverUrl : null;
    const type = typeof s.type === 'string' ? s.type.toLowerCase() : typeof s.transport === 'string' ? s.transport.toLowerCase() : null;
    const transport: RunRow['transport'] = type === 'sse' ? 'sse' : type === 'http' || type === 'streamable-http' || type === 'streamablehttp' || (url && !program) ? 'http' : 'stdio';
    const headerKeys = [...keysOf(s.headers), ...keysOf(s.http_headers), ...keysOf(s.env_http_headers), ...(typeof s.bearer_token_env_var === 'string' ? ['Authorization'] : [])];
    const line = lines ? lines(name) : lineOf(t, keyNeedle(name));
    const off = s.enabled === false || s.disabled === true;
    push(
      c,
      c.run,
      commandRow(kind, name, program, args, { ...src, line }, {
        transport: kind === 'lsp' ? null : transport,
        host: urlHost(url),
        envKeys: [...new Set([...keysOf(s.env), ...strings(s.env_vars)])],
        headerKeys: [...new Set(headerKeys)],
        state: off ? 'off' : (state?.(name) ?? 'on'),
      }),
    );
    // Gemini CLI: a trusted server's tools run without a confirmation
    if (s.trust === true) push(c, c.permissions, { kind: 'trust', value: name, note: 'broad', flags: [], source: { ...src, line } });
  }
}

/** A permission rule's weight: the whole of a tool (Bash, WebFetch, Write, an MCP server) or a sensitive path. */
export function permNote(value: string): PermRow['note'] {
  const v = value.trim();
  if (v === '*' || v === 'Bash' || /^Bash\(\s*(\*|:\*)?\s*\)$/.test(v)) return 'broad';
  if (v === 'WebFetch' || v === 'Write' || v === 'Edit' || v === 'MultiEdit' || v === 'NotebookEdit' || v === 'run_shell_command' || v === 'ShellTool') return 'broad';
  if (v.startsWith('mcp__') && (!v.slice(5).includes('__') || v.endsWith('__*'))) return 'broad';
  if (/(\.ssh|\.aws|\.gnupg|\.kube|id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc|credentials|\.env\b)/i.test(v)) return 'sensitive';
  return null;
}

function permRow(c: Collector, kind: PermKind, value: string, src: Omit<Source, 'line'>, t: Text | null): void {
  const flags = kind === 'allow' ? [...new Set([...skillRiskFlags({ files: [], allowedTools: [value], body: '', hasHooks: false, raw: '' }), ...textFileFlags(value)])] : [];
  const note =
    kind === 'allow'
      ? permNote(value)
      : kind === 'defaultMode'
        ? value === 'bypassPermissions' || value === 'dontAsk' || value === 'acceptEdits'
          ? 'broad'
          : null
        : kind === 'approval'
          ? value === 'never'
            ? 'broad'
            : null
          : kind === 'sandbox'
            ? value === 'danger-full-access'
              ? 'broad'
              : null
            : kind === 'network' || kind === 'autoAccept'
              ? value === 'true'
                ? 'broad'
                : null
              : null;
  push(c, c.permissions, { kind, value: cut(maskLine(value)), note, flags, source: { ...src, line: lineOf(t, JSON.stringify(value)) } });
}

type ClaudeSettings = {
  enabledPlugins: Obj;
  enableAllProjectMcpServers: boolean | null;
  enabledMcpjson: string[];
  disabledMcpjson: string[];
  disableAllHooks: boolean;
};

const HELPERS = ['apiKeyHelper', 'awsCredentialExport', 'awsAuthRefresh', 'otelHeadersHelper'];

async function claudeSettings(c: Collector, path: string, scope: ConfigScope, out: ClaudeSettings): Promise<void> {
  const r = await openConfig(c, 'claude', path, scope, 'json');
  if (!r || !isObj(r.value)) {
    if (r) c.files[c.files.length - 1] = { ...c.files[c.files.length - 1], state: 'unreadable', reason: 'format' };
    return;
  }
  const s = r.value;
  const src = { agent: 'claude' as const, file: path, scope };
  r.t.cursor = 0;
  if (isObj(s.hooks)) lineOf(r.t, keyNeedle('hooks'));
  hookRows(c, s.hooks, src, r.t);
  r.t.cursor = 0;
  if (isObj(s.statusLine) && typeof s.statusLine.command === 'string') {
    push(c, c.run, commandRow('statusLine', 'statusLine', s.statusLine.command, [], { ...src, line: lineOf(r.t, keyNeedle('statusLine')) }));
  }
  for (const k of HELPERS) {
    r.t.cursor = 0;
    if (typeof s[k] === 'string') push(c, c.run, commandRow('helper', k, s[k] as string, [], { ...src, line: lineOf(r.t, keyNeedle(k)) }));
  }
  r.t.cursor = 0;
  if (isObj(s.permissions)) {
    lineOf(r.t, keyNeedle('permissions'));
    for (const v of strings(s.permissions.allow)) permRow(c, 'allow', v, src, r.t);
    if (typeof s.permissions.defaultMode === 'string') permRow(c, 'defaultMode', s.permissions.defaultMode, src, r.t);
    for (const v of strings(s.permissions.additionalDirectories)) permRow(c, 'directory', v, src, r.t);
  }
  if (s.disableAllHooks === true) {
    out.disableAllHooks = true;
    push(c, c.permissions, { kind: 'disableAllHooks', value: 'true', note: null, flags: [], source: { ...src, line: lineOf(r.t, keyNeedle('disableAllHooks')) } });
  }
  if (isObj(s.enabledPlugins)) Object.assign(out.enabledPlugins, s.enabledPlugins);
  if (typeof s.enableAllProjectMcpServers === 'boolean') out.enableAllProjectMcpServers = s.enableAllProjectMcpServers;
  out.enabledMcpjson.push(...strings(s.enabledMcpjsonServers));
  out.disabledMcpjson.push(...strings(s.disabledMcpjsonServers));
}

/** `.md` files under a folder (commands may sit in subfolders, which name a namespace), at most MAX_COMPONENT_FILES. */
async function mdFiles(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 3 || out.length >= MAX_COMPONENT_FILES) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_COMPONENT_FILES) break;
    const full = join(dir, e.name);
    if (e.isDirectory()) await mdFiles(full, depth + 1, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

/** Agents and commands of one folder: their names, pre-approved tools and the skill text rules on them. */
async function componentRows(c: Collector, kind: 'agent' | 'command', dir: string, src: Omit<Source, 'line' | 'file'>, within?: string): Promise<void> {
  for (const file of await mdFiles(dir)) {
    if (within) {
      const real = await realpath(file).catch(() => null);
      if (!real || !(real === within || real.startsWith(within + sep))) continue;
    }
    let raw: string;
    try {
      const st = await stat(file);
      if (st.size > MAX_FILE_BYTES) continue;
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(dir, file).replace(/\.md$/i, '');
    const meta = extractSkillMeta(raw, basename(rel));
    const name = kind === 'command' ? rel.split(/[\\/]/).join(':') : meta.name;
    const flags = skillRiskFlags({ files: [], allowedTools: meta.allowedTools, body: meta.body, hasHooks: meta.hasHooks, raw });
    push(c, c.components, { kind, name, path: file, allowedTools: meta.allowedTools, flags, source: { ...src, file, line: null } });
  }
}

/** The map of servers in an `.mcp.json`-like file: under `mcpServers`, or the file itself. */
const serversIn = (v: unknown): unknown => (isObj(v) && isObj(v.mcpServers) ? v.mcpServers : v);

/** A path a plugin names, if it stays inside the plugin's folder (where it really is: links are followed). */
async function inside(root: string, realRoot: string, p: string): Promise<string | null> {
  const full = resolve(root, p.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/, ''));
  const real = await realpath(full).catch(() => null);
  return real && (real === realRoot || real.startsWith(realRoot + sep)) ? full : null;
}

/** What an enabled plugin runs and brings: hooks, MCP and LSP servers, monitors, commands and agents. */
async function pluginRows(c: Collector, id: string, installPath: string): Promise<void> {
  const root = resolve(installPath);
  const realRoot = await realpath(root).catch(() => null);
  const src = { agent: 'claude' as const, scope: 'plugin' as const, plugin: id };
  if (!realRoot) {
    c.files.push({ agent: 'claude', path: root, scope: 'plugin', plugin: id, state: 'missing' });
    return;
  }
  const manifestPath = join(root, '.claude-plugin', 'plugin.json');
  const manifest = await openConfig(c, 'claude', manifestPath, 'plugin', 'json', id);
  const m = manifest && isObj(manifest.value) ? manifest.value : null;
  if (!manifest && c.files[c.files.length - 1]?.state === 'missing') c.files.pop(); // no plugin.json is normal
  type Part = 'hooks' | 'mcp' | 'lsp' | 'monitors';
  const handle = (part: Part, value: unknown, file: string, t: Text | null) => {
    const s = { ...src, file };
    if (part === 'hooks') hookRows(c, isObj(value) && isObj(value.hooks) ? value.hooks : value, s, t);
    else if (part === 'mcp') serverRows(c, serversIn(value), s, t);
    else if (part === 'lsp') serverRows(c, isObj(value) && isObj(value.lspServers) ? value.lspServers : value, s, t, 'lsp');
    else for (const line of runConfigCommands(value)) push(c, c.run, commandRow('monitor', 'monitor', line, [], { ...s, line: lineOf(t, line.split(' ')[0]) }));
  };
  const fromFile = async (part: Part, rel: string) => {
    const full = await inside(root, realRoot, rel);
    if (!full) return;
    const r = await openConfig(c, 'claude', full, 'plugin', 'json', id);
    if (r) handle(part, r.value, full, r.t);
    else if (c.files[c.files.length - 1]?.state === 'missing') c.files.pop(); // the default files are optional
  };
  // a manifest field is inline config, or a path (or paths) to it inside the plugin
  const fromField = async (part: Part, field: unknown) => {
    if (field == null) return;
    if (typeof field === 'string') await fromFile(part, field);
    else if (Array.isArray(field) && field.every((f) => typeof f === 'string')) for (const f of field) await fromFile(part, f);
    else if (manifest) {
      manifest.t.cursor = 0;
      handle(part, field, manifestPath, manifest.t);
    }
  };
  await fromFile('hooks', 'hooks/hooks.json');
  await fromField('hooks', m?.hooks);
  await fromFile('mcp', '.mcp.json');
  await fromField('mcp', m?.mcpServers);
  await fromFile('lsp', '.lsp.json');
  await fromField('lsp', m?.lspServers);
  await fromFile('monitors', 'monitors/monitors.json');
  await fromField('monitors', m?.monitors ?? (isObj(m?.experimental) ? m.experimental.monitors : undefined));
  for (const [kind, field, def] of [
    ['command', m?.commands, 'commands'],
    ['agent', m?.agents, 'agents'],
  ] as const) {
    const dirs = [def, ...(typeof field === 'string' ? [field] : strings(field))];
    for (const d of new Set(dirs)) {
      const full = await inside(root, realRoot, d);
      if (full) await componentRows(c, kind, full, src, realRoot);
    }
  }
}

/** installed_plugins.json: where each plugin install is, by id; only those that apply here (user, or this folder). */
async function installedPlugins(c: Collector): Promise<Array<{ id: string; scope: string; installPath: string | null }>> {
  const path = join(c.home, '.claude', 'plugins', 'installed_plugins.json');
  const r = await openConfig(c, 'claude', path, 'user', 'json');
  if (!r) return [];
  const plugins = isObj(r.value) && isObj(r.value.plugins) ? r.value.plugins : {};
  const out: Array<{ id: string; scope: string; installPath: string | null }> = [];
  for (const [id, installs] of Object.entries(plugins)) {
    for (const i of Array.isArray(installs) ? installs : []) {
      if (!isObj(i)) continue;
      const scope = typeof i.scope === 'string' ? i.scope : 'user';
      const own = typeof i.projectPath === 'string' ? i.projectPath : null;
      if (scope !== 'user' && (!c.projectPath || !own || pathKey(own) !== pathKey(c.projectPath))) continue;
      out.push({ id, scope, installPath: typeof i.installPath === 'string' ? i.installPath : null });
    }
  }
  return out;
}

export type ReadOptions = { home: string; projectPath: string | null };

/**
 * The Claude Code plugins that apply here and whether each is on, from installed_plugins.json and the settings'
 * enabledPlugins (user, then project, then local: the last one that names it wins). No process is started.
 */
export async function listClaudePlugins({ home, projectPath }: ReadOptions): Promise<PluginState[]> {
  const c: Collector = { home, projectPath, files: [], run: [], permissions: [], components: [], truncated: false };
  const settings: ClaudeSettings = { enabledPlugins: {}, enableAllProjectMcpServers: null, enabledMcpjson: [], disabledMcpjson: [], disableAllHooks: false };
  await claudeSettings(c, join(home, '.claude', 'settings.json'), 'user', settings);
  if (projectPath) {
    await claudeSettings(c, join(projectPath, '.claude', 'settings.json'), 'project', settings);
    await claudeSettings(c, join(projectPath, '.claude', 'settings.local.json'), 'local', settings);
  }
  return (await installedPlugins(c)).map((p) => ({ ...p, enabled: settings.enabledPlugins[p.id] === true }));
}

export async function readAgentConfig({ home, projectPath }: ReadOptions): Promise<AgentConfig> {
  const c: Collector = { home, projectPath, files: [], run: [], permissions: [], components: [], truncated: false };
  const p = projectPath;

  // --- Claude Code ---
  const settings: ClaudeSettings = { enabledPlugins: {}, enableAllProjectMcpServers: null, enabledMcpjson: [], disabledMcpjson: [], disableAllHooks: false };
  await claudeSettings(c, join(home, '.claude', 'settings.json'), 'user', settings);
  if (p) {
    await claudeSettings(c, join(p, '.claude', 'settings.json'), 'project', settings);
    await claudeSettings(c, join(p, '.claude', 'settings.local.json'), 'local', settings);
  }
  const claudeJsonPath = join(home, '.claude.json');
  const cj = await openConfig(c, 'claude', claudeJsonPath, 'user', 'json');
  let projectEntry: Obj | null = null;
  if (cj && isObj(cj.value)) {
    const v = cj.value;
    if (isObj(v.mcpServers)) {
      lineOf(cj.t, keyNeedle('mcpServers'));
      serverRows(c, v.mcpServers, { agent: 'claude', file: claudeJsonPath, scope: 'user' }, cj.t);
    }
    if (p && isObj(v.projects)) {
      const key = Object.keys(v.projects).find((k) => pathKey(k) === pathKey(p));
      if (key && isObj(v.projects[key])) {
        projectEntry = v.projects[key] as Obj;
        cj.t.cursor = 0;
        lineOf(cj.t, keyNeedle('projects'));
        lineOf(cj.t, keyNeedle(key));
        const src = { agent: 'claude' as const, file: claudeJsonPath, scope: 'local' as const };
        serverRows(c, projectEntry.mcpServers, src, cj.t);
        for (const tool of strings(projectEntry.allowedTools)) permRow(c, 'allow', tool, src, cj.t);
        settings.enabledMcpjson.push(...strings(projectEntry.enabledMcpjsonServers));
        settings.disabledMcpjson.push(...strings(projectEntry.disabledMcpjsonServers));
        if (typeof projectEntry.enableAllProjectMcpServers === 'boolean' && settings.enableAllProjectMcpServers == null) settings.enableAllProjectMcpServers = projectEntry.enableAllProjectMcpServers;
      }
    }
  }
  if (p) {
    const mcpPath = join(p, '.mcp.json');
    const r = await openConfig(c, 'claude', mcpPath, 'project', 'json');
    if (r) {
      // a project's servers run only once approved: in the settings' lists, or all of them
      const state = (name: string): RunRow['state'] =>
        settings.disabledMcpjson.includes(name) ? 'off' : settings.enabledMcpjson.includes(name) || settings.enableAllProjectMcpServers === true ? 'on' : 'ask';
      serverRows(c, serversIn(r.value), { agent: 'claude', file: mcpPath, scope: 'project' }, r.t, 'mcp', undefined, state);
    }
  }
  await componentRows(c, 'agent', join(home, '.claude', 'agents'), { agent: 'claude', scope: 'user' });
  await componentRows(c, 'command', join(home, '.claude', 'commands'), { agent: 'claude', scope: 'user' });
  if (p) {
    await componentRows(c, 'agent', join(p, '.claude', 'agents'), { agent: 'claude', scope: 'project' });
    await componentRows(c, 'command', join(p, '.claude', 'commands'), { agent: 'claude', scope: 'project' });
  }
  const plugins: PluginState[] = [];
  for (const pl of await installedPlugins(c)) {
    const enabled = settings.enabledPlugins[pl.id] === true;
    plugins.push({ id: pl.id, scope: pl.scope, enabled, installPath: pl.installPath });
    if (enabled && pl.installPath && !plugins.slice(0, -1).some((x) => x.installPath === pl.installPath && x.enabled)) await pluginRows(c, pl.id, pl.installPath);
  }
  if (settings.disableAllHooks) for (const row of c.run) if (row.source.agent === 'claude' && row.kind === 'hook') row.state = 'off';

  // --- Codex ---
  const codexPath = join(home, '.codex', 'config.toml');
  const codex = await openConfig(c, 'codex', codexPath, 'user', 'toml');
  if (codex && isObj(codex.value)) {
    const v = codex.value;
    const src = { agent: 'codex' as const, file: codexPath, scope: 'user' as const };
    serverRows(c, v.mcp_servers, src, codex.t, 'mcp', (name) => codex.tableLines?.get(`mcp_servers.${name}`) ?? null);
    const line = (k: string) => {
      // [ \t]*, not \s*: \s takes line breaks too, and rescanning a run of blank lines from every line is quadratic
      const m = codex.t.text.match(new RegExp(`^[ \\t]*${k}[ \\t]*=`, 'm'));
      return m?.index != null ? codex.t.lineAt(m.index + m[0].indexOf(k)) : null;
    };
    if (typeof v.approval_policy === 'string') push(c, c.permissions, { kind: 'approval', value: v.approval_policy, note: v.approval_policy === 'never' ? 'broad' : null, flags: [], source: { ...src, line: line('approval_policy') } });
    if (typeof v.sandbox_mode === 'string') push(c, c.permissions, { kind: 'sandbox', value: v.sandbox_mode, note: v.sandbox_mode === 'danger-full-access' ? 'broad' : null, flags: [], source: { ...src, line: line('sandbox_mode') } });
    if (isObj(v.sandbox_workspace_write) && v.sandbox_workspace_write.network_access === true) {
      push(c, c.permissions, { kind: 'network', value: 'true', note: 'broad', flags: [], source: { ...src, line: codex.tableLines?.get('sandbox_workspace_write') ?? null } });
    }
    if (p && isObj(v.projects)) {
      for (const [k, proj] of Object.entries(v.projects)) {
        if (pathKey(k) !== pathKey(p) || !isObj(proj) || typeof proj.trust_level !== 'string') continue;
        push(c, c.permissions, { kind: 'trust', value: proj.trust_level, note: proj.trust_level === 'trusted' ? 'broad' : null, flags: [], source: { ...src, line: codex.tableLines?.get(`projects.${k}`) ?? null } });
      }
    }
  }
  const codexHooks = join(home, '.codex', 'hooks.json');
  const ch = await openConfig(c, 'codex', codexHooks, 'user', 'json');
  if (ch) hookRows(c, isObj(ch.value) && isObj(ch.value.hooks) ? ch.value.hooks : ch.value, { agent: 'codex', file: codexHooks, scope: 'user' }, ch.t);

  // --- Cursor ---
  for (const [file, scope] of [[join(home, '.cursor', 'mcp.json'), 'user'], ...(p ? [[join(p, '.cursor', 'mcp.json'), 'project']] : [])] as Array<[string, ConfigScope]>) {
    const r = await openConfig(c, 'cursor', file, scope, 'json');
    if (r) serverRows(c, serversIn(r.value), { agent: 'cursor', file, scope }, r.t);
  }

  // --- Gemini CLI ---
  for (const [file, scope] of [[join(home, '.gemini', 'settings.json'), 'user'], ...(p ? [[join(p, '.gemini', 'settings.json'), 'project']] : [])] as Array<[string, ConfigScope]>) {
    const r = await openConfig(c, 'gemini', file, scope, 'json');
    if (!r || !isObj(r.value)) continue;
    const v = r.value;
    const src = { agent: 'gemini' as const, file, scope };
    if (isObj(v.mcpServers)) {
      lineOf(r.t, keyNeedle('mcpServers'));
      serverRows(c, v.mcpServers, src, r.t);
    }
    r.t.cursor = 0;
    if (isObj(v.hooks)) lineOf(r.t, keyNeedle('hooks'));
    hookRows(c, v.hooks, src, r.t);
    r.t.cursor = 0;
    const tools = isObj(v.tools) ? v.tools : {};
    for (const tool of [...strings(tools.allowed), ...strings(v.allowedTools)]) permRow(c, 'allow', tool, src, r.t);
    const auto = tools.autoAccept ?? v.autoAccept;
    if (typeof auto === 'boolean') push(c, c.permissions, { kind: 'autoAccept', value: String(auto), note: auto ? 'broad' : null, flags: [], source: { ...src, line: lineOf(r.t, keyNeedle('autoAccept')) } });
  }

  return { projectPath: p, files: c.files, run: c.run, permissions: c.permissions, components: c.components, plugins, truncated: c.truncated };
}

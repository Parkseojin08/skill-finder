// A plugin's run configuration as a person reads it (feature review F3 full): its hooks as {event, matcher, command,
// timeout}, its MCP servers as {name, transport, command or URL host, env and header key names}, its LSP servers.
// Values of env and headers never leave the server (only their key names), and commands are masked like the log.
// Everything is walked iteratively and capped, so a crafted config costs time in proportion to its size.
import { maskSecrets } from '../util/log.ts';
import { sanitizeLine } from '../util/sanitize.ts';

/** Runs every session start / every prompt (`everyTime`), or steps into tool approval (`approval`). */
export type HookNote = 'everyTime' | 'approval' | null;
export type HookRow = { event: string; matcher: string | null; command: string; timeout: number | null; note: HookNote; source: string };
/** Why an MCP server's code can change under the same config: a package run without a version, or `:latest`. */
export type Unpinned = 'npx' | 'uvx' | 'pipx' | 'docker' | null;
export type McpRow = {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string | null;
  args: string[];
  /** http/sse: the server's host (the URL's path and query are not shown). */
  host: string | null;
  /** http/sse to a host other than this PC: what Claude sends the tool goes there. */
  external: boolean;
  envKeys: string[];
  headerKeys: string[];
  unpinned: Unpinned;
  source: string;
};
export type LspRow = { name: string; command: string | null; args: string[]; extensions: string[]; source: string };

/** Rows kept per config. */
const ROWS_MAX = 200;
const TEXT_MAX = 500;
const EVERY_TIME = new Set(['SessionStart', 'UserPromptSubmit']);
const APPROVAL = new Set(['PreToolUse', 'PermissionRequest']);

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const text = (v: string) => {
  const t = maskSecrets(sanitizeLine(v));
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
};
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50).map(text) : []);
const keys = (v: unknown): string[] => Object.keys(asObject(v) ?? {}).slice(0, 50).map((k) => sanitizeLine(k).slice(0, 100));

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** `{hooks: {Event: […]}}` (hooks.json, plugin.json) or `{Event: […]}` directly. */
export function hookRows(value: unknown, source: string): HookRow[] {
  const root = asObject(parse(value));
  if (!root) return [];
  const events = asObject(root.hooks) ?? root;
  const rows: HookRow[] = [];
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const group = asObject(g);
      if (!group) continue;
      const matcher = str(group.matcher);
      const hooks = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const h of hooks) {
        const hook = asObject(h);
        const command = hook && (str(hook.command) ?? (hook.type === 'prompt' ? str(hook.prompt) : null));
        if (!hook || command == null) continue;
        if (rows.length >= ROWS_MAX) return rows;
        const event_ = sanitizeLine(event).slice(0, 100);
        rows.push({
          event: event_,
          matcher: matcher != null ? text(matcher) : null,
          command: text(command),
          timeout: typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) ? hook.timeout : null,
          note: EVERY_TIME.has(event) ? 'everyTime' : APPROVAL.has(event) ? 'approval' : null,
          source,
        });
      }
    }
  }
  return rows;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

function urlHost(url: string): { host: string | null; external: boolean } {
  try {
    const u = new URL(url);
    return { host: u.host, external: !LOCAL_HOSTS.has(u.hostname.toLowerCase()) };
  } catch {
    return { host: null, external: true };
  }
}

/** The command's own name: `C:\…\npx.cmd` → `npx`. */
const toolName = (command: string) =>
  (command.split(/[\\/]/).pop() ?? command)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1)$/, '');

/** The first argument that is not an option, from `from`; options in `withValue` take the next argument. */
function positional(args: string[], from: number, withValue: ReadonlySet<string> = new Set()): string | null {
  for (let i = from; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return args[i + 1] ?? null;
    if (a.startsWith('-')) {
      if (withValue.has(a)) i++;
      continue;
    }
    return a;
  }
  return null;
}

/** `pkg@1.2.3`, `@scope/pkg@1`: a version other than a moving tag. */
const npmVersioned = (spec: string) => {
  const at = spec.replace(/^@[^/]+\//, '').indexOf('@');
  if (at < 0) return false;
  const v = spec.replace(/^@[^/]+\//, '').slice(at + 1);
  return v !== '' && v !== 'latest' && v !== 'next';
};

const NPX_VALUE = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache']);
const DOCKER_VALUE = new Set(['-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '--network', '-w', '--workdir', '--env-file', '--mount', '-u', '--user', '--entrypoint', '-l', '--label', '--platform', '--pull']);

/**
 * Whether a stdio server's command runs whatever version is newest when it starts: `npx` (or bunx, pnpm/yarn dlx)
 * of a package without a version, `uvx` / `uv tool run` / `pipx run` without one, or a docker image tagged
 * `:latest` or not tagged at all.
 */
export function unpinnedReason(command: string | null, args: string[]): Unpinned {
  if (!command) return null;
  // a command written as one string ("npx -y pkg") is split as a shell would, roughly
  const parts = args.length ? [command, ...args] : command.trim().split(/\s+/);
  const tool = toolName(parts[0] ?? '');
  const rest = parts.slice(1);
  if (tool === 'npx' || tool === 'bunx' || ((tool === 'pnpm' || tool === 'yarn') && rest[0] === 'dlx')) {
    const start = tool === 'pnpm' || tool === 'yarn' ? 1 : 0;
    const pkgOpt = rest.findIndex((a) => a === '-p' || a === '--package');
    const spec = pkgOpt >= 0 ? rest[pkgOpt + 1] : (rest.find((a) => a.startsWith('--package='))?.slice(10) ?? positional(rest, start, NPX_VALUE));
    return spec && !npmVersioned(spec) && !/^[./\\]/.test(spec) ? 'npx' : null;
  }
  if (tool === 'uvx' || (tool === 'uv' && rest[0] === 'tool' && rest[1] === 'run')) {
    const from = rest.findIndex((a) => a === '--from');
    const spec = from >= 0 ? rest[from + 1] : positional(rest, tool === 'uv' ? 2 : 0, new Set(['--with', '--python', '-p']));
    return spec && !/==|@/.test(spec) ? 'uvx' : null;
  }
  if (tool === 'pipx' && rest[0] === 'run') {
    const specOpt = rest.findIndex((a) => a === '--spec');
    const spec = specOpt >= 0 ? rest[specOpt + 1] : positional(rest, 1);
    return spec && !/==|@/.test(spec) ? 'pipx' : null;
  }
  if ((tool === 'docker' || tool === 'podman') && rest.includes('run')) {
    const image = positional(rest, rest.indexOf('run') + 1, DOCKER_VALUE);
    if (!image || image.includes('@sha256:')) return null;
    const name = image.split('/').pop() ?? image;
    return !name.includes(':') || name.endsWith(':latest') ? 'docker' : null;
  }
  return null;
}

/** `{mcpServers: {name: …}}` (.mcp.json, plugin.json) or `{name: …}` directly. */
export function mcpRows(value: unknown, source: string): McpRow[] {
  const root = asObject(parse(value));
  if (!root) return [];
  const servers = asObject(root.mcpServers) ?? root;
  const rows: McpRow[] = [];
  for (const [name, v] of Object.entries(servers)) {
    const s = asObject(v);
    if (!s) continue;
    if (rows.length >= ROWS_MAX) break;
    const url = str(s.url);
    const type = str(s.type);
    const transport: McpRow['transport'] = type === 'sse' ? 'sse' : type === 'http' || type === 'streamable-http' || (url && !s.command) ? 'http' : 'stdio';
    const command = str(s.command);
    const args = stringList(s.args);
    const where = url ? urlHost(url) : { host: null, external: false };
    rows.push({
      name: sanitizeLine(name).slice(0, 100),
      transport,
      command: command != null ? text(command) : null,
      args,
      host: where.host,
      external: transport !== 'stdio' && where.external,
      envKeys: keys(s.env),
      headerKeys: keys(s.headers),
      unpinned: transport === 'stdio' ? unpinnedReason(command, Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : []) : null,
      source,
    });
  }
  return rows;
}

/** `.lsp.json` / `lspServers`: `{name: {command, args, extensionToLanguage}}`, or under an `lspServers` key. */
export function lspRows(value: unknown, source: string): LspRow[] {
  const root = asObject(parse(value));
  if (!root) return [];
  const servers = asObject(root.lspServers) ?? root;
  const rows: LspRow[] = [];
  for (const [name, v] of Object.entries(servers)) {
    const s = asObject(v);
    if (!s) continue;
    if (rows.length >= ROWS_MAX) break;
    const command = str(s.command);
    rows.push({
      name: sanitizeLine(name).slice(0, 100),
      command: command != null ? text(command) : null,
      args: stringList(s.args),
      extensions: keys(s.extensionToLanguage),
      source,
    });
  }
  return rows;
}

/**
 * The plugin files a command line runs through `${CLAUDE_PLUGIN_ROOT}/…` (or `$CLAUDE_PLUGIN_ROOT/…`), as paths
 * relative to the plugin root. One linear regex; `..` is resolved by the caller against the plugin tree.
 */
export function pluginRootPaths(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(/\$\{?CLAUDE_PLUGIN_ROOT\}?[\\/]([^\s"'`;|&<>()]+)/g)) out.add(m[1]);
  return [...out];
}

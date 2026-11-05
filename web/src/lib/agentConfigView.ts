// The 설치됨 screen's "자동 실행·권한" tab (feature review F10): the answer of GET /api/agent-config, which MCP
// servers one agent has and another lacks, and a server written in another agent's format to copy. Pure, so the web
// tests run it; nothing here changes a file (copying only).

export type AgentKey = 'claude' | 'codex' | 'cursor' | 'gemini';
export const AGENT_KEYS: AgentKey[] = ['claude', 'codex', 'cursor', 'gemini'];
export const AGENT_NAME: Record<AgentKey, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI' };

export type ConfigScope = 'user' | 'project' | 'local' | 'plugin';
export type Source = { agent: AgentKey; file: string; line: number | null; scope: ConfigScope; plugin?: string };
export type FileState = { agent: AgentKey; path: string; scope: ConfigScope; plugin?: string; state: 'read' | 'missing' | 'unreadable'; reason?: 'tooLarge' | 'tooManyLines' | 'format' | 'io'; detail?: string };
export type RunKind = 'hook' | 'mcp' | 'monitor' | 'lsp' | 'statusLine' | 'helper';
export type RunRow = {
  kind: RunKind;
  name: string;
  matcher: string | null;
  hookType: string | null;
  transport: 'stdio' | 'http' | 'sse' | null;
  program: string | null;
  args: string[];
  command: string | null;
  host: string | null;
  envKeys: string[];
  headerKeys: string[];
  flags: string[];
  unpinned: string | null;
  state: 'on' | 'off' | 'ask';
  source: Source;
};
export type PermKind = 'allow' | 'defaultMode' | 'directory' | 'approval' | 'sandbox' | 'network' | 'trust' | 'autoAccept' | 'disableAllHooks';
export type PermRow = { kind: PermKind; value: string; note: 'broad' | 'sensitive' | null; flags: string[]; source: Source };
export type ComponentRow = { kind: 'agent' | 'command'; name: string; path: string; allowedTools: string[]; flags: string[]; source: Source };
/** GET /api/agent-config (server/src/agentConfig/read.ts). */
export type AgentConfigResponse = {
  projectPath: string | null;
  files: FileState[];
  run: RunRow[];
  permissions: PermRow[];
  components: ComponentRow[];
  plugins: Array<{ id: string; scope: string; enabled: boolean; installPath: string | null }>;
  truncated: boolean;
};

/** Agents with a config file read here: the comparison's columns (Claude Code always). */
export function presentAgents(cfg: AgentConfigResponse): AgentKey[] {
  const read = new Set(cfg.files.filter((f) => f.state === 'read').map((f) => f.agent));
  return AGENT_KEYS.filter((a) => a === 'claude' || read.has(a));
}

export type McpCompareRow = { name: string; servers: Partial<Record<AgentKey, RunRow>>; missing: AgentKey[] };

/**
 * MCP servers by name across the agents ("Claude엔 있고 Codex엔 없음"): each server once per agent (the first
 * found), with the agents among `agents` that lack it. Names compare without case.
 */
export function compareMcp(cfg: AgentConfigResponse, agents: readonly AgentKey[] = presentAgents(cfg)): McpCompareRow[] {
  const byName = new Map<string, McpCompareRow>();
  for (const r of cfg.run) {
    if (r.kind !== 'mcp') continue;
    const key = r.name.toLowerCase();
    const row = byName.get(key) ?? { name: r.name, servers: {}, missing: [] };
    row.servers[r.source.agent] ??= r;
    byName.set(key, row);
  }
  const rows = [...byName.values()];
  for (const row of rows) row.missing = agents.filter((a) => !row.servers[a]);
  return rows.sort((a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name));
}

/** Placeholder for a value the app never reads (env and header values). */
export const VALUE_PLACEHOLDER = '<값>';

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const placeholders = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, VALUE_PLACEHOLDER]));
/** The app keeps a remote server's host only (a path or query can hold a key). */
const remoteUrl = (host: string) => `https://${host}/…`;

/**
 * One MCP server written for another agent's config: Claude Code's `.mcp.json` / `~/.claude.json`, Codex's
 * `config.toml`, Cursor's `mcp.json`, Gemini CLI's `settings.json`. Values the app does not keep (env and header
 * values, a remote server's path) are placeholders to fill in.
 */
export function mcpSnippet(server: RunRow, to: AgentKey): string {
  const remote = server.transport === 'http' || server.transport === 'sse' ? (server.host ? remoteUrl(server.host) : 'https://…') : null;
  if (to === 'codex') {
    const lines = [`[mcp_servers.${tomlKey(server.name)}]`];
    if (remote) lines.push(`url = ${JSON.stringify(remote)}`);
    else {
      lines.push(`command = ${JSON.stringify(server.program ?? '')}`);
      if (server.args.length) lines.push(`args = [${server.args.map((a) => JSON.stringify(a)).join(', ')}]`);
    }
    if (server.envKeys.length) {
      lines.push('', `[mcp_servers.${tomlKey(server.name)}.env]`);
      for (const k of server.envKeys) lines.push(`${tomlKey(k)} = ${JSON.stringify(VALUE_PLACEHOLDER)}`);
    }
    if (remote && server.headerKeys.length) {
      lines.push('', `[mcp_servers.${tomlKey(server.name)}.http_headers]`);
      for (const k of server.headerKeys) lines.push(`${tomlKey(k)} = ${JSON.stringify(VALUE_PLACEHOLDER)}`);
    }
    return lines.join('\n');
  }
  const body: Record<string, unknown> = {};
  if (remote) {
    if (to === 'claude') body.type = server.transport;
    body[to === 'gemini' && server.transport === 'http' ? 'httpUrl' : 'url'] = remote;
    if (server.headerKeys.length) body.headers = placeholders(server.headerKeys);
  } else {
    if (to === 'claude') body.type = 'stdio';
    body.command = server.program ?? '';
    if (server.args.length) body.args = server.args;
  }
  if (server.envKeys.length) body.env = placeholders(server.envKeys);
  return JSON.stringify({ mcpServers: { [server.name]: body } }, null, 2);
}

/** Where each agent keeps MCP servers, for the copy button's hint. */
export const MCP_FILE: Record<AgentKey, string> = {
  claude: '.mcp.json · ~/.claude.json',
  codex: '~/.codex/config.toml',
  cursor: '~/.cursor/mcp.json · .cursor/mcp.json',
  gemini: '~/.gemini/settings.json',
};

/** A row's source as one copyable line: the file, and its line when known. */
export const sourceText = (s: Source) => (s.line ? `${s.file}:${s.line}` : s.file);

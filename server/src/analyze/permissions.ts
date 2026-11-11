// What a skill may do, by kind (feature review F1): shell, file read, file write, network, MCP and what runs on its
// own, each as "pre-approved" (allowed-tools grants it, or it runs without asking), "asks" (the skill's text or files
// show it is used, and Claude Code asks first) or "none" (no sign of it), with where that was seen. Every tool of
// allowed-tools is read (WebFetch, Write, Read(~/.ssh/**), mcp__*), not only Bash. A plugin's table adds its other
// skills and its own parts (hooks, MCP servers, monitors, LSP servers), since installing one installs them all.
// Only text is read; the checks are linear in its length (D#4de9).
import { parseAllowedTools } from './frontmatter.ts';
import { frontmatterLines, LineIndex, toolKinds, type FlagEvidence, type PermissionKind, type RiskFlag, type SkillRiskInput } from './risk.ts';

// toolKinds lives in risk.ts since B5's preapprovedNetwork / preapprovedWrite rules read it too.
export { toolKinds, type PermissionKind };
export type PermissionState = 'preapproved' | 'ask' | 'none';
export type PermissionEvidence = { source: string; line: number | null; excerpt: string };
export type PermissionCell = { state: PermissionState; evidence: PermissionEvidence[] };
export type PermissionTable = Record<PermissionKind, PermissionCell> & {
  /** Pre-approved tools the table does not sort into a kind (Task, TodoWrite, …). */
  otherTools: string[];
};

/** One other skill of the same plugin, from its stored frontmatter and flags. */
export type SiblingSkill = { name: string; frontmatter: Record<string, unknown>; flags: string[] };
export type PluginParts = { hooks: boolean; mcp: boolean; monitors: boolean; bin: boolean; lsp: boolean };

const EVIDENCE_MAX = 8;
const KINDS: PermissionKind[] = ['shell', 'read', 'write', 'network', 'mcp', 'autorun'];
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|ps1|psm1|bat|cmd)$/i;
const SHELL_FENCE = /^[ \t]{0,3}(?:```|~~~)[ \t]*(?:bash|sh|shell|zsh|console|terminal|powershell|pwsh|ps1|cmd|bat)\b/gim;
const NET_WORDS = /\b(?:curl|wget|WebFetch|WebSearch|Invoke-WebRequest|Invoke-RestMethod)\b/g;
const WRITE_WORDS = /\b(?:Write|Edit|MultiEdit)[ \t]+tool\b/gi;
const MCP_WORDS = /\bmcp__[A-Za-z0-9_-]+/g;

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);

function emptyTable(): PermissionTable {
  const t = { otherTools: [] as string[] } as PermissionTable;
  for (const k of KINDS) t[k] = { state: 'none', evidence: [] };
  return t;
}

/** Raises a cell to `state` (pre-approved beats asks beats none) and adds a place, at most EVIDENCE_MAX. */
function mark(t: PermissionTable, kind: PermissionKind, state: Exclude<PermissionState, 'none'>, ev: PermissionEvidence) {
  const cell = t[kind];
  if (state === 'preapproved' && cell.state !== 'preapproved') {
    cell.state = 'preapproved';
    cell.evidence = []; // what asks is beside the point once it does not need to
  } else if (state === 'ask' && cell.state === 'none') cell.state = 'ask';
  if (cell.state === state && cell.evidence.length < EVIDENCE_MAX && !cell.evidence.some((e) => e.source === ev.source && e.line === ev.line && e.excerpt === ev.excerpt)) cell.evidence.push(ev);
}

/** Up to `limit` matches of a `g` regex, as offsets. */
function offsets(re: RegExp, text: string, limit: number): number[] {
  const out: number[] = [];
  re.lastIndex = 0;
  for (let m: RegExpExecArray | null; out.length < limit && (m = re.exec(text)); ) {
    out.push(m.index);
    if (m[0].length === 0) re.lastIndex++;
  }
  re.lastIndex = 0;
  return out;
}

/**
 * The table for one skill: its SKILL.md (as SkillRiskInput, so lines are found as the risk rules find them) and the
 * evidence those rules gave (shell injection and hooks run on their own); for a plugin, its other skills and parts.
 */
export function permissionTable(opts: {
  skill: SkillRiskInput;
  evidence: Partial<Record<RiskFlag, FlagEvidence>>;
  path?: string;
  siblings?: SiblingSkill[];
  plugin?: PluginParts | null;
}): PermissionTable {
  const t = emptyTable();
  const path = opts.path ?? 'SKILL.md';
  const { skill } = opts;
  const lines = new LineIndex(skill.raw);
  const at = (offset: number): PermissionEvidence => {
    const e = lines.evidence(path, offset);
    return { source: path, line: e.line, excerpt: e.excerpt };
  };
  // allowed-tools, each entry by its kind, at its line when it can be found
  const other = new Set<string>();
  for (const tool of skill.allowedTools) {
    const kinds = toolKinds(tool);
    if (!kinds.length) {
      if (tool.trim()) other.add(clip(tool.trim()));
      continue;
    }
    const name = tool.trim().match(/^[A-Za-z_][\w-]*/)?.[0] ?? tool;
    const found = frontmatterLines(skill.raw, 'allowed-tools', (l) => l.includes(name), 1);
    const ev = found.length ? { ...at(found[0]), excerpt: clip(tool.trim()) } : { source: path, line: null, excerpt: clip(tool.trim()) };
    for (const k of kinds) mark(t, k, 'preapproved', ev);
  }
  // what the text shows it uses
  for (const f of skill.files.filter((f) => SCRIPT_EXT.test(f)).slice(0, EVIDENCE_MAX)) mark(t, 'shell', 'ask', { source: f, line: null, excerpt: f });
  const bodyStart = skill.raw.endsWith(skill.body) ? skill.raw.length - skill.body.length : -1;
  if (bodyStart >= 0) {
    for (const o of offsets(SHELL_FENCE, skill.body, EVIDENCE_MAX)) mark(t, 'shell', 'ask', at(bodyStart + o));
    for (const o of offsets(NET_WORDS, skill.body, EVIDENCE_MAX)) mark(t, 'network', 'ask', at(bodyStart + o));
    for (const o of offsets(WRITE_WORDS, skill.body, EVIDENCE_MAX)) mark(t, 'write', 'ask', at(bodyStart + o));
    for (const o of offsets(MCP_WORDS, skill.body, EVIDENCE_MAX)) mark(t, 'mcp', 'ask', at(bodyStart + o));
  }
  // what runs without asking: `!`cmd`` before Claude reads the skill, hooks the skill registers
  for (const flag of ['shellInjection', 'skillHooks'] as const) {
    for (const e of opts.evidence[flag]?.items ?? []) mark(t, 'autorun', 'preapproved', { source: e.path, line: e.line, excerpt: e.excerpt || flag });
  }
  if (opts.evidence.shellInjection) for (const e of opts.evidence.shellInjection.items) mark(t, 'shell', 'preapproved', { source: e.path, line: e.line, excerpt: e.excerpt });

  // the plugin's other skills: their allowed-tools and what runs on its own (stored, so without lines)
  for (const s of opts.siblings ?? []) {
    const source = `${s.name}/SKILL.md`;
    for (const tool of parseAllowedTools(s.frontmatter['allowed-tools'])) {
      const kinds = toolKinds(tool);
      if (!kinds.length) {
        if (tool.trim()) other.add(clip(tool.trim()));
        continue;
      }
      for (const k of kinds) mark(t, k, 'preapproved', { source, line: null, excerpt: clip(tool.trim()) });
    }
    if (s.flags.includes('shellInjection')) {
      mark(t, 'autorun', 'preapproved', { source, line: null, excerpt: '!`…`' });
      mark(t, 'shell', 'preapproved', { source, line: null, excerpt: '!`…`' });
    }
    if (s.flags.includes('skillHooks') || (s.frontmatter.hooks != null && s.frontmatter.hooks !== false)) mark(t, 'autorun', 'preapproved', { source, line: null, excerpt: 'hooks' });
    if (s.flags.includes('scripts')) mark(t, 'shell', 'ask', { source, line: null, excerpt: 'scripts' });
  }
  // the plugin's own parts
  const p = opts.plugin;
  if (p?.hooks) mark(t, 'autorun', 'preapproved', { source: 'hooks', line: null, excerpt: 'hooks' });
  if (p?.monitors) mark(t, 'autorun', 'preapproved', { source: 'monitors', line: null, excerpt: 'monitors' });
  if (p?.lsp) mark(t, 'autorun', 'preapproved', { source: 'lspServers', line: null, excerpt: 'lspServers' });
  if (p?.mcp) {
    // a stdio server starts with the session; its tools ask unless allowed
    mark(t, 'autorun', 'preapproved', { source: 'mcpServers', line: null, excerpt: 'mcpServers' });
    mark(t, 'mcp', 'ask', { source: 'mcpServers', line: null, excerpt: 'mcpServers' });
  }
  if (p?.bin) mark(t, 'shell', 'ask', { source: 'bin/', line: null, excerpt: 'bin/' });
  t.otherTools = [...other].slice(0, 30);
  return t;
}

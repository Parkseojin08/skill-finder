// The shapes the stage 2 security and install bundle adds to the server's answers (feature review F1, F3, B6, F9).
// web/src/types.ts is left as it is: every field here is optional there, as an older server does not send it.
import { ApiError } from '../api.ts';
import { serverText, t } from '../i18n.ts';
import type { ExistingSkill, InstallPreview } from '../types.ts';

/** One place a risk flag was found (server analyze/risk.ts Evidence). `line` null: no one line (a file, a cut). */
export type Evidence = { path: string; line: number | null; excerpt: string; before: string | null; after: string | null };
export type FlagEvidence = { items: Evidence[]; more: boolean };
export type RiskEvidenceMap = Partial<Record<string, FlagEvidence>>;

export type PermissionKind = 'shell' | 'read' | 'write' | 'network' | 'mcp' | 'autorun';
export type PermissionCell = { state: 'preapproved' | 'ask' | 'none'; evidence: Array<{ source: string; line: number | null; excerpt: string }> };
export type PermissionTableData = Record<PermissionKind, PermissionCell> & { otherTools: string[] };

/** The detail with the F1 fields. */
export type DetailSecurity = { riskEvidence?: RiskEvidenceMap; permissions?: PermissionTableData };

export type HookRow = { event: string; matcher: string | null; command: string; timeout: number | null; note: 'everyTime' | 'approval' | null; source: string };
export type McpRow = {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string | null;
  args: string[];
  host: string | null;
  external: boolean;
  envKeys: string[];
  headerKeys: string[];
  unpinned: 'npx' | 'uvx' | 'pipx' | 'docker' | null;
  source: string;
};
export type LspRow = { name: string; command: string | null; args: string[]; extensions: string[]; source: string };
export type RunConfigTable = { hooks: HookRow[]; mcp: McpRow[]; lsp: LspRow[]; docs: { commands: number; agents: number; scripts: number } };

export type AgentId = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'github-copilot' | 'opencode';
export type AgentTarget = { id: AgentId; name: string; detected: boolean; dir: string; sharedWith: AgentId[] };

/** The preview with the server's high-risk judgement (P7) and the agents' folders (F9 stage 2). */
export type InstallPreviewMore = InstallPreview & { highRisk?: boolean; existingAll?: ExistingSkill[]; agents?: AgentId[]; targets?: AgentTarget[] };

/** A skill as the recheck saw it (server install/recheck.ts). */
export type SkillRisk = { id: string; name: string; riskLevel: string; riskFlags: string[] };
/** The install refused because the repo moved after the check (B6, decision 11), with what changed. */
export type ChangedSinceScan = {
  code: 'changedSinceScan';
  error: string;
  changes: Array<{ what: 'marketplace' | 'plugin' | 'skill'; repo: string; checked: string | null; now: string }>;
  before: SkillRisk[];
  after: SkillRisk[];
  newFlags: string[];
  raised: string[];
  added: string[];
  removed: string[];
  gone?: boolean;
};

/** An install refused with its whole answer kept (the 409 of B6 carries what changed). */
export class InstallRefused extends ApiError {
  readonly body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message, status);
    this.body = body;
  }
  get changed(): ChangedSinceScan | null {
    return this.body.code === 'changedSinceScan' ? (this.body as unknown as ChangedSinceScan) : null;
  }
}

const HEADERS = { 'X-Skill-Finder': '1', 'Content-Type': 'application/json' };

/**
 * POST /api/install and read its NDJSON answer, as api.ts streamNdjson does, but a refusal keeps its body (api.ts is
 * not this bundle's to change).
 */
export async function streamInstall<E>(body: unknown, onEvent: (e: E) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/install', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  } catch (err) {
    if (err instanceof TypeError) throw new ApiError(t('Skill Finder 서버에 연결하지 못했습니다. 검은 실행 창이 켜져 있는지 확인하세요. ({0})', err.message), 0);
    throw err;
  }
  if (!res.ok || !res.body) {
    const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const error = typeof answer.error === 'string' ? serverText(answer.error) : t('요청 실패 ({0})', res.status);
    throw new InstallRefused(error, res.status, answer);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line) as E);
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as E);
}

const AGENTS_KEY = 'sf.installAgents';

/** The agents ticked last time (F9 stage 2: the default lives in this browser); Claude Code alone at first. */
export function savedAgents(): AgentId[] {
  try {
    const v = JSON.parse(localStorage.getItem(AGENTS_KEY) ?? 'null') as unknown;
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v as AgentId[];
  } catch {
    // no storage, or not ours
  }
  return ['claude-code'];
}

export function saveAgents(agents: AgentId[]): void {
  try {
    localStorage.setItem(AGENTS_KEY, JSON.stringify(agents));
  } catch {
    // only this visit
  }
}

/** Flags whose meaning is Claude Code's own (allowed-tools, hooks, `!`cmd``): other agents may ignore them (a guess). */
export const CLAUDE_ONLY_FLAGS = new Set(['preapprovedBash', 'unscopedBash', 'shellInjection', 'skillHooks', 'pluginRootDependency']);

// The shapes the stage 2 security and install bundle adds to the server's answers (feature review F1, F3, B6, F9).
// web/src/types.ts is left as it is: every field here is optional there, as an older server does not send it.
import { ApiError, apiSend } from '../api.ts';
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

/**
 * Flags whose meaning is Claude Code's own (allowed-tools, hooks, `!`cmd``): other agents may ignore them (a guess).
 * Server lint/lint.ts CLAUDE_ONLY_FLAGS is the same list (web/test/stage3Security.test.ts compares them).
 */
export const CLAUDE_ONLY_FLAGS = new Set(['preapprovedBash', 'unscopedBash', 'shellInjection', 'skillHooks', 'pluginRootDependency', 'preapprovedNetwork', 'preapprovedWrite']);

/**
 * The malicious-pattern signals of stage 3 (feature review B5, decision 9), worded as labels.ts RISK_FLAGS words the
 * others; `info`: shown, not raising the level. labels.ts spreads this table into RISK_FLAGS.
 */
export const B5_RISK_FLAGS: Record<string, { label: string; meaning: string; info?: boolean }> = {
  obfuscatedExec: {
    label: t('숨긴 명령 실행'),
    meaning: t('인코딩한 내용(base64 등)을 풀어 셸이나 인터프리터로 바로 실행합니다. 무엇이 실행되는지 글로는 보이지 않습니다.'),
  },
  claudeConfigTamper: {
    label: t('Claude 설정 변경'),
    meaning: t('Claude Code 설정 파일(settings.json)을 쓰거나, 권한 확인을 끄는 옵션(--dangerously-skip-permissions, bypassPermissions)을 씁니다.'),
  },
  credentialAccess: {
    label: t('자격 증명 접근'),
    meaning: t('SSH 키, 클라우드·API 토큰, .env, 브라우저에 저장된 비밀번호, 키체인 같은 비밀을 읽거나 다른 곳으로 보냅니다.'),
  },
  exfilEndpoint: {
    label: t('외부 수집 주소'),
    meaning: t('요청 수집 사이트(webhook.site 등), 터널(ngrok), 붙여넣기 사이트, 디스코드 웹훅, IP 주소로 된 서버로 보내는 주소가 있습니다.'),
  },
  persistence: {
    label: t('자동 재실행 등록'),
    meaning: t('cron, 셸 시작 파일(.bashrc 등), 예약 작업, 시작 프로그램(Run 키), launchd에 등록해 나중에 다시 실행되게 합니다.'),
  },
  promptInjectionPhrase: {
    label: t('지시 무시 문구'),
    meaning: t('"이전 지시를 무시하라", "사용자에게 알리지 말라" 같은 문구가 있습니다(정보). 이런 문구를 막는 법을 설명하는 스킬에도 나옵니다.'),
    info: true,
  },
  preapprovedNetwork: { label: t('네트워크 사전 승인'), meaning: t('이 스킬이 쓰이는 동안 웹 요청(WebFetch, curl 등)이 승인 없이 실행될 수 있습니다.') },
  preapprovedWrite: { label: t('파일 쓰기 사전 승인'), meaning: t('이 스킬이 쓰이는 동안 파일 쓰기·수정(Write, Edit)이 승인 없이 실행될 수 있습니다.') },
  sensitiveReadNetwork: {
    label: t('민감 경로 + 네트워크'),
    meaning: t('민감한 파일(SSH 키, 자격 증명, .env 등)을 읽으면서 네트워크도 미리 허락해, 읽은 내용이 묻지 않고 나갈 수 있습니다.'),
  },
};

/**
 * Text signals as serious as download-and-run (server analyze/risk.ts TICK_FLAGS): a file or command of an install
 * with one needs the confirm tick. InstallScan.tsx scanIsHigh reads this set.
 */
export const TICK_FLAGS = new Set(['curlPipeShell', 'obfuscatedExec', 'claudeConfigTamper']);

// ── F15 내 스킬 검사 (server routes/lint.ts) ─────────────────────────────────────────────────────────────────────

export type LintSeverity = 'error' | 'warning' | 'info';
export type LintProblem = { severity: LintSeverity; code: string; message: string; file?: string; line?: number | null };
export type LintSimilar = { id: string; name: string; description: string | null; riskLevel: 'low' | 'medium' | 'high'; installs: number | null; stars: number | null; matchedTerms: string[] };
export type LintResult = {
  ok: boolean;
  problems: LintProblem[];
  path: string;
  folder: string;
  name: string;
  description: string;
  quality: string[];
  risk: { level: 'low' | 'medium' | 'high'; flags: string[]; evidence: RiskEvidenceMap };
  files: { checked: number; skipped: number; listed: number; findings: Array<{ path: string; flags: string[]; evidence: Array<Evidence & { flag: string }> }> };
  tokens: { perTurn: number; onUse: number | null };
  listing: { text: string; chars: number; limit: number; truncated: boolean; cut: number };
  skillsCli: { found: boolean; reason: 'nameOrDescription' | 'internal' | null; folder: string };
  agents: { claudeOnlyFlags: string[]; claudeKeys: string[] };
  similar: LintSimilar[] | null;
  scope?: 'user' | 'project';
  projectPath?: string | null;
  agentsReading?: Array<{ id: string; name: string }>;
};

/** POST /api/lint-skill: an installed skill folder the index does not know (the 설치됨 row's path). */
export function lintSkill(path: string, projectPath?: string | null): Promise<LintResult> {
  return apiSend<LintResult>('POST', '/lint-skill', { path, ...(projectPath ? { projectPath } : {}) });
}

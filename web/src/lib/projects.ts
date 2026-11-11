// The 설치됨 screen's project views (feature review F12 프로젝트 표준, F13 모든 프로젝트): the server's answers
// (server/src/projects/*) and what the panels compute from them. Kept here so web/src/types.ts stays as it is.
import { t } from '../i18n.ts';

export type StandardStatus = 'ok' | 'missing' | 'differs' | 'extra' | 'disabled' | 'unregistered';
export type HashNote = 'noLockHash' | 'tooLarge' | 'outside' | 'unreadable';
export type PresetItem = { id?: string; plugin?: string; name: string };
export type AgentRef = { id: string; name: string };

export type StandardItem = {
  kind: 'skill' | 'plugin' | 'marketplace';
  name: string;
  status: StandardStatus;
  source: string | null;
  ref: string | null;
  skillPath: string | null;
  skillId: string | null;
  paths: string[];
  agents: AgentRef[];
  notForClaude: boolean;
  lockHash: string | null;
  localHash: string | null;
  hashNote: HashNote | null;
  marketplace: string | null;
  preset: PresetItem | null;
};

export type FileRead = 'read' | 'missing' | 'unreadable';

export type ProjectStandardResponse = {
  projectPath: string;
  files: { lock: FileRead; settings: FileRead };
  hasStandard: boolean;
  ok: boolean;
  counts: Record<StandardStatus, number>;
  items: StandardItem[];
  missingPreset: PresetItem[];
  refNote: boolean;
};

export type ProjectSummary = {
  path: string;
  name: string;
  from: Array<'install' | 'claude'>;
  skills: { project: number; loaded: number };
  plugins: { project: number; enabled: number };
  mcp: { project: number; total: number };
  perTurnTokens: number;
  standard: { hasStandard: boolean; ok: boolean; counts: Record<StandardStatus, number> } | null;
  changed: number;
  usage: { unused30d: number; lastUsed: string | null } | null;
  errors: string[];
};

export type ProjectsResponse = { projects: ProjectSummary[]; usageOn: boolean; truncated: boolean; at: string };

export type StandardSnippet = { lock: string; settings: string; skills: number; plugins: number; skippedSkills: number; localMarkets: string[] };

/** The states `skill-finder check` fails on; "not in the standard" is only reported. */
export const FAILING: readonly StandardStatus[] = ['missing', 'differs', 'disabled', 'unregistered'];

export const STATUS_LABEL: Record<StandardStatus, string> = {
  ok: t('맞음'),
  missing: t('설치 안 됨'),
  differs: t('내용 다름'),
  extra: t('표준에 없음'),
  disabled: t('플러그인 꺼짐'),
  unregistered: t('마켓 미등록'),
};

export const STATUS_HELP: Record<StandardStatus, string> = {
  ok: t('표준 파일대로 설치돼 있습니다.'),
  missing: t('표준 파일에 있는데 이 프로젝트에 설치돼 있지 않습니다.'),
  differs: t('설치된 폴더의 내용 해시가 skills-lock.json의 computedHash와 다릅니다. 원본이 바뀌었거나 여기서 고쳤을 수 있습니다.'),
  extra: t('이 프로젝트에 설치돼 있지만 skills-lock.json에 없습니다. 직접 만들어 git에 둔 스킬이면 그대로 두어도 됩니다.'),
  disabled: t('.claude/settings.json은 켜라고 하는데 settings.local.json 등에서 꺼져 있습니다.'),
  unregistered: t('이 PC의 Claude Code에 그 마켓플레이스가 추가돼 있지 않습니다.'),
};

export const KIND_LABEL: Record<StandardItem['kind'], string> = { skill: t('스킬'), plugin: t('플러그인'), marketplace: t('마켓') };

export const HASH_NOTE: Record<HashNote, string> = {
  noLockHash: t('lock에 computedHash가 없어 내용은 비교하지 않았습니다.'),
  tooLarge: t('폴더가 너무 커서 내용은 비교하지 않았습니다.'),
  outside: t('폴더가 프로젝트 밖을 가리켜 내용은 비교하지 않았습니다.'),
  unreadable: t('폴더를 읽지 못해 내용은 비교하지 않았습니다.'),
};

/** Problems first (in FAILING order), then "not in the standard", then the matching ones; by kind and name within. */
const ORDER: StandardStatus[] = ['missing', 'unregistered', 'differs', 'disabled', 'extra', 'ok'];
const KIND_ORDER: StandardItem['kind'][] = ['skill', 'plugin', 'marketplace'];
export function sortStandardItems(items: StandardItem[]): StandardItem[] {
  return [...items].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
}

/** How many items fail the check. */
export const failingCount = (counts: Record<StandardStatus, number>) => FAILING.reduce((n, s) => n + (counts[s] ?? 0), 0);

/** One cell of the all-projects table for a project's standard. */
export function standardSummary(s: ProjectSummary['standard']): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!s) return { text: '-', tone: 'muted' };
  if (!s.hasStandard) return { text: t('표준 없음'), tone: 'muted' };
  const bad = failingCount(s.counts);
  if (s.ok && !bad) return { text: s.counts.extra ? t('맞음 · 표준에 없음 {0}', s.counts.extra) : t('맞음'), tone: 'ok' };
  if (!bad) return { text: t('표준 파일을 읽지 못함'), tone: 'warn' };
  return { text: t('어긋남 {0}', bad), tone: 'warn' };
}

export type ProjectSort = 'name' | 'tokens' | 'standard' | 'changed' | 'unused' | 'lastUsed';

export function sortProjects(list: ProjectSummary[], by: ProjectSort): ProjectSummary[] {
  const bad = (p: ProjectSummary) => (p.standard?.hasStandard ? failingCount(p.standard.counts) + (p.standard.ok ? 0 : 0.5) : -1);
  const key: Record<ProjectSort, (a: ProjectSummary, b: ProjectSummary) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    tokens: (a, b) => b.perTurnTokens - a.perTurnTokens,
    standard: (a, b) => bad(b) - bad(a),
    changed: (a, b) => b.changed - a.changed,
    unused: (a, b) => (b.usage?.unused30d ?? -1) - (a.usage?.unused30d ?? -1),
    lastUsed: (a, b) => (b.usage?.lastUsed ?? '').localeCompare(a.usage?.lastUsed ?? ''),
  };
  return [...list].sort((a, b) => key[by](a, b) || a.name.localeCompare(b.name));
}

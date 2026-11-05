// The status view's data (GET /api/status, server/src/routes/status.ts) and the names the screen gives tasks.
import { serverText, t } from './i18n.ts';
import type { RunningTask, TaskRun, NetworkState } from './activity.ts';

export type AgeBuckets = { total: number; never: number; day: number; week: number; month: number; older: number };
export type FreshnessReason =
  | { code: 'marketNeverSynced' | 'marketStale'; name: string }
  | { code: 'starsStale'; percent: number }
  | { code: 'taskFailing'; kind: string; label: string; failCount: number }
  | { code: 'offline' };
export type Limit = { resource: string; remaining: number | null; limit: number | null; reset: number | null };
export type TaskView = {
  kind: string;
  label: string;
  everyMs: number;
  network: boolean;
  idle: boolean;
  manualOnly: boolean;
  manual: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  failCount: number;
};
export type Status = {
  now: string;
  freshness: { level: 'good' | 'stale'; reasons: FreshnessReason[] };
  network: NetworkState;
  sources: {
    marketplaces: Array<{ name: string; repo: string; enabled: boolean; syncedAt: string | null; commit: string | null; pluginCount: number | null; error: string | null }>;
    pluginIndex: AgeBuckets;
    stars: AgeBuckets;
    oldRiskRules: number;
    riskRulesVersion: number;
    seedCreatedAt: string | null;
    popular: { lastRunAt: string | null; repos: number; withSkills: number; skills: number };
    translate: Array<{ lang: string; state: 'absent' | 'downloading' | 'ready' | 'error'; error: string | null }>;
  };
  github: { hasToken: boolean; limits: Limit[]; checkedAt: string | null };
  tasks: TaskView[];
  nextDue: { kind: string; label: string; at: string | null } | null;
  running: RunningTask[];
  runs: TaskRun[];
};

const TASK_LABELS: Record<string, string> = {
  sync: t('마켓플레이스 동기화'),
  'repo-meta': t('별 정보 갱신'),
  'risk-recheck': t('위험 규칙 재검사'),
  prune: t('기록 정리'),
  'update-check': t('새 버전 확인'),
  'db-maintenance': t('DB 점검'),
  popular: t('인기 저장소 수집'),
};

/** A task's or job run's name on screen; tasks added later bring their own (Korean) label from the server. */
export function taskLabel(kind: string, serverLabel?: string): string {
  if (TASK_LABELS[kind]) return TASK_LABELS[kind];
  const m = /^(sync|collect):(.{1,200})$/.exec(kind);
  if (m) return m[1] === 'sync' ? t('{0} 동기화', m[2]) : t('{0} 스킬 수집', m[2]);
  return serverLabel && serverLabel !== kind ? serverText(serverLabel) : kind;
}

export const TRIGGER_LABEL: Record<string, string> = { startup: t('시작 시'), schedule: t('예약'), manual: t('직접') };
export const RUN_STATUS_LABEL: Record<string, string> = { running: t('진행 중'), ok: t('완료'), failed: t('실패'), skipped: t('건너뜀') };

/** "3분 뒤", "2시간 전": a time near now, either side. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–';
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return '–';
  const abs = Math.abs(ms);
  const [n, unit] =
    abs < 60_000 ? [0, ''] : abs < 3_600_000 ? [Math.round(abs / 60_000), 'm'] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'h'] : [Math.round(abs / 86_400_000), 'd'];
  if (!unit) return ms >= 0 ? t('곧') : t('방금');
  const amount = unit === 'm' ? t('{0}분', n) : unit === 'h' ? t('{0}시간', n) : t('{0}일', n);
  return ms >= 0 ? t('{0} 뒤', amount) : t('{0} 전', amount);
}

export function formatEvery(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 24 * 7 && h % (24 * 7) === 0) return t('{0}주마다', h / (24 * 7));
  if (h >= 24 && h % 24 === 0) return t('{0}일마다', h / 24);
  if (h >= 1) return t('{0}시간마다', Math.round(h));
  return t('{0}분마다', Math.round(ms / 60_000));
}

export function reasonText(r: FreshnessReason): string {
  switch (r.code) {
    case 'marketNeverSynced':
      return t('{0}: 아직 동기화하지 않음', r.name);
    case 'marketStale':
      return t('{0}: 이틀 넘게 동기화하지 못함', r.name);
    case 'starsStale':
      return t('별 정보 {0}%가 일주일보다 오래됨', r.percent);
    case 'taskFailing':
      return t('{0}: {1}번 잇달아 실패', taskLabel(r.kind, r.label), r.failCount);
    case 'offline':
      return t('인터넷에 연결되지 않음');
  }
}

export const LIMIT_LABEL: Record<string, string> = { core: 'API', search: t('저장소 검색'), code_search: t('코드 검색'), graphql: 'GraphQL' };

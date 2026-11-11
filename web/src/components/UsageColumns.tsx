// The 설치됨 table's use columns (feature review F11, decision 14): last day used and uses in the last 30 days, read
// from Claude Code's transcripts on this PC when the setting is on (server: /api/usage). Nothing shows while it is off.
import { apiGet } from '../api.ts';
import { t } from '../i18n.ts';
import './usage.css';

export type UsageEntry = {
  skill: string;
  plugin: string;
  lastUsed: string;
  count30: number;
  lastUsedHere: string | null;
  count30Here: number | null;
  onlyProject: string | null;
};
export type UsageResponse = { enabled: boolean; scannedAt: string | null; files: number; skills: UsageEntry[] };

/** The table's row as far as uses are concerned. */
export type UsageRow = { name: string; folder?: string; scope: string; plugin?: { id: string } | null };
export type RowUsage = { lastUsed: string | null; count30: number; onlyProject: string | null };

export function fetchUsage(projectPath: string): Promise<UsageResponse | null> {
  return apiGet<UsageResponse>('/usage', { projectPath: projectPath || undefined }).catch(() => null);
}

/**
 * A row's uses: by name (and folder) for a skill of its own, by plugin name and skill name for a plugin's. A project
 * skill counts uses in the folder listed (and folders inside it), a personal one everywhere. Null while reading is off
 * or before the transcripts were first read (no zeros that mean "not read yet").
 */
export function usageOf(r: UsageRow, usage: UsageResponse | null): RowUsage | null {
  if (!usage?.enabled || !usage.scannedAt) return null;
  const plugin = r.plugin ? r.plugin.id.replace(/@.*$/, '').toLowerCase() : '';
  const names = new Set([r.name.toLowerCase(), ...(r.folder && !r.plugin ? [r.folder.toLowerCase()] : [])]);
  const here = r.scope === 'project';
  let lastUsed: string | null = null;
  let count30 = 0;
  let onlyProject: string | null = null;
  for (const e of usage.skills) {
    if (e.plugin !== plugin || !names.has(e.skill)) continue;
    const last = here ? e.lastUsedHere : e.lastUsed;
    if (last && (!lastUsed || last > lastUsed)) lastUsed = last;
    count30 += (here ? e.count30Here : e.count30) ?? 0;
    if (!here && e.onlyProject) onlyProject = e.onlyProject;
  }
  return { lastUsed, count30, onlyProject };
}

/** Days since a YYYY-MM-DD (local), for "오늘" / "N일 전". */
function daysAgo(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const then = new Date(y, m - 1, d).getTime();
  const now = new Date();
  return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - then) / 86_400_000);
}

export function LastUsedCell({ use }: { use: RowUsage }) {
  if (!use.lastUsed) return <span className="muted small">{t('기록 없음')}</span>;
  const n = daysAgo(use.lastUsed);
  return (
    <span className="small" title={use.lastUsed}>
      {n <= 0 ? t('오늘') : t('{0}일 전', n)}
    </span>
  );
}

/** Uses in 30 days; a skill that costs tokens every turn but was not used gets a chip saying so. */
export function Count30Cell({ use, perTurn, loaded }: { use: RowUsage; perTurn: number; loaded: boolean }) {
  return (
    <>
      <span className="small">{use.count30.toLocaleString()}</span>
      {use.count30 === 0 && loaded && perTurn > 0 && <div className="usage-idle-chip">{t('매 턴 {0}토큰인데 30일 0회', perTurn.toLocaleString())}</div>}
    </>
  );
}

/** "only used in one project": said only, the move is the user's (install there, then remove the personal one). */
export function OnlyProjectHint({ use }: { use: RowUsage }) {
  if (!use.onlyProject) return null;
  const name = use.onlyProject.split(/[\\/]/).filter(Boolean).pop() ?? use.onlyProject;
  return (
    <div className="muted small" title={use.onlyProject}>
      {t('최근 30일 동안 {0} 프로젝트에서만 썼습니다. 그 프로젝트 범위로 옮기면(그 프로젝트에 설치한 뒤 개인 범위에서 삭제) 다른 프로젝트의 매 턴 토큰이 줄어듭니다.', name)}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../api.ts';
import { formatAgo, RISK_FLAGS, RISK_LEVEL } from '../labels.ts';
import { saveFile } from '../lib/exportList.ts';
import { t } from '../i18n.ts';
import { useNotices, type Notice } from '../notices.ts';
import type { RiskLevel } from '../types.ts';
import { NoticeChip } from './NoticeChip.tsx';

/** One entry of `/history/installs`: a notice, or an install or removal the app ran with what was seen then. */
type InstallEvent = {
  type: 'install';
  at: string;
  id: number;
  method: string;
  scope: string;
  projectPath: string | null;
  skillId: string | null;
  pluginId: string | null;
  ok: boolean;
  ref: string | null;
  riskLevel: string | null;
  flags: unknown;
  scanSummary: unknown;
  acks: unknown;
  pinned: boolean | null;
};
type HistoryEvent = ({ type: 'notice'; at: string } & Notice) | InstallEvent;

const WHAT: Record<string, string> = {
  plugin: t('설치 · 플러그인'),
  'skills-cli': t('설치 · skills CLI'),
  'uninstall-plugin': t('삭제 · 플러그인'),
  'uninstall-skill': t('삭제 · 스킬'),
};
const SCOPE: Record<string, string> = { user: t('개인'), project: t('프로젝트'), local: t('로컬') };

const flagNames = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** What the install saw (filled since stage 2): the risk signals, the file check's findings, the ticks. */
function SeenAtInstall({ e }: { e: InstallEvent }) {
  const flags = flagNames(e.flags);
  const acks = e.acks && typeof e.acks === 'object' ? (e.acks as Record<string, unknown>) : null;
  const scan = e.scanSummary && typeof e.scanSummary === 'object' ? (e.scanSummary as Record<string, unknown>) : null;
  const parts: string[] = [];
  if (e.riskLevel && e.riskLevel in RISK_LEVEL) parts.push(RISK_LEVEL[e.riskLevel as RiskLevel]);
  if (flags.length) parts.push(t('신호: {0}', flags.map((f) => RISK_FLAGS[f]?.label ?? f).join(', ')));
  if (scan && typeof scan.checked === 'number') parts.push(t('파일 검사 {0}개', scan.checked));
  if (acks?.high === true) parts.push(t('위험 높음 확인함'));
  if (e.pinned === true) parts.push(t('검사한 커밋으로 고정'));
  if (e.pinned === false) parts.push(t('고정 안 됨'));
  return parts.length ? <div className="muted small">{parts.join(' · ')}</div> : null;
}

/**
 * The 설치됨 screen's 변경·기록 tab (feature review F7): the notices about installed and favorite skills and the
 * app's installs and removals as one timeline, newest first, with a JSON export. `onOpenSkill` opens a skill's page.
 */
export function ChangesTab({ onOpenSkill }: { onOpenSkill?: (id: string) => void }) {
  const { counts, markSeen, refresh } = useNotices();
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyNotices, setOnlyNotices] = useState(false);

  const load = useCallback(() => {
    setError(null);
    apiGet<{ events: HistoryEvent[] }>('/history/installs')
      .then((r) => setEvents(r.events))
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, []);
  useEffect(() => {
    load();
    void refresh();
  }, [load, refresh]);

  const exportJson = async () => {
    try {
      const all = await apiGet<{ exportedAt: string; events: HistoryEvent[] }>('/history/installs', { all: '1' });
      saveFile(`skill-finder-history-${all.exportedAt.slice(0, 10)}.json`, JSON.stringify(all, null, 2), 'application/json');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const seeAll = async () => {
    try {
      await markSeen();
      load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const shown = (events ?? []).filter((e) => !onlyNotices || e.type === 'notice');
  const openable = (id: string | null) => (id && id.startsWith('gh:') && onOpenSkill ? id : null);

  return (
    <section className="changes-tab" aria-label={t('변경·기록')}>
      <div className="results-toolbar">
        <span className="muted small">{counts.unseen ? t('새 알림 {0}개', counts.unseen) : t('새 알림 없음')}</span>
        <span className="inline-flex flex-wrap items-center gap-2">
          <label className="small">
            <input type="checkbox" checked={onlyNotices} onChange={(e) => setOnlyNotices(e.target.checked)} /> {t('알림만')}
          </label>
          <button type="button" className="ghost" disabled={!counts.unseen} onClick={() => void seeAll()}>
            {t('모두 읽음으로')}
          </button>
          <button type="button" className="ghost" onClick={() => void exportJson()}>
            {t('JSON 내보내기')}
          </button>
        </span>
      </div>
      {error && <p className="warn-box">{error}</p>}
      {!events && !error && <p className="muted small">{t('불러오는 중…')}</p>}
      {events && shown.length === 0 && <p className="empty">{t('아직 기록이 없습니다. 설치·삭제하거나, 설치·즐겨찾기한 스킬의 원본이 바뀌면 여기에 쌓입니다.')}</p>}
      {shown.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('언제')}</th>
              <th>{t('대상')}</th>
              <th>{t('무엇')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              if (e.type === 'notice') {
                const id = openable(e.skillIds[0] ?? null);
                const name = e.detail.name ?? e.skillId.replace(/^(repo|plugin):/, '');
                return (
                  <tr key={`n${e.id}`}>
                    <td className="small" title={e.at}>
                      {formatAgo(e.at)}
                    </td>
                    <td className="mono small">
                      {id ? (
                        <button type="button" className="linkish mono" onClick={() => onOpenSkill!(id)}>
                          {name}
                        </button>
                      ) : (
                        name
                      )}
                    </td>
                    <td className="small">
                      <NoticeChip notice={e} />
                    </td>
                  </tr>
                );
              }
              const target = e.pluginId ?? e.skillId;
              const id = e.method === 'skills-cli' || e.method === 'plugin' ? openable(e.skillId) : null;
              return (
                <tr key={`i${e.id}`}>
                  <td className="small" title={e.at}>
                    {formatAgo(e.at)}
                  </td>
                  <td className="mono small">
                    {id ? (
                      <button type="button" className="linkish mono" onClick={() => onOpenSkill!(id)}>
                        {target}
                      </button>
                    ) : (
                      (target ?? '–')
                    )}
                  </td>
                  <td className="small">
                    {WHAT[e.method] ?? e.method} · {SCOPE[e.scope] ?? e.scope} · <span className={e.ok ? 'state-on' : 'warn-text'}>{e.ok ? t('성공') : t('실패')}</span>
                    {e.projectPath && <div className="muted small">{e.projectPath}</div>}
                    <SeenAtInstall e={e} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

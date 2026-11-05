import { CircleNotchIcon, WifiSlashIcon } from '@phosphor-icons/react';
import { useActivity } from '../activity.ts';
import { t } from '../i18n.ts';
import { taskLabel } from '../status.ts';
import '../status.css';

/**
 * The menu bar's task indicator (feature review F22): a turning icon and how many tasks run, or "오프라인"; a click
 * opens the status at the top of the marketplace screen. Hidden when nothing runs and the network is there.
 */
export function ActivityIndicator({ onOpen }: { onOpen: () => void }) {
  const a = useActivity();
  if (!a) return null;
  const running = a.running;
  const offline = a.network.offline;
  if (running.length === 0 && !offline) return null;
  const lines = [
    ...running.map((r) => (r.job ? `${taskLabel(r.kind, r.label)} ${r.job.done}/${r.job.total || '?'}` : taskLabel(r.kind, r.label))),
    ...(offline ? [t('오프라인 · 로컬 색인만')] : []),
    ...a.failures.map((f) => t('실패: {0}', taskLabel(f.kind))),
  ];
  const label = running.length > 0 ? t('작업 {0}개 진행 중', running.length) : t('오프라인');
  return (
    <button type="button" className={`activity-indicator${offline ? ' offline' : ''}`} title={lines.join('\n')} aria-label={`${label}. ${lines.join(', ')}`} onClick={onOpen}>
      {running.length > 0 ? <CircleNotchIcon size={14} weight="bold" className="spin" aria-hidden /> : <WifiSlashIcon size={14} aria-hidden />}
      <span>{running.length > 0 ? running.length : t('오프라인')}</span>
      {running.length > 0 && offline && <WifiSlashIcon size={14} aria-hidden />}
    </button>
  );
}

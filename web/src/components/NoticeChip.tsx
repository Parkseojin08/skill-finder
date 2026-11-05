import { formatAgo, RISK_LEVEL, RISK_RANK } from '../labels.ts';
import { t } from '../i18n.ts';
import type { Notice } from '../notices.ts';
import type { RiskLevel } from '../types.ts';

const level = (v: unknown) => (typeof v === 'string' && v in RISK_LEVEL ? RISK_LEVEL[v as RiskLevel] : null);
/** "위험 낮음→주의" when the level moved, else null. */
export function riskMove(from: unknown, to: unknown): string | null {
  const a = level(from);
  const b = level(to);
  return a && b && a !== b ? `${a}→${b}` : null;
}

/** One line for a notice (feature review F7), as the favorite cards, the 변경·기록 tab and the badge's title say it. */
export function noticeText(n: Notice): string {
  const d = n.detail;
  switch (n.kind) {
    case 'new_commit': {
      if (n.skillId.startsWith('plugin:')) return t('마켓이 핀을 옮김 · 다음 업데이트의 위험 높음 스킬 {0}개', d.highRisk ?? 0);
      const move = riskMove(d.riskFrom, d.riskTo);
      return move ? t('원본에 새 버전 ({0}, {1})', formatAgo(d.commitAt ?? n.createdAt), move) : t('원본에 새 버전 ({0})', formatAgo(d.commitAt ?? n.createdAt));
    }
    case 'risk_up':
      return t('위험 오름: {0}', riskMove(d.riskFrom, d.riskTo) ?? level(d.riskTo) ?? '?');
    case 'archived':
      return t('저장소 보관됨 (더 고쳐지지 않음)');
    case 'gone':
      return n.skillId.startsWith('repo:') ? t('저장소가 삭제됐거나 비공개') : t('원본 저장소에서 사라짐');
    case 'moved':
      return t('저장소 옮겨짐 → {0}', n.to ?? '?');
    default:
      return n.kind;
  }
}

const WARN = new Set(['risk_up', 'gone', 'archived']);

/** A notice as a small chip; unseen ones are marked. */
export function NoticeChip({ notice }: { notice: Notice }) {
  const d = notice.detail;
  const rose = (RISK_RANK[d.riskTo as RiskLevel] ?? 0) > (RISK_RANK[d.riskFrom as RiskLevel] ?? 0);
  const warn = WARN.has(notice.kind) || (notice.kind === 'new_commit' && (rose || (d.highRisk ?? 0) > 0));
  return (
    <span className={`status-chip${warn ? ' warn' : ''}`} title={notice.createdAt}>
      {!notice.seenAt && <span aria-label={t('새 알림')}>●</span>}
      {noticeText(notice)}
    </span>
  );
}

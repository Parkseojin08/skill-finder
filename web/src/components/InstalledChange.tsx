import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiGet } from '../api.ts';
import { formatAgo, RISK_FLAGS, RISK_LEVEL, RISK_RANK } from '../labels.ts';
import { t } from '../i18n.ts';
import type { RiskLevel } from '../types.ts';
import { CopyButton } from './CopyButton.tsx';
import { riskMove } from './NoticeChip.tsx';

/**
 * Which side of an installed skill changed (feature review F6), as `/installed` sends it in each skill row's `drift`
 * (server/src/install/installed.ts Drift). Shown only: updating is reinstalling from the skill page (D-7).
 */
export type DriftKind = 'latest' | 'upstream' | 'local' | 'unknown';
export type Drift = {
  change: DriftKind;
  newCommitAt: string | null;
  riskFrom: RiskLevel | null;
  riskTo: RiskLevel | null;
  indexedRef: string | null;
  upstreamToo: boolean;
  differs: boolean;
};
/** A plugin row's `pinMoved` (installed.ts PinMoved): the marketplace points at another commit than the installed one. */
export type PinMoved = { from: string; to: string; highRisk: number; highSkills: string[]; command: string };

type DiffResponse = {
  path: string;
  name: string;
  skillId: string | null;
  drift: Drift;
  local: { level: RiskLevel; flags: string[] };
  indexed: { repo: string; ref: string; dirPath: string; level: RiskLevel; flags: string[]; commitAt: string | null } | null;
  diff: { text: string; added: number; removed: number; truncated: boolean; approximate: boolean } | null;
  risk: { from: RiskLevel; to: RiskLevel; added: string[]; removed: string[] } | null;
};

/** The chip's words for a drift, or null when there is nothing to say (not indexed). */
export function driftLabel(d: Drift): { text: string; tone: 'ok' | 'warn' | '' } | null {
  switch (d.change) {
    case 'latest':
      return { text: t('최신'), tone: 'ok' };
    case 'upstream': {
      const move = riskMove(d.riskFrom, d.riskTo);
      const ago = formatAgo(d.newCommitAt);
      const rose = d.riskFrom != null && d.riskTo != null && RISK_RANK[d.riskTo] > RISK_RANK[d.riskFrom];
      return { text: move ? t('원본에 새 버전 ({0}, {1})', ago, move) : t('원본에 새 버전 ({0})', ago), tone: rose ? 'warn' : '' };
    }
    case 'local':
      return { text: d.upstreamToo ? t('내가 고침 (원본도 새 버전)') : t('내가 고침'), tone: '' };
    default:
      return d.differs ? { text: t('색인과 다름 (설치 기록 없음)'), tone: '' } : null;
  }
}

/**
 * The 설치됨 row's change chip: "최신 / 원본에 새 버전(N일 전, 위험 낮음→주의) / 내가 고침", with "차이 보기" and
 * "상세에서 다시 설치" when it is not the indexed text. `onOpenSkill` opens the skill page (its 다시 설치 button and
 * confirm dialog are the update path).
 */
export function InstalledChangeChip({ drift, path, skillId, onOpenSkill }: { drift: Drift | undefined; path: string; skillId: string | null; onOpenSkill?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!drift) return null;
  const label = driftLabel(drift);
  if (!label) return null;
  const differs = drift.change !== 'latest';
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className={`status-chip${label.tone ? ` ${label.tone}` : ''}`}>{label.text}</span>
      {differs && (
        <button type="button" className="linkish small" onClick={() => setOpen(true)}>
          {t('차이 보기')}
        </button>
      )}
      {differs && skillId && onOpenSkill && (
        <button type="button" className="linkish small" onClick={() => onOpenSkill(skillId)}>
          {t('상세에서 다시 설치')}
        </button>
      )}
      {open && <InstalledDiffDialog path={path} onOpenChange={setOpen} onOpenSkill={onOpenSkill} />}
    </span>
  );
}

const flagLabel = (f: string) => RISK_FLAGS[f]?.label ?? f;

/** "차이 보기": the installed SKILL.md against the indexed commit's, and the risk signals reinstalling would add or drop. */
export function InstalledDiffDialog({ path, onOpenChange, onOpenSkill }: { path: string; onOpenChange: (open: boolean) => void; onOpenSkill?: (id: string) => void }) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<DiffResponse>('/installed/diff', { path })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String((e as Error).message ?? e)));
    return () => {
      alive = false;
    };
  }, [path]);
  const move = data?.risk ? riskMove(data.risk.from, data.risk.to) : null;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('{0} 차이 보기', data?.name ?? '')}</DialogTitle>
          <DialogDescription>
            {data?.indexed ? t('설치된 SKILL.md(−)와 색인한 원본 {0}@{1}(+)의 줄 단위 차이입니다.', data.indexed.repo, data.indexed.ref.slice(0, 7)) : t('설치된 SKILL.md와 색인한 원본을 비교합니다.')}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="warn-box">{error}</p>}
        {!data && !error && <p className="muted small">{t('불러오는 중…')}</p>}
        {data && !data.indexed && <p className="muted small">{t('색인에 없는 스킬이라 비교할 원본이 없습니다.')}</p>}
        {data?.risk && (
          <div className="small">
            <p>
              {move ? t('위험: {0}', move) : t('위험: {0} (변화 없음)', RISK_LEVEL[data.risk.to] ?? data.risk.to)}
            </p>
            {data.risk.added.length > 0 && <p className="warn-text">{t('다시 설치하면 생기는 신호: {0}', data.risk.added.map(flagLabel).join(', '))}</p>}
            {data.risk.removed.length > 0 && <p className="muted">{t('다시 설치하면 없어지는 신호: {0}', data.risk.removed.map(flagLabel).join(', '))}</p>}
          </div>
        )}
        {data?.diff && (
          <>
            <p className="muted small">
              {data.diff.text ? t('{0}줄 추가, {1}줄 삭제', data.diff.added, data.diff.removed) : t('SKILL.md 내용은 같습니다 (다른 파일이 다를 수 있음).')}
              {data.diff.approximate && ` ${t('차이가 너무 커서 바뀐 부분을 통째로 보입니다.')}`}
              {data.diff.truncated && ` ${t('길어서 앞부분만 보입니다.')}`}
            </p>
            {data.diff.text && (
              <pre className="mono small max-h-[55vh] overflow-auto whitespace-pre" aria-label={t('차이')}>
                {data.diff.text.split('\n').map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith('@@') ? 'text-(--info)' : line.startsWith('+') && i > 1 ? 'text-(--ok)' : line.startsWith('-') && i > 1 ? 'text-(--danger)' : undefined
                    }
                  >
                    {line || ' '}
                  </div>
                ))}
              </pre>
            )}
          </>
        )}
        <DialogFooter>
          {data?.skillId && onOpenSkill && (
            <button type="button" className="ghost" onClick={() => onOpenSkill(data.skillId!)}>
              {t('상세에서 다시 설치')}
            </button>
          )}
          <button type="button" className="primary" onClick={() => onOpenChange(false)}>
            {t('닫기')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A plugin row's note when the marketplace moved its pin (F6): how many of the skills the next `claude plugin update`
 * brings are high risk, and the command to copy. Nothing is run from here (D-7).
 */
export function PluginPinChip({ pinMoved }: { pinMoved: PinMoved | undefined }) {
  if (!pinMoved) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2" title={`${pinMoved.from.slice(0, 7)} → ${pinMoved.to.slice(0, 7)}`}>
      <span className={`status-chip${pinMoved.highRisk > 0 ? ' warn' : ''}`}>
        {t('마켓이 핀을 옮김: 다음 업데이트에 들어올 스킬 중 위험 높음 {0}개', pinMoved.highRisk)}
      </span>
      {pinMoved.highSkills.length > 0 && <span className="muted small">{pinMoved.highSkills.join(', ')}</span>}
      <CopyButton text={pinMoved.command} label={t('업데이트 명령 복사')} className="linkish small" />
    </span>
  );
}

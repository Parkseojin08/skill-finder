import { BREAKDOWN, QUALITY, RISK_FLAGS, RISK_LEVEL } from '../labels.ts';
import { Icon } from './Icon.tsx';
import type { Breakdown, RiskLevel, SourceRef } from '../types.ts';

/** "위험 높음" also differs by shape, not only by its red, which "공식" shares (UI debate 2-8). */
export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className={`badge risk-${level}`}>
      {level === 'high' && <Icon name="alert" size={12} />}
      {RISK_LEVEL[level]}
    </span>
  );
}

/** `owner/repo` of a GitHub link, for the source badge's tooltip. */
const repoOfUrl = (url: string) => url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)/)?.[1] ?? null;

/** Risk level badge followed by the signal names as visible text (meanings in the tooltip). */
export function RiskSummary({ level, flags }: { level: RiskLevel; flags: string[] }) {
  // Real signals first, info-only ones (rm -rf) last so they never push a real signal out of view.
  const ordered = [...flags.filter((f) => !RISK_FLAGS[f]?.info), ...flags.filter((f) => RISK_FLAGS[f]?.info)];
  const tip = ordered.length ? ordered.map((f) => `• ${RISK_FLAGS[f]?.label ?? f}: ${RISK_FLAGS[f]?.meaning ?? ''}`).join('\n') : '발견된 위험 신호가 없습니다';
  const shown = ordered.slice(0, 3);
  return (
    <span className="risk-sum" title={tip}>
      <RiskBadge level={level} />
      {shown.length > 0 && (
        <span className="signals">
          {shown.map((f) => RISK_FLAGS[f]?.label ?? f).join(' · ')}
          {ordered.length > shown.length && ` 외 ${ordered.length - shown.length}`}
        </span>
      )}
    </span>
  );
}

export function RiskFlags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <>
      {flags.map((f) => {
        const info = RISK_FLAGS[f];
        return (
          <span key={f} className={`badge flag ${info?.info ? 'info' : ''}`} title={info?.meaning ?? f}>
            {info?.label ?? f}
          </span>
        );
      })}
    </>
  );
}

export function QualityBadges({ codes }: { codes: string[] }) {
  if (codes.length === 0) return null;
  return (
    <>
      {codes.map((c) => {
        const q = QUALITY[c];
        return (
          <span key={c} className={`badge quality ${q?.info ? 'info' : ''}`} title={q?.meaning ?? c}>
            {q?.label ?? c}
          </span>
        );
      })}
    </>
  );
}

export function SourceBadges({ sources }: { sources: SourceRef[] }) {
  return (
    <>
      {sources.map((s) => (
        <a
          key={`${s.kind}:${s.label}`}
          className={`badge source source-${s.kind} ${s.label === '공식' ? 'official' : ''}`}
          href={s.url || undefined}
          target="_blank"
          rel="noopener noreferrer"
          title={repoOfUrl(s.url) ?? undefined}
          onClick={(e) => e.stopPropagation()}
        >
          {s.label === '공식' && <Icon name="check" size={12} />}
          {s.label}
        </a>
      ))}
    </>
  );
}

/** The server's fixed weights (settings.ts; no longer a setting, UI debate D-1). */
const WEIGHTS: Breakdown = { R: 0.55, P: 0.2, F: 0.1, T: 0.15 };
const ORDER_NOTE = '결과 순서는 이름 일치 → 다운로드 → 스타 기준이라 이 점수 순서와 다를 수 있습니다';

export function ScoreBar({ score, breakdown }: { score: number; breakdown: Breakdown }) {
  const w = WEIGHTS;
  return (
    <span className="score" tabIndex={0} aria-label={`점수 ${Math.round(score * 100)}. ${ORDER_NOTE}`}>
      <span className="score-bar">
        <span className="score-fill" style={{ width: `${Math.round(score * 100)}%` }} />
      </span>
      <span className="score-num">{Math.round(score * 100)}</span>
      <span className="score-tip" role="tooltip">
        {(Object.keys(BREAKDOWN) as Array<keyof Breakdown>).map((k) => (
          <span key={k} className="tip-row">
            <span>{BREAKDOWN[k]}</span>
            <span className="tip-bar">
              <span style={{ width: `${Math.round(breakdown[k] * 100)}%` }} />
            </span>
            <span className="mono">
              {breakdown[k].toFixed(2)} × {w[k]}
            </span>
          </span>
        ))}
        <span className="tip-note">관련도는 키워드 일치와 검색 순위로 계산</span>
        <span className="tip-note">{ORDER_NOTE}</span>
      </span>
    </span>
  );
}

export function BreakdownTable({ breakdown }: { breakdown: Partial<Breakdown> }) {
  const w = WEIGHTS;
  return (
    <div className="breakdown">
      {(Object.keys(BREAKDOWN) as Array<keyof Breakdown>).map((k) => (
        <div key={k} className="tip-row">
          <span>{BREAKDOWN[k]}</span>
          <span className="tip-bar">
            <span style={{ width: `${Math.round((breakdown[k] ?? 0) * 100)}%` }} />
          </span>
          <span className="mono">{breakdown[k] == null ? '–' : `${breakdown[k]!.toFixed(2)} × ${w[k]}`}</span>
        </div>
      ))}
    </div>
  );
}

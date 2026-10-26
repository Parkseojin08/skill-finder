import { BREAKDOWN, QUALITY, RISK_FLAGS, RISK_LEVEL } from '../labels.ts';
import type { Breakdown, RiskLevel, SourceRef } from '../types.ts';

export function RiskBadge({ level }: { level: RiskLevel }) {
  return <span className={`badge risk-${level}`}>{RISK_LEVEL[level]}</span>;
}

/** Risk level badge followed by the signal names as visible text (meanings in the tooltip). */
export function RiskSummary({ level, flags }: { level: RiskLevel; flags: string[] }) {
  // Real signals first, info-only ones (rm -rf) last so they never push a real signal out of view.
  const ordered = [...flags.filter((f) => !RISK_FLAGS[f]?.info), ...flags.filter((f) => RISK_FLAGS[f]?.info)];
  const tip = ordered.length ? ordered.map((f) => `• ${RISK_FLAGS[f]?.label ?? f}: ${RISK_FLAGS[f]?.meaning ?? ''}`).join('\n') : '발견된 위험 신호가 없습니다';
  const shown = ordered.slice(0, 3);
  return (
    <span className="risk-sum" title={tip}>
      <span className={`badge risk-${level}`}>{RISK_LEVEL[level]}</span>
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
          onClick={(e) => e.stopPropagation()}
        >
          {s.label}
        </a>
      ))}
    </>
  );
}

export function ScoreBar({ score, breakdown, weights }: { score: number; breakdown: Breakdown; weights?: Breakdown }) {
  const w = weights ?? { R: 0.55, P: 0.2, F: 0.1, T: 0.15 };
  return (
    <span className="score" tabIndex={0} aria-label={`점수 ${Math.round(score * 100)}`}>
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
      </span>
    </span>
  );
}

export function BreakdownTable({ breakdown, weights }: { breakdown: Partial<Breakdown>; weights?: Breakdown }) {
  const w = weights ?? { R: 0.55, P: 0.2, F: 0.1, T: 0.15 };
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

import { BREAKDOWN, QUALITY, RISK_FLAGS, RISK_LEVEL } from '../labels.ts';
import { Icon } from './Icon.tsx';
import type { Breakdown, RiskLevel, SourceRef } from '../types.ts';
import { serverText, t } from '../i18n.ts';

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
const repoOfUrl = (url: string) => url.match(/^https:\/\/(?:github\.com|skills\.sh)\/([^/]+\/[^/]+)/)?.[1] ?? null;

/** Risk level badge followed by the signal names as visible text (meanings in the tooltip). */
export function RiskSummary({ level, flags }: { level: RiskLevel; flags: string[] }) {
  // Real signals first, info-only ones (rm -rf) last so they never push a real signal out of view.
  const ordered = [...flags.filter((f) => !RISK_FLAGS[f]?.info), ...flags.filter((f) => RISK_FLAGS[f]?.info)];
  const tip = ordered.length ? ordered.map((f) => `• ${RISK_FLAGS[f]?.label ?? f}: ${RISK_FLAGS[f]?.meaning ?? ''}`).join('\n') : t('발견된 위험 신호가 없습니다');
  const shown = ordered.slice(0, 3);
  return (
    <span className="risk-sum" title={tip}>
      <RiskBadge level={level} />
      {shown.length > 0 && (
        <span className="signals">
          {shown.map((f) => RISK_FLAGS[f]?.label ?? f).join(' · ')}
          {ordered.length > shown.length && t(' 외 {0}', ordered.length - shown.length)}
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
          {serverText(s.label)}
        </a>
      ))}
    </>
  );
}

/**
 * "사본 N곳": the same SKILL.md in other repos, folded into this result (their downloads are added). Their repos are
 * in the tooltip; the badges beside it are this skill's own pages (review 2026-11-02).
 */
export function CopiesBadge({ copies }: { copies?: SourceRef[] }) {
  const repos = [...new Set((copies ?? []).map((s) => repoOfUrl(s.url)).filter(Boolean))];
  if (!repos.length) return null;
  return (
    <span className="badge copies" title={t('같은 SKILL.md가 있는 다른 저장소: {0}', repos.join(', '))}>
      {t('사본 ')}{repos.length}{t('곳')}
    </span>
  );
}

/** The server's fixed weights (settings.ts; no longer a setting, UI debate D-1). The score is shown on the detail
 * page only: results are ordered by name match, downloads and stars, so a bar on each card read as the order. */
const WEIGHTS: Breakdown = { R: 0.55, P: 0.2, F: 0.1, T: 0.15 };

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

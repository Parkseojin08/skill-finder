import type { RiskLevel } from '../../types.ts';
import { t } from '../../i18n.ts';

/**
 * A search with no results: why, as far as the page can tell (stars unknown, still collecting, or the wording), and
 * the conditions in force, each with a way to drop it and search again (split out of SearchPage).
 */
export function NoResults(props: {
  hiddenUnknownStars: number;
  hiddenLowStars: number;
  /** The index or the repo star counts are still being gathered (first run). */
  gathering: boolean;
  hasToken: boolean;
  sourcesOff: number;
  maxRisk: RiskLevel;
  minStars: number;
  /** What the risk limit and the star minimum hid: a condition that hid nothing is not offered (review 2026-11-02). */
  riskHidden: number;
  starsHidden: number;
  onAllSources: () => void;
  onAllRisk: () => void;
  onLiftStars: () => void;
}) {
  const { hiddenUnknownStars, hiddenLowStars, gathering, sourcesOff, maxRisk, minStars, riskHidden, starsHidden } = props;
  const riskChip = maxRisk !== 'high' && riskHidden > 0;
  const starsChip = minStars > 0 && starsHidden > 0;
  return (
    <div className="empty">
      <p>
        {t('결과가 없습니다.')}
        {hiddenUnknownStars > 0 && hiddenUnknownStars >= hiddenLowStars
          ? t(' 저장소 별 수를 아직 몰라서 {0}개를 숨겼습니다{1}. 아래에서 이번만 풀고 보세요.{2}', hiddenUnknownStars, gathering ? t(' (처음 실행이라 정보를 모으는 중입니다)') : '', props.hasToken ? '' : t(' 설정에서 GitHub 토큰을 넣으면 별 수가 빨리 채워집니다.'))
          : gathering
            ? t(' 아직 스킬 목록을 모으는 중이라 결과가 적을 수 있습니다. 잠시 뒤 다시 검색해 보세요.')
            : t(' 다른 영어 표현으로 검색해 보세요.')}
      </p>
      {(sourcesOff > 0 || riskChip || starsChip) && (
        <div className="examples">
          <span className="muted small">{t('다시 찾아볼 조건:')}</span>
          {sourcesOff > 0 && (
            <button type="button" className="chip-btn" onClick={props.onAllSources}>
              {t('출처 ')}{sourcesOff}{t('곳 꺼짐 · 모두 켜고 다시 찾기')}
            </button>
          )}
          {riskChip && (
            <button type="button" className="chip-btn" onClick={props.onAllRisk}>
              {t('위험 ')}{maxRisk === 'low' ? t('낮음만') : t('주의까지')}{t('으로 ')}{riskHidden}{t('개 숨김 · 모두 보고 다시 찾기')}
            </button>
          )}
          {starsChip && (
            <button type="button" className="chip-btn" onClick={props.onLiftStars}>
              {t('별 ')}{minStars.toLocaleString()}{t(' 기준으로 ')}{starsHidden}{t('개 숨김 · 이번만 풀고 다시 찾기')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

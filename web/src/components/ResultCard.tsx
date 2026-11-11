import type { MouseEvent } from 'react';
import { Icon } from './Icon.tsx';
import { CATEGORY, formatAgo, formatCount } from '../labels.ts';
import { TRANSLATE_TO, useKorean } from '../translate.ts';
import type { OpenedFrom, ResultItem } from '../types.ts';
import { repoOf } from '../lib/resultOrder.ts';
import { suspectReasonText, type SearchItem } from '../lib/searchExtras.ts';
import { CopiesBadge, RiskSummary, SourceBadges } from './Badges.tsx';
import { FavoriteButton } from './FavoriteButton.tsx';
import { OwnerPrefMenu } from './search/OwnerPrefMenu.tsx';
import { itemRepo } from '../lib/ownerPrefs.ts';
import { t } from '../i18n.ts';


/**
 * The skill page's address; `from` (where in a search it was) rides along so a new tab still logs the view, and
 * `project` (the folder chosen on README 추천 or 설치됨) so its install panel starts at that project.
 */
export function skillHref(id: string, from?: OpenedFrom, project?: string | null): string {
  const q = new URLSearchParams({ id });
  if (project) q.set('project', project);
  if (from?.sid) {
    q.set('sid', from.sid);
    if (from.pos) q.set('pos', String(from.pos));
    if (from.page) q.set('page', String(from.page));
    if (from.provisional) q.set('prov', '1');
  }
  return `/skill?${q}`;
}

/** A plain left click opens the skill in place; with a modifier or the middle button the browser opens the link. */
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function ResultCard({
  item,
  position,
  provisional,
  belowMinStars,
  href,
  installed,
  onSelect,
}: {
  item: ResultItem;
  position: number;
  provisional?: boolean;
  /** Shown only because the star minimum was lifted for this search: the minimum it falls short of. */
  belowMinStars?: number;
  /** The skill page's address (with where in the search it was), so it also opens in a new tab. */
  href: string;
  /** Where it is installed ("개인", "플러그인 프로젝트"), when known. */
  installed?: string | null;
  onSelect: () => void;
}) {
  const { ko, waiting } = useKorean(item.description, position);
  const suspect = (item as SearchItem).installsSuspect;
  const repo = repoOf(item);
  // installing this skill installs the whole plugin, riskier skills included (UI debate 2-6)
  const pluginHigh = item.plugin?.topRisk === 'high' && item.riskLevel !== 'high';
  return (
    // The title link covers the card (CSS), so the card reads as one link named after the skill and the
    // rest of its text is read as usual (UI debate 2-2).
    <article className={`card ${provisional ? 'provisional' : ''}`}>
      <div className="card-head">
        <div className="card-title">
          <h3>
            <a
              className="card-link"
              href={href}
              data-id={item.id}
              onClick={(e) => {
                if (!plainClick(e)) return;
                e.preventDefault();
                onSelect();
              }}
            >
              {item.name}
            </a>
          </h3>
          {repo && (
            <span className="muted small mono card-owner" title={t('만든 곳 (GitHub 저장소)')}>
              {repo}
            </span>
          )}
          {item.plugin && (
            <span className="muted small" title={t('{0} 마켓플레이스의 플러그인', item.plugin.marketplace)}>
              {item.plugin.name}
              {item.plugin.skillCount > 1 ? t(' · 스킬 {0}개', item.plugin.skillCount) : ''}
            </span>
          )}
        </div>
        <span className="card-actions">
          <FavoriteButton id={item.id} name={item.name} />
          {/* F20: hide this repository, trust its owner */}
          <OwnerPrefMenu repo={itemRepo(item)} />
        </span>
      </div>
      <p className="summary clamp" title={ko ? item.description : undefined} lang={ko ? (TRANSLATE_TO ?? 'en') : 'en'}>
        {waiting && <span className="translating">{t('번역 중 · ')}</span>}
        {ko ?? (item.description || t('설명 없음'))}
      </p>
      <div className="card-foot">
        <div className="meta">
          <SourceBadges sources={item.sources} />
          <CopiesBadge copies={item.copies} />
          {item.installs != null && (
            <span className="stat" title={t('설치 수 (skills.sh)')}>
              <Icon name="download" size={14} /> <span className="sr-only">{t('설치 수 ')}</span>
              {formatCount(item.installs)}
            </span>
          )}
          {suspect && (
            // F18: the count is shown but not trusted; sorting treats it as unknown
            <span
              className="status-chip warn"
              title={[...suspect.reasons.map(suspectReasonText), t('정렬할 때는 다운로드 수를 모르는 것으로 봅니다.')].join('\n')}
            >
              <Icon name="download" size={13} /> {formatCount(suspect.installs)} · {t('다운로드 수 의심')}
            </span>
          )}
          {item.stars != null && (
            <span className="stat" title={t('GitHub 스타')}>
              <Icon name="star" size={14} /> <span className="sr-only">{t('GitHub 스타 ')}</span>
              {formatCount(item.stars)}
            </span>
          )}
          {belowMinStars != null && (
            <span className="status-chip warn" title={t('설정한 최소 스타 수보다 적거나 스타 수를 모르는 저장소입니다')}>
              {item.stars == null ? t('별 수 모름') : t('별 {0} 미만', belowMinStars.toLocaleString())}
            </span>
          )}
          {item.lastCommitAt && (
            <span className="stat" title={t('최근 커밋')}>
              <Icon name="clock" size={14} /> <span className="sr-only">{t('최근 커밋 ')}</span>
              {formatAgo(item.lastCommitAt)}
            </span>
          )}
          {(item.categories ?? [])
            .filter((c) => c !== 'other')
            .map((c) => (
              <span key={c} className="cat-tag" title={t('자동 분류된 카테고리')}>
                #{CATEGORY[c] ?? c}
              </span>
            ))}
        </div>
        <div className="card-tags">
          {installed && (
            <span className="status-chip ok" title={t('이 PC에 설치되어 있습니다')}>
              <Icon name="check" size={13} />{' '}{t('설치됨 · {0}', installed)}
            </span>
          )}
          <RiskSummary level={item.riskLevel} flags={item.riskFlags} />
          {pluginHigh && (
            <span className="status-chip warn" title={t('이 스킬을 설치하면 플러그인 전체가 설치되고, 그 안에 위험 높음 스킬이 있습니다')}>
              <Icon name="alert" size={13} />{t(' 플러그인에 위험 높음 포함')}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

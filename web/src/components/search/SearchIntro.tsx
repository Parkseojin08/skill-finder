import { useEffect, useState } from 'react';
import { apiGet } from '../../api.ts';
import { CATEGORY, TRUST } from '../../labels.ts';
import { goInApp } from '../../lib/links.ts';
import type { BrowseOverview, BrowseView, RecentSearch } from '../../lib/searchExtras.ts';
import type { Health } from '../../types.ts';
import { TranslationNotice } from '../TranslationNotice.tsx';
import { t } from '../../i18n.ts';
import { tj } from '../../i18nNodes.tsx';
import './search-stage2.css';

/** Recent searches shown as chips (F16). */
const RECENT = 5;

/**
 * The search page before a search (split out of SearchPage): what it does, the recent searches, and browsing the
 * local index (F17, user decision 1: here, not a new tab) by category, source, Anthropic's collection, what is new
 * this week and the plugins that install as one bundle. A tile opens the same result list a search does.
 */
export function SearchIntro({
  examples,
  onExample,
  onBrowse,
  health,
  githubToken,
}: {
  examples: string[];
  /** A recent search or an example query: searched as it is. */
  onExample: (query: string) => void;
  onBrowse: (view: BrowseView) => void;
  health: Health | null;
  githubToken: boolean | null;
}) {
  const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [overview, setOverview] = useState<BrowseOverview | null>(null);
  useEffect(() => {
    // with the search log off the server answers an empty list
    apiGet<{ items: RecentSearch[] }>('/history', { kind: 'search', limit: String(RECENT) })
      .then((r) => setRecent(r.items))
      .catch(() => {});
    apiGet<BrowseOverview>('/browse')
      .then(setOverview)
      .catch(() => {});
    // the index grows on a first run: counts read again with the skill count
  }, [health?.skills]);

  const tile = (key: string, label: string, count: number, view: BrowseView, wide = false) => (
    <button key={key} type="button" className={`browse-tile${wide ? ' wide' : ''}`} disabled={count === 0} onClick={() => onBrowse(view)}>
      <span>{label}</span>
      <span className="count">{count.toLocaleString()}</span>
    </button>
  );

  return (
    <div className="empty">
      <p>
        {t('원하는 기능을 적으면 공식·커뮤니티 마켓플레이스, skills.sh, GitHub에서 Claude Code 스킬을 찾아 점수와 위험 신호를 붙여 보여 줍니다. 영어로 적을 때 가장 정확하고, 한국어로 적으면 영어 검색어를 제안합니다.')}
      </p>
      {recent.length > 0 && (
        <div className="recent-searches" aria-label={t('최근 검색')}>
          <span className="muted small">{t('최근 검색')}</span>
          {recent.map((r) => (
            <button key={r.query} type="button" className="chip-btn" onClick={() => onExample(r.query)} title={r.results != null ? t('그때 결과 {0}개', r.results) : undefined}>
              {r.query}
            </button>
          ))}
          <a className="muted small" href="/settings" onClick={(e) => goInApp(e, '/settings')}>
            {t('기록 관리')}
          </a>
        </div>
      )}
      <div className="examples">
        {examples.map((ex) => (
          <button key={ex} type="button" className="chip-btn" onClick={() => onExample(ex)}>
            {ex}
          </button>
        ))}
      </div>

      {overview && overview.total > 0 && (
        <section className="browse" aria-label={t('둘러보기')}>
          <h2>{t('둘러보기 · 내 PC 색인')}</h2>
          <p className="muted small">
            {overview.minStars > 0
              ? t('검색과 같은 조건입니다: 별 {0}개 이상 저장소와 공식·파트너 스킬, 위험 높음 제외, 같은 SKILL.md는 한 장.', overview.minStars.toLocaleString())
              : t('검색과 같은 조건입니다: 위험 높음 제외, 같은 SKILL.md는 한 장.')}
          </p>
          <div className="browse-grid">
            {tile('anthropic', t('Anthropic 공식 컬렉션'), overview.anthropic, { section: 'anthropic' }, true)}
            {tile('new', t('이번 주 새로 들어온'), overview.newThisWeek, { section: 'new' }, true)}
            {tile('plugins', t('한 번에 설치되는 묶음(플러그인)'), overview.plugins, { section: 'plugins' }, true)}
          </div>
          <h2>{t('카테고리')}</h2>
          <div className="browse-grid">{overview.categories.map((c) => tile(c.key, CATEGORY[c.key] ?? c.key, c.count, { cat: c.key }))}</div>
          <h2>{t('출처')}</h2>
          <div className="browse-grid">
            {overview.trust.map((s) => tile(s.key, TRUST[s.key].label, s.count, { trust: s.key }))}
            {overview.marketplaces.map((m) => tile(`mp:${m.name}`, m.name, m.count, { marketplace: m.name }, true))}
          </div>
        </section>
      )}

      {health && (
        <p className="sysline">
          {health.appVersion && <span>skill-finder {health.appVersion}</span>}
          <span className={health.claudeVersion ? '' : 'warn-text'}>claude-code {health.claudeVersion ?? t('없음')}</span>
          <span>skills-cli {health.skillsCli}</span>
          <span>
            {t('색인 스킬 {0} · 플러그인 {1}', health.skills.toLocaleString(), health.plugins.toLocaleString())}
          </span>
        </p>
      )}
      {health && !health.claudeVersion && <p className="warn-text small">{t('Claude Code를 찾지 못해 플러그인 설치가 되지 않습니다.')}</p>}
      {githubToken === false && (
        // before the first search only (UI debate D-4); in results it stays in the folded notices (D#260b)
        <p className="muted small">
          {tj('GitHub 토큰 없음 · GitHub 코드 검색을 건너뛰고 스킬 목록도 느리게 모읍니다. {0}', <a href="/settings" onClick={(e) => goInApp(e, '/settings')}>
            {t('설정에서 넣기')}
          </a>)}
        </p>
      )}
      <TranslationNotice />
    </div>
  );
}

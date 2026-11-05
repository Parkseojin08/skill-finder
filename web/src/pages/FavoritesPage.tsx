import { useEffect, useState } from 'react';
import { apiGet } from '../api.ts';
import { ActiveFacets, FacetPanel, facetCount, matchFacets, NO_FACETS, type Facets } from '../components/FacetPanel.tsx';
import { RepoCard } from '../components/RepoCard.tsx';
import { ResultCard, skillHref } from '../components/ResultCard.tsx';
import { NoticeChip } from '../components/NoticeChip.tsx';
import { repoFavoriteId, toggleFavorite, useFavorites } from '../favorites.ts';
import { useInstalled } from '../installed.ts';
import { RISK_RANK } from '../labels.ts';
import { noticesFor, useNotices, type Notice } from '../notices.ts';
import type { RepoResult, ResultItem } from '../types.ts';
import { t } from '../i18n.ts';

type Favorites = { items: ResultItem[]; repos: RepoResult[]; gone: Array<{ id: string; name: string }> };
type Kind = 'skill' | 'repo';

/**
 * This PC's favorite skills and GitHub repositories, newest first (user decisions 2026-11-02, 2026-11-03), narrowed
 * by the side checkboxes: what kind, then the search's provider, category and install method (skills only).
 */
/**
 * What changed about a favorite since it was starred (feature review F7, the same notices as the 설치됨 badge): the
 * newest three, the unseen ones marked, and "확인" to mark them seen.
 */
function ChangeChips({ notices, onSeen }: { notices: Notice[]; onSeen: (ids: number[]) => Promise<void> }) {
  if (notices.length === 0) return null;
  const unseen = notices.filter((n) => !n.seenAt).map((n) => n.id);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 pt-1.5" aria-label={t('바뀐 점')}>
      {notices.slice(0, 3).map((n) => (
        <NoticeChip key={n.id} notice={n} />
      ))}
      {notices.length > 3 && <span className="muted small">{t('외 {0}건', notices.length - 3)}</span>}
      {unseen.length > 0 && (
        <button type="button" className="linkish small" onClick={() => void onSeen(unseen).catch(() => {})}>
          {t('확인')}
        </button>
      )}
    </span>
  );
}

export function FavoritesPage({ onOpen, onOpenId }: { onOpen: (item: ResultItem) => void; onOpenId: (id: string) => void }) {
  const favorites = useFavorites();
  const installedAs = useInstalled();
  const { notices, markSeen } = useNotices();
  const [data, setData] = useState<Favorites | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const [kinds, setKinds] = useState<Kind[]>([]);
  // reload when the set of favorites changes (a star clicked elsewhere)
  const key = [...favorites].join('|');
  useEffect(() => {
    let alive = true;
    apiGet<Favorites>('/favorites')
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = data?.items ?? [];
  const repos = data?.repos ?? [];
  const gone = data?.gone ?? [];
  const total = items.length + repos.length + gone.length;
  const kindOk = (k: Kind) => kinds.length === 0 || kinds.includes(k);
  // repositories and skills not in the index have no provider, category or method: those filters leave them out
  const plain = facetCount(facets) === 0;
  const matching = items.filter((it) => matchFacets(it, facets));
  const counts: Record<Kind, number> = { skill: matching.length + (plain ? gone.length : 0), repo: plain ? repos.length : 0 };
  const shownItems = kindOk('skill') ? matching : [];
  const shownRepos = kindOk('repo') && plain ? repos : [];
  const shownGone = kindOk('skill') && plain ? gone : [];
  const shown = shownItems.length + shownRepos.length + shownGone.length;
  const kindLabel: Record<Kind, string> = { skill: t('스킬'), repo: t('GitHub 저장소') };
  const toggleKind = (k: Kind) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  const reset = () => {
    setFacets(NO_FACETS);
    setKinds([]);
  };

  const kindGroup = (
    <fieldset className="facet">
      <legend>{t('종류')}</legend>
      {(['skill', 'repo'] as const).map((k) => (
        <label key={k} className="facet-opt">
          <input type="checkbox" checked={kinds.includes(k)} disabled={!counts[k] && !kinds.includes(k)} onChange={() => toggleKind(k)} />
          <span className="facet-label">{kindLabel[k]}</span>
          <span className="facet-count">{counts[k]}</span>
        </label>
      ))}
    </fieldset>
  );

  return (
    <div className="page favorites-page">
      <h1>{t('즐겨찾기')}</h1>
      {error && <p className="warn-box">{error}</p>}
      {data && total === 0 && <p className="empty">{t('아직 즐겨찾기가 없습니다. 검색 결과나 스킬 화면의 별을 누르면 여기에 모입니다.')}</p>}
      {data && total > 0 && (
        <div className="results-layout">
          <FacetPanel items={kindOk('skill') ? items : []} value={facets} onChange={setFacets} extra={{ node: kindGroup, active: kinds.length, reset }} />
          <div className="results-main">
            <div className="results-toolbar">
              <span className="muted small">{t('{0}개 중 {1}개', total, shown)}</span>
              {kinds.map((k) => (
                <button key={k} type="button" className="status-chip action" aria-label={t('필터 {0} 끄기', kindLabel[k])} onClick={() => toggleKind(k)}>
                  {t('필터 {0}', kindLabel[k])} ×
                </button>
              ))}
              <ActiveFacets value={facets} onChange={setFacets} />
            </div>
            {shown === 0 && (
              <p className="empty">
                {t('조건에 맞는 즐겨찾기가 없습니다.')}{' '}
                <button type="button" className="linkish" onClick={reset}>
                  {t('필터 초기화')}
                </button>
              </p>
            )}
            {shownRepos.length > 0 && (
              <div className="repo-results" aria-label={t('GitHub 저장소')}>
                {shownRepos.map((r) => (
                  <div key={r.repo}>
                    {/* the search's default risk limit applies to what a repository's 설치 button installs here too */}
                    <RepoCard repo={{ ...r, skills: r.skills.filter((s) => RISK_RANK[s.riskLevel] <= RISK_RANK.medium) }} onOpenSkill={onOpenId} />
                    <ChangeChips notices={noticesFor(notices, repoFavoriteId(r.repo))} onSeen={markSeen} />
                  </div>
                ))}
              </div>
            )}
            {shownItems.length > 0 && (
              <div className="results">
                {shownItems.map((it, i) => (
                  <div key={it.id}>
                    <ResultCard item={it} position={i} href={skillHref(it.id)} installed={installedAs(it)} onSelect={() => onOpen(it)} />
                    <ChangeChips notices={noticesFor(notices, it.id)} onSeen={markSeen} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* a section of the page itself, for its panel look (.page > section) */}
      {shownGone.length > 0 && (
        <section>
          <h2>{t('색인에 없는 스킬')}</h2>
          <p className="muted small">{t('검색 중에 별을 눌러 아직 확인 중이던 결과이거나, 색인에서 빠진 스킬입니다. 색인에 들어오면 위에 카드로 나옵니다.')}</p>
          <ul className="explain">
            {shownGone.map((g) => (
              <li key={g.id}>
                <span className="mono">{g.name}</span> <ChangeChips notices={noticesFor(notices, g.id)} onSeen={markSeen} />{' '}
                <button type="button" className="linkish small" onClick={() => void toggleFavorite(g.id).catch(() => {})}>
                  {t('즐겨찾기에서 빼기')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

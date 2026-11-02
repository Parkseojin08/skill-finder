import { useEffect, useState } from 'react';
import { apiGet } from '../api.ts';
import { ResultCard, skillHref } from '../components/ResultCard.tsx';
import { toggleFavorite, useFavorites } from '../favorites.ts';
import { useInstalled } from '../installed.ts';
import type { ResultItem } from '../types.ts';
import { t } from '../i18n.ts';

type Favorites = { items: ResultItem[]; gone: Array<{ id: string; name: string }> };

/** This PC's favorite skills, newest first (user decision 2026-11-02). */
export function FavoritesPage({ onOpen }: { onOpen: (item: ResultItem) => void }) {
  const favorites = useFavorites();
  const installedAs = useInstalled();
  const [data, setData] = useState<Favorites | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="page favorites-page">
      <h1>{t('즐겨찾기')}</h1>
      {error && <p className="warn-box">{error}</p>}
      {data && data.items.length === 0 && data.gone.length === 0 && (
        <p className="empty">{t('아직 즐겨찾기가 없습니다. 검색 결과나 스킬 화면의 별을 누르면 여기에 모입니다.')}</p>
      )}
      {data && data.items.length > 0 && (
        <div className="results">
          {data.items.map((it, i) => (
            <ResultCard key={it.id} item={it} position={i} href={skillHref(it.id)} installed={installedAs(it)} onSelect={() => onOpen(it)} />
          ))}
        </div>
      )}
      {data && data.gone.length > 0 && (
        <section>
          <h2>{t('색인에 없는 스킬')}</h2>
          <p className="muted small">{t('검색 중에 별을 눌러 아직 확인 중이던 결과이거나, 색인에서 빠진 스킬입니다. 색인에 들어오면 위에 카드로 나옵니다.')}</p>
          <ul className="explain">
            {data.gone.map((g) => (
              <li key={g.id}>
                <span className="mono">{g.name}</span>{' '}
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

import { useEffect, useState } from 'react';
import { apiGet } from '../api.ts';
import { askLogin, toggleFavorite, useAccount } from '../account.ts';
import { ResultCard, skillHref } from '../components/ResultCard.tsx';
import { useInstalled } from '../installed.ts';
import type { ResultItem } from '../types.ts';

type Favorites = { items: ResultItem[]; gone: Array<{ id: string; name: string }> };

/** The signed-in account's favorite skills, newest first (user decision 2026-11-02). */
export function FavoritesPage({ onOpen }: { onOpen: (item: ResultItem) => void }) {
  const { user, loaded, favorites } = useAccount();
  const installedAs = useInstalled();
  const [data, setData] = useState<Favorites | null>(null);
  const [error, setError] = useState<string | null>(null);
  // reload when the account or the set of favorites changes (a star clicked elsewhere)
  const key = user ? `${user.id}:${[...favorites].join('|')}` : '';
  useEffect(() => {
    if (!user) return setData(null);
    let alive = true;
    apiGet<Favorites>('/favorites')
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page favorites-page">
      <h1>즐겨찾기</h1>
      {loaded && !user && (
        <div className="empty">
          <p>즐겨찾기는 로그인한 뒤에 쓸 수 있습니다. 계정은 이 PC의 Skill Finder에만 저장됩니다.</p>
          <button type="button" className="primary" onClick={() => askLogin()}>
            로그인 · 회원가입
          </button>
        </div>
      )}
      {error && <p className="warn-box">{error}</p>}
      {user && data && data.items.length === 0 && data.gone.length === 0 && (
        <p className="empty">아직 즐겨찾기가 없습니다. 검색 결과나 스킬 화면의 별을 누르면 여기에 모입니다.</p>
      )}
      {user && data && data.items.length > 0 && (
        <div className="results">
          {data.items.map((it, i) => (
            <ResultCard key={it.id} item={it} position={i} href={skillHref(it.id)} installed={installedAs(it)} onSelect={() => onOpen(it)} />
          ))}
        </div>
      )}
      {user && data && data.gone.length > 0 && (
        <section>
          <h2>색인에서 사라진 스킬</h2>
          <ul className="explain">
            {data.gone.map((g) => (
              <li key={g.id}>
                <span className="mono">{g.name}</span>{' '}
                <button type="button" className="linkish small" onClick={() => void toggleFavorite(g.id).catch(() => {})}>
                  즐겨찾기에서 빼기
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

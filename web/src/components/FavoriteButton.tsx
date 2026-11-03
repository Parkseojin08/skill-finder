import { StarIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { toggleFavorite, useFavorites } from '../favorites.ts';
import { t } from '../i18n.ts';

/** The star on a result card and a skill page: this PC's favorites, no account (user decision 2026-11-02). */
export function FavoriteButton({ id, name, extra, className = '' }: { id: string; name: string; extra?: Record<string, unknown>; className?: string }) {
  const on = useFavorites().has(id);
  // a refused change used to put the star back without a word
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);
  return (
    <span className="fav-wrap">
      <button
        type="button"
        className={`fav-btn ${on ? 'on' : ''} ${className}`}
        aria-pressed={on}
        aria-label={on ? t('{0} 즐겨찾기에서 빼기', name) : t('{0} 즐겨찾기에 넣기', name)}
        title={on ? t('즐겨찾기에서 빼기') : t('즐겨찾기에 넣기')}
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          // the API already put the server's message in the screen's language
          toggleFavorite(id, name, extra).catch((err: Error) => setError(t('즐겨찾기를 바꾸지 못했습니다: {0}', err.message)));
        }}
      >
        <StarIcon weight={on ? 'fill' : 'regular'} aria-hidden />
      </button>
      <span role="status" className={error ? 'fav-error' : 'sr-only'}>
        {error}
      </span>
    </span>
  );
}

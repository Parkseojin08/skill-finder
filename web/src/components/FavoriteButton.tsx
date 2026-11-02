import { StarIcon } from '@phosphor-icons/react';
import { toggleFavorite, useFavorites } from '../favorites.ts';
import { t } from '../i18n.ts';

/** The star on a result card and a skill page: this PC's favorites, no account (user decision 2026-11-02). */
export function FavoriteButton({ id, name, className = '' }: { id: string; name: string; className?: string }) {
  const on = useFavorites().has(id);
  return (
    <button
      type="button"
      className={`fav-btn ${on ? 'on' : ''} ${className}`}
      aria-pressed={on}
      aria-label={on ? t('{0} 즐겨찾기에서 빼기', name) : t('{0} 즐겨찾기에 넣기', name)}
      title={on ? t('즐겨찾기에서 빼기') : t('즐겨찾기에 넣기')}
      onClick={(e) => {
        e.stopPropagation();
        void toggleFavorite(id).catch(() => {});
      }}
    >
      <StarIcon weight={on ? 'fill' : 'regular'} aria-hidden />
    </button>
  );
}

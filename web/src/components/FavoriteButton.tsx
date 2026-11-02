import { StarIcon } from '@phosphor-icons/react';
import { askLogin, toggleFavorite, useAccount } from '../account.ts';
import { t } from '../i18n.ts';

/** The star on a result card and a skill page; signed out, it opens the login dialog (favorites need an account). */
export function FavoriteButton({ id, name, className = '' }: { id: string; name: string; className?: string }) {
  const { user, favorites } = useAccount();
  const on = favorites.has(id);
  return (
    <button
      type="button"
      className={`fav-btn ${on ? 'on' : ''} ${className}`}
      aria-pressed={user ? on : undefined}
      aria-label={on ? t('{0} 즐겨찾기에서 빼기', name) : t('{0} 즐겨찾기에 넣기', name)}
      title={user ? (on ? t('즐겨찾기에서 빼기') : t('즐겨찾기에 넣기')) : t('즐겨찾기는 로그인 후 쓸 수 있습니다')}
      onClick={(e) => {
        e.stopPropagation();
        if (!user) return askLogin(t('즐겨찾기는 로그인한 뒤에 쓸 수 있습니다.'));
        void toggleFavorite(id).catch(() => {});
      }}
    >
      <StarIcon weight={on ? 'fill' : 'regular'} aria-hidden />
    </button>
  );
}

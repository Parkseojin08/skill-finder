import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n.ts';
import { ownerOf, removeOwnerPref, saveOwnerPref, useOwnerPrefs } from '../../lib/ownerPrefs.ts';
import './owner-prefs.css';

/**
 * The "…" menu of a result card or a skill page (F20, feature review 2026-11-04; user decision 18): hide this
 * repository from searches, README recommendations and browsing, or trust its owner (a side filter only, the order
 * and the risk stay). Each item undoes itself once set. Nothing shows for a skill without a GitHub repo.
 */
export function OwnerPrefMenu({ repo, className = '' }: { repo: string | null; className?: string }) {
  const prefs = useOwnerPrefs();
  const ref = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);
  // closes on Esc or a click elsewhere, like the other menus
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        // Esc closes it and hands the focus back to its button, or a keyboard user is left on <body>
        const inside = d.contains(document.activeElement);
        d.open = false;
        if (inside) d.querySelector('summary')?.focus();
      } else if (!d.contains(e.target as Node)) d.open = false;
    };
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
    };
  }, []);
  if (!repo) return null;
  const r = repo.toLowerCase();
  const owner = ownerOf(r)!;
  const repoHidden = prefs.of(r) === 'hide';
  const ownerHidden = prefs.of(owner) === 'hide';
  const ownerTrusted = prefs.of(owner) === 'trust';

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (ref.current) ref.current.open = false;
    } catch (e) {
      setError(t('바꾸지 못했습니다: {0}', (e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className={`owner-menu ${className}`} ref={ref} onClick={(e) => e.stopPropagation()}>
      <summary className="owner-menu-btn" aria-label={t('{0} 저장소 메뉴', repo)} title={t('저장소 숨기기·제작자 믿기')}>
        <span aria-hidden="true">…</span>
      </summary>
      {/* a plain list of buttons under the disclosure: menu roles would promise arrow keys it does not have */}
      <div className="owner-menu-items">
        {repoHidden ? (
          <button type="button" className="ghost" disabled={busy} onClick={() => act(() => removeOwnerPref(r))}>
            {t('저장소 숨김 해제')}
          </button>
        ) : (
          <button
            type="button"
            className="ghost"
            disabled={busy || ownerHidden}
            title={t('검색·README 추천·둘러보기에서 이 저장소의 스킬을 뺍니다. 설정에서 되돌릴 수 있습니다.')}
            onClick={() => act(() => saveOwnerPref(r, 'repo', 'hide'))}
          >
            {t('이 저장소 숨기기')}
          </button>
        )}
        {ownerHidden ? (
          <button type="button" className="ghost" disabled={busy} onClick={() => act(() => removeOwnerPref(owner))}>
            {t('제작자 {0} 숨김 해제', owner)}
          </button>
        ) : ownerTrusted ? (
          <button type="button" className="ghost" disabled={busy} onClick={() => act(() => removeOwnerPref(owner))}>
            {t('제작자 {0} 믿기 해제', owner)}
          </button>
        ) : (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            title={t('사이드 필터 "믿는 제작자"로 골라 볼 수 있습니다. 정렬과 위험 등급은 바뀌지 않습니다.')}
            onClick={() => act(() => saveOwnerPref(owner, 'owner', 'trust'))}
          >
            {t('이 제작자 믿기 ({0})', owner)}
          </button>
        )}
        <p className="muted small">{repo}</p>
      </div>
      <span role="status" className={error ? 'owner-menu-error' : 'sr-only'}>
        {error}
      </span>
    </details>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { FavoritesPage } from './pages/FavoritesPage.tsx';
import { InstalledPage } from './pages/InstalledPage.tsx';
import { MarketplacesPage } from './pages/MarketplacesPage.tsx';
import { RecommendPage } from './pages/RecommendPage.tsx';
import { SearchPage, searchUrl } from './pages/SearchPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { SkillPage } from './pages/SkillPage.tsx';
import { apiGet } from './api.ts';
import type { Health, OpenedFrom, ResultItem } from './types.ts';
import { t } from './i18n.ts';

type Path = '/' | '/recommend' | '/skill' | '/installed' | '/marketplaces' | '/settings' | '/favorites';
type Route = { path: Path; skillId: string | null };

/** `short`: the label on a phone-width window, where the five did not fit (review 2026-11-02). */
const NAV: Array<{ path: Path; label: string; short?: string }> = [
  { path: '/', label: t('검색') },
  { path: '/recommend', label: t('README 추천'), short: t('추천') },
  { path: '/installed', label: t('설치됨') },
  { path: '/favorites', label: t('즐겨찾기'), short: '★' },
  { path: '/marketplaces', label: t('마켓플레이스'), short: t('마켓') },
  { path: '/settings', label: t('설정') },
];
const PATHS: Path[] = ['/', '/recommend', '/skill', '/installed', '/marketplaces', '/settings', '/favorites'];

function readRoute(): Route {
  const p = window.location.pathname as Path;
  const path = PATHS.includes(p) ? p : '/';
  const skillId = path === '/skill' ? new URLSearchParams(window.location.search).get('id') : null;
  return path === '/skill' && !skillId ? { path: '/', skillId: null } : { path, skillId };
}

/** Where in a search a skill page opened in a new tab came from (ResultCard skillHref puts it in the link). */
function fromQuery(): OpenedFrom | undefined {
  const q = new URLSearchParams(window.location.search);
  const sid = q.get('sid');
  if (!sid) return undefined;
  return { sid, pos: Number(q.get('pos')) || 0, page: Number(q.get('page')) || 0, provisional: q.get('prov') === '1' };
}

const BACK_LABEL: Partial<Record<Path, string>> = { '/': t('검색 결과로'), '/recommend': t('README 추천으로'), '/installed': t('설치됨으로'), '/marketplaces': t('마켓플레이스로'), '/settings': t('설정으로'), '/favorites': t('즐겨찾기로') };

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  // Result cards carry the per-search score (R, P); the skill page shows it when opened from a result.
  const [opened, setOpened] = useState<Map<string, ResultItem>>(new Map());
  const [lastQuery, setLastQuery] = useState('');
  // A newer release on the download page (installed app only): said in the menu bar on every screen, not only
  // before the first search (project review 2026-11-02). The server looks every 6 hours; this asks it every 30 min.
  const [update, setUpdate] = useState<Health['update']>(null);
  useEffect(() => {
    const check = () =>
      apiGet<Health>('/health')
        .then((h) => setUpdate(h.update))
        .catch(() => {});
    check();
    const timer = setInterval(check, 30 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((path: Path, skillId: string | null = null) => {
    const url = skillId ? `${path}?id=${encodeURIComponent(skillId)}` : path === '/' ? searchUrl() : path;
    window.history.pushState(null, '', url);
    setRoute({ path, skillId });
    window.scrollTo(0, 0);
  }, []);

  // Each screen gets its own tab title, and moving between screens puts the keyboard focus on the new screen's
  // heading; coming back to a list puts it on the card that was opened (UI debate 2-10).
  const lastOpened = useRef<string | null>(null);
  const firstRoute = useRef(true);
  useEffect(() => {
    const label = NAV.find((n) => n.path === route.path)?.label;
    if (route.path !== '/skill') document.title = route.path === '/' || !label ? 'Skill Finder' : `${label} · Skill Finder`;
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    // after the new screen has rendered (a timer, not a frame: frames pause in a background tab)
    const timer = setTimeout(() => {
      const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;
      const card =
        (route.path === '/' || route.path === '/recommend') && lastOpened.current
          ? [...document.querySelectorAll<HTMLElement>('main a.card-link')].find((a) => visible(a) && a.dataset.id === lastOpened.current)
          : undefined;
      const heading = [...document.querySelectorAll<HTMLElement>('main h1')].find(visible);
      const target = card ?? heading;
      if (!target) return;
      if (target === heading) target.tabIndex = -1;
      target.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [route]);

  // and where in its search it was, for the local search log
  // A skill page opened in a new tab from a result carries where it was in the search (skillHref); it is read once
  // and taken out of the address, so a reload or a copied link does not log the view again.
  const [openedFrom, setOpenedFrom] = useState<Map<string, OpenedFrom>>(() => {
    const from = fromQuery();
    const { skillId } = readRoute();
    if (!from || !skillId) return new Map();
    window.history.replaceState(null, '', `/skill?id=${encodeURIComponent(skillId)}`);
    return new Map([[skillId, from]]);
  });
  const openSkill = useCallback(
    (item: ResultItem, from?: OpenedFrom) => {
      lastOpened.current = item.id;
      setOpened((m) => new Map(m).set(item.id, item));
      setOpenedFrom((m) => {
        const next = new Map(m);
        if (from) next.set(item.id, from);
        else next.delete(item.id);
        return next;
      });
      go('/skill', item.id);
    },
    [go],
  );

  // The skill page belongs to whichever screen it was opened from (search, README, installed, ...): the menu shows
  // that screen and the back button names it (project review 2026-11-02).
  const [listPath, setListPath] = useState<Path>('/');
  useEffect(() => {
    if (route.path !== '/skill') setListPath(route.path);
  }, [route.path]);
  const navActive = route.path === '/skill' ? listPath : route.path;

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            go('/');
          }}
        >
          <span className="brand-mark" aria-hidden>
            &gt;_
          </span>
          skill-finder
          <span className="caret" aria-hidden />
        </a>
        <nav>
          {NAV.map((r) => (
            <a
              key={r.path}
              href={r.path}
              className={navActive === r.path ? 'active' : ''}
              aria-current={navActive === r.path ? 'page' : undefined}
              // narrow screens hide the long label; the link keeps its full name for screen readers
              aria-label={r.short ? r.label : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(r.path);
              }}
            >
              {r.short ? (
                <>
                  <span className="nav-long">{r.label}</span>
                  <span className="nav-short" aria-hidden="true">
                    {r.short}
                  </span>
                </>
              ) : (
                r.label
              )}
            </a>
          ))}
        </nav>
        {update && (
          // the version's change notes, when they are signed (the server drops unsigned ones)
          <details className="update-badge" role="status">
            <summary title={t('검은 Skill Finder 창을 닫았다가 바탕화면의 Skill Finder로 다시 켜면 자동으로 업데이트됩니다.')}>{t('새 버전 {0} · 다시 켜면 업데이트', update.version)}</summary>
            <div className="update-notes">
              {update.notes?.length ? (
                <ul>
                  {update.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">{t('변경 기록이 없습니다.')}</p>
              )}
              <p className="muted small">{t('검은 Skill Finder 창을 닫았다가 바탕화면의 Skill Finder로 다시 켜면 서명을 확인한 뒤 업데이트됩니다.')}</p>
            </div>
          </details>
        )}
      </header>
      <main>
        {/* Search stays mounted so results survive opening a skill or visiting other pages. */}
        <div hidden={route.path !== '/'}>
          <SearchPage onOpen={openSkill} onQuery={setLastQuery} />
        </div>
        <div hidden={route.path !== '/recommend'}>
          <RecommendPage onOpen={openSkill} />
        </div>
        {route.path === '/skill' && route.skillId && (
          <SkillPage
            key={route.skillId}
            id={route.skillId}
            item={opened.get(route.skillId) ?? null}
            query={lastQuery}
            from={openedFrom.get(route.skillId)}
            backLabel={BACK_LABEL[listPath] ?? t('뒤로')}
            onOpenSkill={(sid) => go('/skill', sid)}
            onBack={() => (window.history.length > 1 ? window.history.back() : go(listPath))}
          />
        )}
        {route.path === '/installed' && <InstalledPage onOpenSkill={(id) => go('/skill', id)} />}
        {route.path === '/marketplaces' && <MarketplacesPage />}
        {route.path === '/settings' && <SettingsPage />}
        {route.path === '/favorites' && <FavoritesPage onOpen={openSkill} />}
      </main>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { InstalledPage } from './pages/InstalledPage.tsx';
import { MarketplacesPage } from './pages/MarketplacesPage.tsx';
import { RecommendPage } from './pages/RecommendPage.tsx';
import { SearchPage } from './pages/SearchPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { SkillPage } from './pages/SkillPage.tsx';
import type { ResultItem } from './types.ts';

type Path = '/' | '/recommend' | '/skill' | '/installed' | '/marketplaces' | '/settings';
type Route = { path: Path; skillId: string | null };

const NAV: Array<{ path: Path; label: string }> = [
  { path: '/', label: '검색' },
  { path: '/recommend', label: 'README 추천' },
  { path: '/installed', label: '설치됨' },
  { path: '/marketplaces', label: '마켓플레이스' },
  { path: '/settings', label: '설정' },
];
const PATHS: Path[] = ['/', '/recommend', '/skill', '/installed', '/marketplaces', '/settings'];

function readRoute(): Route {
  const p = window.location.pathname as Path;
  const path = PATHS.includes(p) ? p : '/';
  const skillId = path === '/skill' ? new URLSearchParams(window.location.search).get('id') : null;
  return path === '/skill' && !skillId ? { path: '/', skillId: null } : { path, skillId };
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  // Result cards carry the per-search score (R, P); the skill page shows it when opened from a result.
  const [opened, setOpened] = useState<Map<string, ResultItem>>(new Map());
  const [lastQuery, setLastQuery] = useState('');

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((path: Path, skillId: string | null = null) => {
    const url = skillId ? `${path}?id=${encodeURIComponent(skillId)}` : path;
    window.history.pushState(null, '', url);
    setRoute({ path, skillId });
    window.scrollTo(0, 0);
  }, []);

  const openSkill = useCallback(
    (item: ResultItem) => {
      setOpened((m) => new Map(m).set(item.id, item));
      go('/skill', item.id);
    },
    [go],
  );

  // The skill page belongs to whichever list it was opened from.
  const [listPath, setListPath] = useState<Path>('/');
  useEffect(() => {
    if (route.path === '/' || route.path === '/recommend') setListPath(route.path);
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
              onClick={(e) => {
                e.preventDefault();
                go(r.path);
              }}
            >
              {r.label}
            </a>
          ))}
        </nav>
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
            onBack={() => (window.history.length > 1 ? window.history.back() : go('/'))}
          />
        )}
        {route.path === '/installed' && <InstalledPage />}
        {route.path === '/marketplaces' && <MarketplacesPage />}
        {route.path === '/settings' && <SettingsPage />}
      </main>
    </div>
  );
}

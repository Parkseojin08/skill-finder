import { Icon } from '../components/Icon.tsx';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiGet, streamNdjson } from '../api.ts';
import { ActiveFacets, FacetPanel, facetCount, matchFacets, NO_FACETS, type Facets } from '../components/FacetPanel.tsx';
import { RepoCard } from '../components/RepoCard.tsx';
import { NoResults } from '../components/search/NoResults.tsx';
import { SearchIntro } from '../components/search/SearchIntro.tsx';
import { ResultCard, skillHref } from '../components/ResultCard.tsx';
import { TranslationNotice } from '../components/TranslationNotice.tsx';
import { useInstalled } from '../installed.ts';
import { CATEGORY, jobLine, METHOD, RISK_RANK, STAGES, TRUST } from '../labels.ts';
import { fileStem, resultsJson, resultsMarkdown, saveFile } from '../lib/exportList.ts';
import { goInApp } from '../lib/links.ts';
import { readPageSize, savePageSize } from '../lib/prefs.ts';
import { byPopular, foldResults, nameMatches, navigationalWord, repoMainSkill, SORTS, type SortKey } from '../lib/resultOrder.ts';
import type { Health, Job, OpenedFrom, ResultItem, RiskLevel, SearchEvent, SearchSource, SettingsResponse, SourceKind, SourceProgress } from '../types.ts';


/** Below this many indexed skills the index is probably still being built (first run). */
const FEW_SKILLS = 1000;
const EXAMPLES = ['pull request review', 'extract tables from pdf', 'react performance', 'postgres migration review', 'commit message'];
const SOURCE_LABEL: Record<SourceKind, string> = { marketplace: '마켓플레이스', skillssh: 'skills.sh', github: 'GitHub' };
const PROGRESS_LABEL: Record<SearchSource, string> = { local: '내 PC 색인', skillssh: 'skills.sh', github: 'GitHub 코드', repos: '같은 이름 저장소' };

/** Where each source is while a search runs: "내 PC 색인 120개 0.2초 · skills.sh 확인 중 · …", plus the elapsed time. */
function SourceProgressLine({ progress, startedAt }: { progress: Partial<Record<SearchSource, SourceProgress>>; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const shown = (Object.keys(PROGRESS_LABEL) as SearchSource[]).filter((s) => progress[s] && progress[s].state !== 'skipped');
  const text = (p: SourceProgress) =>
    p.state === 'running' ? '확인 중' : p.state === 'done' ? `${p.count ?? 0}개 · ${((p.ms ?? 0) / 1000).toFixed(1)}초` : p.state === 'timeout' ? '시간 초과' : '실패';
  return (
    <p className="source-progress muted small" aria-live="off">
      <span className="mono">{((now - startedAt) / 1000).toFixed(1)}초</span>
      {shown.map((s) => (
        <span key={s} className={progress[s]!.state === 'running' ? 'pending' : progress[s]!.state === 'done' ? undefined : 'warn-text'}>
          {PROGRESS_LABEL[s]} {text(progress[s]!)}
        </span>
      ))}
    </p>
  );
}

type Status = 'idle' | 'running' | 'done' | 'error';

/** The last finished search in this tab (sessionStorage), so a reload of `/?q=…` needs no new search. */
const SNAPSHOT_KEY = 'skill-finder-last-search';

const SEARCH_LOG_EVENT = 'skill-finder-search-log';
/**
 * The settings page saved the search-log switch. Off: the last query leaves this tab's storage and the address
 * too, as a search made with the log off never puts it there.
 */
export function searchLogChanged(on: boolean): void {
  if (!on) {
    lastSearchAddress = null;
    try {
      sessionStorage.removeItem(SNAPSHOT_KEY);
    } catch {
      // nothing stored
    }
  }
  window.dispatchEvent(new CustomEvent(SEARCH_LOG_EVENT, { detail: on }));
}

/** The address the search page last wrote (query, sort, page, filters), for coming back through the menu. */
let lastSearchAddress: string | null = null;

/** Side filters as an address value ("trust.official,category.pdf") and back. */
const facetParam = (f: Facets) => (Object.keys(f) as Array<keyof Facets>).flatMap((g) => f[g].map((k) => `${g}.${k}`)).join(',');
function parseFacets(v: string): Facets {
  const out: Facets = { trust: [], category: [], method: [] };
  for (const part of v.split(',')) {
    const [g, k] = part.split('.');
    // only known values: a hand-edited address must not break the page
    const known = Object.hasOwn(g === 'trust' ? TRUST : g === 'method' ? METHOD : g === 'category' ? CATEGORY : {}, k);
    if (k && known && !out[g as keyof Facets].includes(k)) out[g as keyof Facets].push(k);
  }
  return out;
}

/** The search page's address with the last query, for the "검색" menu (so the query stays in the address). */
export function searchUrl(): string {
  if (lastSearchAddress) return lastSearchAddress;
  try {
    const q = (JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY) ?? 'null') as { q?: string } | null)?.q;
    return q ? `/?q=${encodeURIComponent(q)}` : '/';
  } catch {
    return '/';
  }
}
type Snapshot = {
  q: string;
  risk: RiskLevel;
  sources: SourceKind[];
  items: ResultItem[];
  final: Extract<SearchEvent, { type: 'results' }>;
  doneInfo: { cached: boolean; elapsedMs: number } | null;
  sid?: string;
  liftedStars: number | null;
};

export function SearchPage({ onOpen, onQuery }: { onOpen: (item: ResultItem, from?: OpenedFrom) => void; onQuery: (q: string) => void }) {
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<SourceKind[]>(['marketplace', 'skillssh', 'github']);
  const [maxRisk, setMaxRisk] = useState<RiskLevel>('medium');
  const [status, setStatus] = useState<Status>('idle');
  const [stage, setStage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Array<{ source: string; message: string; severity?: 'urgent' | 'note' }>>([]);
  const [items, setItems] = useState<ResultItem[]>([]);
  const [provisional, setProvisional] = useState(false);
  const [final, setFinal] = useState<Extract<SearchEvent, { type: 'results' }> | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ cached: boolean; elapsedMs: number } | null>(null);
  /** This search in the local search log; the cards opened from it point back to it. */
  const [sid, setSid] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<Partial<Record<SearchSource, SourceProgress>>>({});
  /** The star minimum this search was run without ("보기"), for the badge on cards below it; null normally. */
  const [liftedStars, setLiftedStars] = useState<number | null>(null);
  /** Results before "별 기준 없이 다시 찾기", to say how many the lifted search added (review 2026-11-02). */
  const beforeLift = useRef<Set<string> | null>(null);
  /** English query offered for a Korean one (the server sends it first, before any results). */
  const [suggest, setSuggest] = useState<{ query: string; dropped: string[] } | null>(null);
  const [openRepos, setOpenRepos] = useState<Set<string>>(() => new Set());
  const [openNames, setOpenNames] = useState<Set<string>>(() => new Set());
  const [startedAt, setStartedAt] = useState(0);
  const [githubToken, setGithubToken] = useState<boolean | null>(null);
  /** The last search was stopped by hand: "nothing found" would not be true then. */
  const [stopped, setStopped] = useState(false);
  /** Whether the search log is on; when off the query is not put in the address either. */
  const [logOn, setLogOn] = useState(true);
  useEffect(() => {
    const on = (e: Event) => setLogOn((e as CustomEvent<boolean>).detail);
    window.addEventListener(SEARCH_LOG_EVENT, on);
    return () => window.removeEventListener(SEARCH_LOG_EVENT, on);
  }, []);
  /** The conditions the shown results were searched with (the controls may change after), for the snapshot. */
  const searchedWith = useRef<{ risk: RiskLevel; sources: SourceKind[] }>({ risk: 'medium', sources: [] });
  /** The same, for rendering: the controls above can differ from what the results on screen were searched with. */
  const [searched, setSearched] = useState<{ risk: RiskLevel; sources: SourceKind[] }>({ risk: 'medium', sources: [] });
  const [health, setHealth] = useState<Health | null>(null);
  const [syncJob, setSyncJob] = useState<Job | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('popular');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Sidebar filters narrow the current results in the browser; they stay set across searches.
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const installedAs = useInstalled();
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const noticesRef = useRef<HTMLDetailsElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Settings and running jobs are read again whenever the search page comes back into view (it stays mounted while
  // hidden): a token added in the settings, or a collection started on the marketplace screen, used to go unseen
  // until a reload (review 2026-11-02).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const readSettings = () =>
      apiGet<SettingsResponse>('/settings')
        .then((s) => {
          setGithubToken(s.githubToken);
          setLogOn(s.settings.searchLog);
        })
        .catch(() => {});
    const poll = async () => {
      try {
        const [h, j] = await Promise.all([apiGet<Health>('/health'), apiGet<{ jobs: Job[] }>('/jobs')]);
        setHealth(h);
        // the popular-repo collection runs on after the sync (about a minute on a first run); show it too
        const active = j.jobs.filter((x) => x.status === 'running' || x.status === 'paused');
        const running = active.find((x) => x.kind === 'sync') ?? active.find((x) => x.kind === 'collect') ?? null;
        setSyncJob(running);
        if (running) timer = setTimeout(poll, 3000);
      } catch {
        timer = setTimeout(poll, 5000);
      }
    };
    const refresh = () => {
      clearTimeout(timer);
      void readSettings();
      void poll();
    };
    // once at start (an observer does not fire while the tab is not drawn), then on each return into view
    refresh();
    let seen = true;
    const watch = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting && !seen) refresh();
      seen = !!e?.isIntersecting;
    });
    // the whole page, not the search box: scrolling the results down must not count as leaving
    const page = inputRef.current?.closest('.search-page');
    if (page) watch.observe(page);
    return () => {
      clearTimeout(timer);
      watch.disconnect();
    };
  }, []);

  // "/" jumps to the search box, j / k move between result cards, "?" lists these (unless typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const textInput = el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type);
      const typing = el && (textInput || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (inputRef.current?.offsetParent === null) return; // search page hidden
      if (document.querySelector('dialog[open], [role="dialog"]')) return; // a dialog has the keyboard
      // with the Korean layout on, j and k arrive as ㅓ and ㅏ: the key's place decides (review 2026-11-02)
      const key = ['/', '?', 'j', 'k'].includes(e.key) ? e.key : ({ KeyJ: 'j', KeyK: 'k' } as Record<string, string>)[e.code] ?? e.key;
      if (e.key === 'Escape') {
        stopRef.current();
      } else if (key === '/') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (key === 'j' || key === 'k') {
        const links = [...(resultsRef.current?.parentElement?.querySelectorAll<HTMLElement>('.results a.card-link') ?? [])];
        if (links.length === 0) return;
        e.preventDefault();
        const at = links.indexOf(document.activeElement as HTMLElement);
        const next = at < 0 ? 0 : Math.min(links.length - 1, Math.max(0, at + (key === 'j' ? 1 : -1)));
        links[next].focus();
        links[next].scrollIntoView({ block: 'nearest' });
      } else if (key === '?') {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The "알림" popover closes on Esc or a click elsewhere, like a menu.
  useEffect(() => {
    const close = (e: Event) => {
      const d = noticesRef.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) d.open = false;
    };
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
    };
  }, []);

  const run = useCallback(
    /** `liftStars`: search once without this star minimum (the setting itself stays). */
    async (q: string, risk = maxRisk, liftStars: number | null = null, useSources = sources) => {
      const text = q.trim();
      if (!text) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setStatus('running');
      setStopped(false);
      setStage(null);
      setWarnings([]);
      setItems([]);
      setPage(1);
      setFinal(null);
      setDoneInfo(null);
      setSid(undefined);
      setProgress({});
      setStartedAt(Date.now());
      setLiftedStars(liftStars);
      setSuggest(null);
      setOpenRepos(new Set());
      setOpenNames(new Set());
      setProvisional(false);
      setLastQuery(text);
      onQuery(text);
      searchedWith.current = { risk, sources: useSources };
      setSearched({ risk, sources: useSources });
      // the query goes in the address (UI debate 2-3) without adding a history entry per search
      if (window.location.pathname === '/') window.history.replaceState(null, '', logOn ? `/?q=${encodeURIComponent(text)}` : '/');
      try {
        await streamNdjson<SearchEvent>(
          '/search',
          { query: text, filters: { sources: useSources, maxRisk: risk, ...(liftStars != null ? { minStars: 0 } : {}) } },
          (e) => {
            if (ac.signal.aborted) return;
            switch (e.type) {
              case 'stage':
                setStage(e.stage);
                break;
              case 'suggest':
                setSuggest({ query: e.query, dropped: e.dropped ?? [] });
                break;
              case 'source':
                setProgress((p) => ({ ...p, [e.source]: { state: e.state, count: e.count, ms: e.ms } }));
                break;
              case 'warning':
                setWarnings((w) => [...w, { source: e.source, message: e.message, severity: e.severity }]);
                break;
              case 'candidates':
                setItems(e.items);
                setProvisional(true);
                break;
              case 'results':
                setItems(e.items);
                setProvisional(false);
                setFinal(e);
                break;
              case 'done':
                setDoneInfo({ cached: e.cached, elapsedMs: e.elapsedMs });
                setSid(e.sid);
                setStatus('done');
                break;
            }
          },
          ac.signal,
        );
        setStatus((s) => (s === 'running' ? 'done' : s));
      } catch (err) {
        if (ac.signal.aborted) return;
        setWarnings((w) => [...w, { source: 'client', message: String((err as Error).message ?? err), severity: 'urgent' }]);
        setStatus('error');
      }
    },
    [sources, maxRisk, onQuery, logOn],
  );

  // A reload in this tab shows the last results again instead of searching (and logging) once more.
  useEffect(() => {
    if (status !== 'done' || !final || !logOn) return;
    const snap: Snapshot = { q: lastQuery, ...searchedWith.current, items, final, doneInfo, sid, liftedStars };
    try {
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    } catch {
      // storage full or blocked: a reload searches again
    }
  }, [status, final, items, doneInfo, sid, lastQuery, liftedStars, logOn]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')?.trim();
    if (window.location.pathname !== '/' || !q) return;
    let snap: Snapshot | null = null;
    try {
      snap = JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY) ?? 'null') as Snapshot | null;
    } catch {
      snap = null;
    }
    setQuery(q);
    const params = new URLSearchParams(window.location.search);
    const sortParam = params.get('sort');
    if (SORTS.some((s) => s.key === sortParam)) setSort(sortParam as SortKey);
    if (params.get('f')) setFacets(parseFacets(params.get('f')!));
    if (snap?.q !== q) {
      void run(q);
      return;
    }
    if (Number(params.get('page')) > 1) setPage(Number(params.get('page')));
    setLastQuery(q);
    onQuery(q);
    setMaxRisk(snap.risk);
    setSources(snap.sources);
    searchedWith.current = { risk: snap.risk, sources: snap.sources };
    setSearched({ risk: snap.risk, sources: snap.sources });
    setItems(snap.items);
    setFinal(snap.final);
    setDoneInfo(snap.doneInfo);
    setSid(snap.sid);
    setLiftedStars(snap.liftedStars);
    setStatus('done');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on load
  }, []);

  /** Stops a running search: what came so far stays on screen (the server still finishes and caches it). */
  const stopRef = useRef<() => void>(() => {});
  stopRef.current = () => {
    if (status !== 'running') return;
    abortRef.current?.abort();
    setProvisional(false);
    setStatus('done');
    setStopped(true);
    setWarnings((w) => [...w, { source: 'client', message: '검색을 중지했습니다. 지금까지 찾은 결과만 보입니다.', severity: 'note' }]);
  };

  const toggleSource = (s: SourceKind) => setSources((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  // the GitHub box stays ticked underneath while there is no token (it comes back with one), but searches nothing
  const usableSources = sources.filter((s) => !(s === 'github' && githubToken === false));
  // The risk limit above narrows what is on screen at once (project review 2026-11-02: "낮음만" still showed
  // "주의" cards until the next search); a wider limit or other sources need a new search, offered below.
  const riskOk = (it: ResultItem) => RISK_RANK[it.riskLevel] <= RISK_RANK[maxRisk];
  const riskHiddenNow = items.filter((it) => !riskOk(it)).length;
  const filtered = items.filter((it) => riskOk(it) && matchFacets(it, facets));
  const conditionsChanged =
    status === 'done' &&
    (RISK_RANK[maxRisk] > RISK_RANK[searched.risk] || sources.length !== searched.sources.length || sources.some((s) => !searched.sources.includes(s)));
  const compare = SORTS.find((s) => s.key === sort)!.compare;
  const word = navigationalWord(lastQuery);
  // Same rule as the server: an exact skill/repo name ("rea") is a lookup, so the skills of that name and that
  // repo's main skill (from all the results, not only the filtered ones) come first by default.
  // Among those name matches popularity alone decides, as on the server (no relevance tier).
  const main = word ? repoMainSkill(items, word) : null;
  const sorted = filtered.sort(
    sort === 'popular' && word
      ? (a, b) => {
          const na = nameMatches(a, word, main);
          const nb = nameMatches(b, word, main);
          return Number(nb) - Number(na) || (na ? byPopular(a, b) : compare(a, b));
        }
      : compare,
  );
  const filtering = facetCount(facets) > 0;
  const showFacets = status !== 'idle' && (items.length > 0 || filtering);
  const changeFacets = (f: Facets) => {
    setFacets(f);
    setPage(1);
  };
  const shown = foldResults(sorted, openRepos, openNames, word, main);
  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  // Sort, page and side filters ride along with the query in the address (only when the query does: the search
  // log on), so a reload or a copied address shows the same screen (review 2026-11-02).
  useEffect(() => {
    if (window.location.pathname !== '/' || !logOn || !lastQuery || status === 'running') return;
    const p = new URLSearchParams({ q: lastQuery });
    if (sort !== 'popular') p.set('sort', sort);
    if (currentPage > 1) p.set('page', String(currentPage));
    const f = facetParam(facets);
    if (f) p.set('f', f);
    const next = `/?${p}`;
    lastSearchAddress = next;
    if (window.location.pathname + window.location.search !== next) window.history.replaceState(window.history.state, '', next);
  }, [lastQuery, sort, currentPage, facets, logOn, status]);
  const pageItems = shown.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => {
    if (focusAt.current == null) return;
    const at = focusAt.current;
    focusAt.current = null;
    const links = resultsRef.current?.parentElement?.querySelectorAll<HTMLElement>('.results a.card-link');
    if (links?.length) links[Math.min(at, links.length - 1)].focus({ preventScroll: at === 0 });
  });
  const fromOf = (i: number): OpenedFrom => ({ sid, pos: (currentPage - 1) * pageSize + i + 1, page: currentPage, provisional });
  /** A result card (by its place on the page) that gets the focus once the page has drawn: the first of a new
   *  page, or the first card an "N개 더" opened (the button itself goes away; review 2026-11-02). */
  const focusAt = useRef<number | null>(null);
  const goPage = (p: number) => {
    const next = Math.min(Math.max(1, p), pageCount);
    if (next === currentPage) return; // no redraw would take the focus request, and a later one would
    setPage(next);
    focusAt.current = 0;
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Warnings that change what the results mean (failures, incomplete results) stay visible;
  // routine notes (no GitHub token, hidden description-less results) fold into the "알림" toggle.
  // the server says which is which; the page's own (connection errors) are urgent
  const isUrgent = (w: { severity?: 'urgent' | 'note' }) => w.severity !== 'note';
  // the Korean-query warning and the English suggestion say one thing: one strip, the warning sentence kept
  const koreanNote = suggest ? warnings.find((w) => w.source === 'query') : undefined;
  const urgent = warnings.filter((w) => isUrgent(w) && w !== koreanNote);
  const minor: Array<{ key: string; node: ReactNode }> = [
    ...warnings.filter((w) => !isUrgent(w)).map((w, i) => ({ key: `w${i}`, node: w.message })),
    ...(final && final.hiddenNoDescription > 0 ? [{ key: 'nodesc', node: `설명이 없어 판단할 수 없는 결과 ${final.hiddenNoDescription}개는 숨겼습니다.` }] : []),
    ...(final && (final.hiddenNoMatch ?? 0) > 0
      ? [{ key: 'nomatch', node: `검색어 단어가 이름·설명에 하나도 없는 결과 ${final.hiddenNoMatch}개는 숨겼습니다.` }]
      : []),
  ];
  // what the server left out under the limit the results were searched with (not the one picked since)
  const hiddenRisky = final && searched.risk !== 'high' ? final.hiddenHighRisk : 0;
  // "별 N개 미만 M개 숨김 · 보기" (user decision B): searches once without the minimum; the setting stays
  const hiddenLowStars = final && (final.minStars ?? 0) > 0 ? (final.hiddenLowStars ?? 0) : 0;
  const hiddenUnknownStars = final && (final.minStars ?? 0) > 0 ? (final.hiddenUnknownStars ?? 0) : 0;
  // the index or the repo star counts are still being gathered (first run): results are partial
  const gathering = !!syncJob || (health?.skills ?? 0) < FEW_SKILLS;

  return (
    <div className="page search-page">
      {/* headings for screen readers: the search screen had none to jump to (review 2026-11-02) */}
      <h1 className="sr-only">스킬 검색</h1>
      <div className="search-hero">
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            run(query);
          }}
        >
          <span className="prompt" aria-hidden="true">
            ❯
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="필요한 기능을 영어로 입력하세요"
            maxLength={300}
            aria-label="검색어"
            autoFocus
            // Esc leaves the box so j / k work; ↓ goes to the first result (review 2026-11-02: after a search the
            // focus stayed here and "j" was typed into the query)
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                stopRef.current();
                e.currentTarget.blur();
              } else if (e.key === 'ArrowDown') {
                const first = resultsRef.current?.parentElement?.querySelector<HTMLElement>('.results a.card-link');
                if (first) {
                  e.preventDefault();
                  first.focus();
                  first.scrollIntoView({ block: 'nearest' });
                }
              }
            }}
          />
          <button type="submit" className="primary" disabled={!query.trim() || usableSources.length === 0}>
            검색
          </button>
        </form>
        <div className="search-sub">
          <span className="muted small">
            영어로 검색하세요 · 예:{' '}
            <button
              type="button"
              className="linkish mono"
              onClick={() => {
                setQuery('extract tables from pdf');
                run('extract tables from pdf');
              }}
            >
              extract tables from pdf
            </button>
          </span>
          <span className="muted small kbd-hint">
            <kbd>/</kbd> 검색창으로 이동 · <kbd>?</kbd> 단축키
          </span>
        </div>
        {shortcutsOpen && (
          <p className="shortcut-help muted small" role="note">
            <kbd>/</kbd> 검색창 · <kbd>j</kbd> 다음 결과 · <kbd>k</kbd> 이전 결과 · <kbd>Enter</kbd> 열기 · <kbd>?</kbd> 이 안내 닫기
          </p>
        )}
        <div className="filters" role="group" aria-label="검색 조건">
          {(Object.keys(SOURCE_LABEL) as SourceKind[]).map((s) => (
            // GitHub here is its code search, which needs a token: without one the box did nothing either way
            <label key={s} className="chip" title={s === 'github' && githubToken === false ? '설정에서 GitHub 토큰을 넣으면 사용됩니다' : undefined}>
              <input
                type="checkbox"
                checked={sources.includes(s) && !(s === 'github' && githubToken === false)}
                disabled={s === 'github' && githubToken === false}
                onChange={() => toggleSource(s)}
              />
              {SOURCE_LABEL[s]}
              {s === 'github' && githubToken === false && (
                <a className="muted small" href="/settings" onClick={(e) => goInApp(e, '/settings')}>
                  (토큰 넣기)
                </a>
              )}
            </label>
          ))}
          <label className="select-inline">
            <span className="muted small">위험</span>
            <select value={maxRisk} onChange={(e) => setMaxRisk(e.target.value as RiskLevel)} aria-label="최대 위험 등급">
              <option value="low">낮음만</option>
              <option value="medium">주의까지</option>
              <option value="high">모두</option>
            </select>
          </label>
        </div>
      </div>

      <div role="status">
        {syncJob && (
          <p className="status-line muted small">
            <span className="spinner" aria-hidden="true" /> {jobLine(syncJob)} · 색인 스킬 {(health?.skills ?? 0).toLocaleString()}개
          </p>
        )}
      </div>

      {status === 'idle' && (
        <SearchIntro
          examples={EXAMPLES}
          onExample={(ex) => {
            setQuery(ex);
            run(ex);
          }}
          health={health}
          githubToken={githubToken}
        />
      )}

      <div className={showFacets ? 'results-layout' : undefined}>
        {showFacets && <FacetPanel items={items.filter(riskOk)} value={facets} onChange={changeFacets} />}
        <div className="results-main">
          {status !== 'idle' && (
            <div className="results-toolbar" ref={resultsRef}>
              <div className="toolbar-left" aria-live="polite">
                {status === 'running' && final ? (
                  // results are in; a few slow lookups (huge repos) are still being folded in
                  <span className="status-line">
                    <span>
                      <b>{shown.length}</b>개 결과
                    </span>
                    <span className="muted small status-line">
                      <span className="spinner" aria-hidden="true" /> 나머지 후보 확인 중
                    </span>
                    <button type="button" className="linkish small" onClick={() => stopRef.current()} title="Esc">
                      중지
                    </button>
                  </span>
                ) : status === 'running' ? (
                  <span className="status-line">
                    <span className="spinner" aria-hidden="true" /> {stage ? STAGES[stage] : '검색'} 중…{' '}
                    <button type="button" className="linkish small" onClick={() => stopRef.current()} title="Esc">
                      중지
                    </button>
                  </span>
                ) : status === 'error' ? (
                  <span className="warn-text">
                    검색 실패{' '}
                    <button type="button" className="linkish small" onClick={() => run(lastQuery, maxRisk, liftedStars)}>
                      다시 시도
                    </button>
                  </span>
                ) : (
                  // one count, the same as the pager's: cards shown; folded copies and filtered-out ones are noted
                  <span>
                    <b>{shown.length}</b>개 결과
                    {sorted.length > shown.length && <span className="muted small"> · {sorted.length - shown.length}개 접힘</span>}
                    {filtering && <span className="muted small"> · 필터로 {items.length - riskHiddenNow - sorted.length}개 뺌</span>}
                    {riskHiddenNow > 0 && <span className="muted small"> · 위험 조건으로 {riskHiddenNow}개 뺌</span>}
                    {doneInfo && <span className="muted small"> · {doneInfo.cached ? '저장된 결과' : `${(doneInfo.elapsedMs / 1000).toFixed(1)}초`}</span>}
                  </span>
                )}
                <ActiveFacets value={facets} onChange={changeFacets} />
                {hiddenRisky > 0 && (
                  <button
                    type="button"
                    className="status-chip action"
                    title="위험 등급 필터를 '모두'로 바꿔 다시 검색합니다"
                    onClick={() => {
                      setMaxRisk('high');
                      run(lastQuery, 'high', liftedStars);
                    }}
                  >
                    위험 높음 {hiddenRisky}개 숨김 · 보기
                  </button>
                )}
                {status === 'done' && hiddenLowStars + hiddenUnknownStars > 0 && (
                  <button
                    type="button"
                    className="status-chip action"
                    title={`${[hiddenLowStars ? `별 ${final!.minStars!.toLocaleString()} 미만 ${hiddenLowStars}개` : '', hiddenUnknownStars ? `별 수 모름 ${hiddenUnknownStars}개` : ''].filter(Boolean).join(' · ')}를 숨겼습니다. 이번 검색만 별 기준 없이 다시 찾습니다(설정은 그대로). 같은 이름 사본은 접히고 결과는 50개까지라, 숨긴 수만큼 늘지는 않습니다.`}
                    onClick={() => {
                      beforeLift.current = new Set(shown.map((r) => r.item.id));
                      run(lastQuery, maxRisk, final!.minStars!);
                    }}
                  >
                    별 기준 없이 다시 찾기 (숨긴 후보 {hiddenLowStars + hiddenUnknownStars}개)
                  </button>
                )}
                {conditionsChanged && (
                  <button type="button" className="status-chip action" title="위쪽 조건이 이 결과를 찾을 때와 다릅니다" onClick={() => run(lastQuery, maxRisk, liftedStars)}>
                    조건이 바뀌었습니다 · 다시 검색
                  </button>
                )}
                {status === 'done' && liftedStars != null && (
                  <button type="button" className="status-chip action" title="설정한 최소 스타 수로 다시 검색합니다" onClick={() => run(lastQuery)}>
                    별 제한 없이 보는 중
                    {beforeLift.current && ` · 새로 보인 결과 ${shown.filter((r) => !beforeLift.current!.has(r.item.id)).length}개`} · 되돌리기
                  </button>
                )}
                {minor.length > 0 && (
                  <details className="notices" ref={noticesRef}>
                    <summary>
                      <Icon name="info" size={14} /> 알림 {minor.length}
                    </summary>
                    <ul>
                      {minor.map((m) => (
                        <li key={m.key}>{m.node}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              <div className="toolbar-right">
                <TranslationNotice compact />
                {status === 'done' && shown.length > 0 && (
                  // the results as shown (order, filters), all pages, saved in the browser only
                  <details className="export-menu">
                    <summary className="status-chip action">내보내기</summary>
                    <div className="export-items">
                      <button type="button" className="ghost" onClick={() => saveFile(`skill-finder-${fileStem(lastQuery)}.json`, resultsJson(lastQuery, shown.map((r) => r.item)), 'application/json')}>
                        JSON으로 저장
                      </button>
                      <button type="button" className="ghost" onClick={() => saveFile(`skill-finder-${fileStem(lastQuery)}.md`, resultsMarkdown(lastQuery, shown.map((r) => r.item)), 'text/markdown')}>
                        Markdown으로 저장
                      </button>
                      <p className="muted small">보이는 순서·필터 그대로 모든 쪽을 저장합니다. 접힌 같은 이름 결과는 펼친 것만 들어갑니다.</p>
                    </div>
                  </details>
                )}
                {items.length > 0 && (
                  <>
                    <select
                      value={sort}
                      onChange={(e) => {
                        setSort(e.target.value as SortKey);
                        setPage(1);
                      }}
                      aria-label="정렬 기준"
                      title={sort === 'popular' || sort === 'stars' ? '다운로드 수·스타 수를 모르는 스킬은 뒤로 보냅니다' : undefined}
                    >
                      {SORTS.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value));
                        setPage(1);
                        savePageSize(Number(e.target.value));
                      }}
                      aria-label="페이지당 개수"
                    >
                      {[5, 10, 20].map((n) => (
                        <option key={n} value={n}>
                          {n}개씩
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </div>
          )}

          {status === 'running' && Object.keys(progress).length > 0 && <SourceProgressLine progress={progress} startedAt={startedAt} />}

          <div role="status">
            {urgent.map((w, i) => (
              <div key={i} className="warn-strip">
                <Icon name="alert" size={15} /> <span>{w.message}</span>
              </div>
            ))}
            {final?.broadQuery && (
              <div className="warn-strip">
                <Icon name="info" size={15} />{' '}
                <span>
                  <span className="mono">{lastQuery}</span>은(는) 너무 일반적인 단어라 결과가 넓어요. 하려는 일을 함께 적어 보세요 (예: create a new skill).
                </span>
              </div>
            )}
            {suggest && (
              // user decision E: offered, never applied by itself (the query stays as typed)
              <div className="warn-strip">
                <Icon name="info" size={15} />{' '}
                <span>
                  {koreanNote ? '스킬 설명이 대부분 영어라 한국어 검색어는 결과가 적거나 부정확합니다. ' : ''}영어로 찾으면 결과가 더 많아요
                  {suggest.dropped.length > 0 && <span className="muted"> (번역 못 한 단어: {suggest.dropped.join(', ')})</span>}.
                </span>
                <button
                  type="button"
                  className="status-chip action"
                  onClick={() => {
                    setQuery(suggest.query);
                    run(suggest.query);
                  }}
                >
                  <span className="mono">{suggest.query}</span>로 찾기
                </button>
              </div>
            )}
          </div>

          {provisional && items.length > 0 && <p className="muted small">임시 결과입니다. 후보 확인이 끝나면 갱신됩니다.</p>}

          {currentPage === 1 && (final?.repos?.length ?? 0) > 0 && (
            <div className="repo-results" aria-label="이름이 같은 GitHub 저장소">
              {final!.repos!.map((r) => (
                <RepoCard
                  key={r.repo}
                  // the risk limit above applies to a repo's skills (and what its 설치 button installs) too
                  repo={{ ...r, skills: r.skills.filter((s) => RISK_RANK[s.riskLevel] <= RISK_RANK[maxRisk]) }}
                  onOpenSkill={(id) => {
                    const item = items.find((x) => x.id === id);
                    if (item) onOpen(item);
                  }}
                />
              ))}
            </div>
          )}

          {items.length > 0 && <h2 className="sr-only">검색 결과</h2>}
          <div className="results">
            {pageItems.map(({ item: it, more, same, copyOf }, i) => (
              <Fragment key={it.id}>
                <div className={copyOf ? 'copy-row' : undefined}>
                  <ResultCard
                    item={it}
                    position={i}
                    provisional={provisional}
                    belowMinStars={liftedStars != null && (it.stars ?? 0) < liftedStars ? liftedStars : undefined}
                    href={skillHref(it.id, fromOf(i))}
                    installed={installedAs(it)}
                    onSelect={() => onOpen(it, fromOf(i))}
                  />
                </div>
                {copyOf?.last && (
                  <button
                    type="button"
                    className="linkish small fold-more"
                    onClick={() =>
                      setOpenNames((s) => {
                        const next = new Set(s);
                        next.delete(copyOf.key);
                        return next;
                      })
                    }
                  >
                    같은 이름 <span className="mono">{it.name}</span> 접기
                  </button>
                )}
                {same && (
                  <button
                    type="button"
                    className="linkish small fold-more"
                    onClick={() => {
                      focusAt.current = i + 1;
                      setOpenNames((s) => new Set(s).add(same.key));
                    }}
                  >
                    같은 이름 <span className="mono">{it.name}</span> {same.count}개 더 보기
                    {same.riskier && <span className="warn-text"> · 위험 주의 포함</span>}
                  </button>
                )}
                {more && (
                  <button
                    type="button"
                    className="linkish small fold-more"
                    onClick={() => {
                      focusAt.current = i + 1;
                      setOpenRepos((s) => new Set(s).add(more.repo));
                    }}
                  >
                    <span className="mono">{more.repo}</span>에서 {more.count}개 더 보기
                  </button>
                )}
              </Fragment>
            ))}
            {status === 'done' && items.length === 0 && stopped && (
              <p className="empty">
                검색을 중지했습니다. 그때까지 찾은 결과가 없습니다.{' '}
                <button type="button" className="linkish" onClick={() => run(lastQuery)}>
                  다시 찾기
                </button>
              </p>
            )}
            {status === 'done' && items.length === 0 && !stopped && (
              <NoResults
                hiddenUnknownStars={hiddenUnknownStars}
                hiddenLowStars={hiddenLowStars}
                gathering={gathering}
                hasToken={!!health?.githubToken}
                sourcesOff={3 - sources.length}
                maxRisk={maxRisk}
                minStars={final?.minStars ?? 0}
                riskHidden={final?.hiddenHighRisk ?? 0}
                starsHidden={hiddenLowStars + hiddenUnknownStars}
                onAllSources={() => {
                  const all: SourceKind[] = ['marketplace', 'skillssh', 'github'];
                  setSources(all);
                  run(lastQuery, maxRisk, liftedStars, all);
                }}
                onAllRisk={() => {
                  setMaxRisk('high');
                  run(lastQuery, 'high', liftedStars);
                }}
                onLiftStars={() => run(lastQuery, maxRisk, final!.minStars!)}
              />
            )}
            {items.length > 0 && sorted.length === 0 && (
              <p className="empty">
                {riskHiddenNow > 0 ? '지금 위험 조건과 필터에 맞는 결과가 없습니다.' : '선택한 필터에 맞는 결과가 없습니다.'}{' '}
                {riskHiddenNow > 0 && (
                  <button type="button" className="linkish" onClick={() => setMaxRisk(searched.risk)}>
                    위험 조건 되돌리기
                  </button>
                )}
                {riskHiddenNow > 0 && filtering && ' · '}
                {(filtering || riskHiddenNow === 0) && (
                  <button type="button" className="linkish" onClick={() => changeFacets(NO_FACETS)}>
                    필터 초기화
                  </button>
                )}
              </p>
            )}
          </div>

          {pageCount > 1 && (
            <nav className="pager" aria-label="검색 결과 페이지">
              <button type="button" className="ghost" onClick={() => goPage(currentPage - 1)} disabled={currentPage === 1} aria-label="이전 페이지">
                <Icon name="back" size={15} />
              </button>
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={p === currentPage ? 'page-num active' : 'page-num'}
                  aria-current={p === currentPage ? 'page' : undefined}
                  onClick={() => goPage(p)}
                >
                  {p}
                </button>
              ))}
              <button type="button" className="ghost" onClick={() => goPage(currentPage + 1)} disabled={currentPage === pageCount} aria-label="다음 페이지">
                <Icon name="back" size={15} className="flip" />
              </button>
              <span className="muted small pager-info">
                {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, shown.length)} / {shown.length}개
              </span>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}

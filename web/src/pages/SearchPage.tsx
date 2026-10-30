import { Icon } from '../components/Icon.tsx';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiGet, streamNdjson } from '../api.ts';
import { FacetPanel, facetCount, matchFacets, NO_FACETS, type Facets } from '../components/FacetPanel.tsx';
import { RepoCard } from '../components/RepoCard.tsx';
import { ResultCard, skillHref } from '../components/ResultCard.tsx';
import { TranslationNotice } from '../components/TranslationNotice.tsx';
import { useInstalled } from '../installed.ts';
import { STAGES } from '../labels.ts';
import { byPopular, foldResults, nameMatches, navigationalWord, SORTS, type SortKey } from '../lib/resultOrder.ts';
import type { Health, Job, OpenedFrom, ResultItem, RiskLevel, SearchEvent, SearchSource, SettingsResponse, SourceKind, SourceProgress } from '../types.ts';

/** Results per page, remembered in this browser. */
const PAGE_SIZE_KEY = 'skill-finder-page-size';
function readPageSize(): number {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return [5, 10, 20].includes(n) ? n : 5;
  } catch {
    return 5;
  }
}

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
    try {
      sessionStorage.removeItem(SNAPSHOT_KEY);
    } catch {
      // nothing stored
    }
  }
  window.dispatchEvent(new CustomEvent(SEARCH_LOG_EVENT, { detail: on }));
}

/** The search page's address with the last query, for the "검색" menu (so the query stays in the address). */
export function searchUrl(): string {
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
  const [warnings, setWarnings] = useState<Array<{ source: string; message: string }>>([]);
  const [items, setItems] = useState<ResultItem[]>([]);
  const [provisional, setProvisional] = useState(false);
  const [final, setFinal] = useState<Extract<SearchEvent, { type: 'results' }> | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ cached: boolean; elapsedMs: number } | null>(null);
  /** This search in the local search log; the cards opened from it point back to it. */
  const [sid, setSid] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<Partial<Record<SearchSource, SourceProgress>>>({});
  /** The star minimum this search was run without ("보기"), for the badge on cards below it; null normally. */
  const [liftedStars, setLiftedStars] = useState<number | null>(null);
  /** English query offered for a Korean one (the server sends it first, before any results). */
  const [suggest, setSuggest] = useState<{ query: string; dropped: string[] } | null>(null);
  const [openRepos, setOpenRepos] = useState<Set<string>>(() => new Set());
  const [openNames, setOpenNames] = useState<Set<string>>(() => new Set());
  const [startedAt, setStartedAt] = useState(0);
  const [githubToken, setGithubToken] = useState<boolean | null>(null);
  /** Whether the search log is on; when off the query is not put in the address either. */
  const [logOn, setLogOn] = useState(true);
  useEffect(() => {
    const on = (e: Event) => setLogOn((e as CustomEvent<boolean>).detail);
    window.addEventListener(SEARCH_LOG_EVENT, on);
    return () => window.removeEventListener(SEARCH_LOG_EVENT, on);
  }, []);
  /** The conditions the shown results were searched with (the controls may change after), for the snapshot. */
  const searchedWith = useRef<{ risk: RiskLevel; sources: SourceKind[] }>({ risk: 'medium', sources: [] });
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

  useEffect(() => {
    apiGet<SettingsResponse>('/settings')
      .then((s) => {
        setGithubToken(s.githubToken);
        setLogOn(s.settings.searchLog);
      })
      .catch(() => {});
    let timer: ReturnType<typeof setTimeout>;
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
    poll();
    return () => clearTimeout(timer);
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
      if (e.key === '/') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === 'j' || e.key === 'k') {
        const links = [...(resultsRef.current?.parentElement?.querySelectorAll<HTMLElement>('.results a.card-link') ?? [])];
        if (links.length === 0) return;
        e.preventDefault();
        const at = links.indexOf(document.activeElement as HTMLElement);
        const next = at < 0 ? 0 : Math.min(links.length - 1, Math.max(0, at + (e.key === 'j' ? 1 : -1)));
        links[next].focus();
        links[next].scrollIntoView({ block: 'nearest' });
      } else if (e.key === '?') {
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
                setWarnings((w) => [...w, { source: e.source, message: e.message }]);
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
        setWarnings((w) => [...w, { source: 'client', message: String((err as Error).message ?? err) }]);
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
    if (snap?.q !== q) {
      void run(q);
      return;
    }
    setLastQuery(q);
    onQuery(q);
    setMaxRisk(snap.risk);
    setSources(snap.sources);
    searchedWith.current = { risk: snap.risk, sources: snap.sources };
    setItems(snap.items);
    setFinal(snap.final);
    setDoneInfo(snap.doneInfo);
    setSid(snap.sid);
    setLiftedStars(snap.liftedStars);
    setStatus('done');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on load
  }, []);

  const toggleSource = (s: SourceKind) => setSources((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const filtered = items.filter((it) => matchFacets(it, facets));
  const compare = SORTS.find((s) => s.key === sort)!.compare;
  const word = navigationalWord(lastQuery);
  // Same rule as the server: an exact skill/repo name ("rea") is a lookup, so its skills come first by default.
  // Among those name matches popularity alone decides, as on the server (no relevance tier).
  const sorted = filtered.sort(
    sort === 'popular' && word
      ? (a, b) => {
          const na = nameMatches(a, word);
          const nb = nameMatches(b, word);
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
  const shown = foldResults(sorted, openRepos, openNames, word);
  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageItems = shown.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const fromOf = (i: number): OpenedFrom => ({ sid, pos: (currentPage - 1) * pageSize + i + 1, page: currentPage, provisional });
  const goPage = (p: number) => {
    setPage(Math.min(Math.max(1, p), pageCount));
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Warnings that change what the results mean (failures, incomplete results) stay visible;
  // routine notes (no GitHub token, hidden description-less results) fold into the "알림" toggle.
  const isUrgent = (w: { source: string; message: string }) =>
    w.source === 'github' ? w.message.startsWith('GitHub 검색 실패') : ['query', 'server', 'client', 'skillssh', 'enrich', 'local'].includes(w.source);
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
  const hiddenRisky = final && maxRisk !== 'high' ? final.hiddenHighRisk : 0;
  // "별 N개 미만 M개 숨김 · 보기" (user decision B): searches once without the minimum; the setting stays
  const hiddenLowStars = final && (final.minStars ?? 0) > 0 ? (final.hiddenLowStars ?? 0) : 0;

  return (
    <div className="page search-page">
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
          />
          <button type="submit" className="primary" disabled={!query.trim() || sources.length === 0}>
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
            <label key={s} className="chip" title={s === 'github' && githubToken === false ? '설정에서 GitHub 토큰을 넣으면 사용됩니다' : undefined}>
              <input type="checkbox" checked={sources.includes(s)} onChange={() => toggleSource(s)} />
              {SOURCE_LABEL[s]}
              {s === 'github' && githubToken === false && <span className="muted small">(토큰 없음)</span>}
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
            <span className="spinner" aria-hidden="true" /> {syncJob.kind === 'collect' ? '인기 저장소의 스킬 모으는 중' : '마켓플레이스 동기화 중'} {syncJob.done}/
            {syncJob.total || '?'} · 색인 스킬 {(health?.skills ?? 0).toLocaleString()}개
          </p>
        )}
      </div>

      {status === 'idle' && (
        <div className="empty">
          <p>원하는 기능을 영어로 적으면 공식·커뮤니티 마켓플레이스, skills.sh, GitHub에서 Claude Code 스킬을 찾아 점수와 위험 신호를 붙여 보여 줍니다.</p>
          <div className="examples">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="chip-btn"
                onClick={() => {
                  setQuery(ex);
                  run(ex);
                }}
              >
                {ex}
              </button>
            ))}
          </div>
          {health && (
            <p className="sysline">
              {health.appVersion && <span>skill-finder {health.appVersion}</span>}
              <span className={health.claudeVersion ? '' : 'warn-text'}>claude-code {health.claudeVersion ?? '없음'}</span>
              <span>skills-cli {health.skillsCli}</span>
              <span>
                색인 스킬 {health.skills.toLocaleString()} · 플러그인 {health.plugins.toLocaleString()}
              </span>
            </p>
          )}
          {health && !health.claudeVersion && <p className="warn-text small">Claude Code를 찾지 못해 플러그인 설치가 되지 않습니다.</p>}
          {githubToken === false && (
            // before the first search only (UI debate D-4); in results it stays in the folded notices (D:48)
            <p className="muted small">
              GitHub 토큰 없음 · GitHub 코드 검색을 건너뛰고 스킬 목록도 느리게 모읍니다.{' '}
              <a href="/settings">설정에서 넣기</a>
            </p>
          )}
          <TranslationNotice />
        </div>
      )}

      <div className={showFacets ? 'results-layout' : undefined}>
        {showFacets && <FacetPanel items={items} value={facets} onChange={changeFacets} />}
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
                  </span>
                ) : status === 'running' ? (
                  <span className="status-line">
                    <span className="spinner" aria-hidden="true" /> {stage ? STAGES[stage] : '검색'} 중…
                  </span>
                ) : status === 'error' ? (
                  <span className="warn-text">검색 실패</span>
                ) : (
                  // one count, the same as the pager's: cards shown; folded copies and filtered-out ones are noted
                  <span>
                    <b>{shown.length}</b>개 결과
                    {sorted.length > shown.length && <span className="muted small"> · {sorted.length - shown.length}개 접힘</span>}
                    {filtering && <span className="muted small"> · 필터로 {items.length - sorted.length}개 뺌</span>}
                    {doneInfo && <span className="muted small"> · {doneInfo.cached ? '저장된 결과' : `${(doneInfo.elapsedMs / 1000).toFixed(1)}초`}</span>}
                  </span>
                )}
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
                {status === 'done' && hiddenLowStars > 0 && (
                  <button
                    type="button"
                    className="status-chip action"
                    title="이번 검색만 최소 스타 수 없이 다시 검색합니다 (설정은 그대로). 후보 중 일부는 다시 찾으면 검색어와 맞지 않아 빠질 수 있습니다."
                    onClick={() => run(lastQuery, maxRisk, final!.minStars!)}
                  >
                    별 {final!.minStars!.toLocaleString()} 미만 {hiddenLowStars}개 숨김 · 보기
                  </button>
                )}
                {status === 'done' && liftedStars != null && (
                  <button type="button" className="status-chip action" title="설정한 최소 스타 수로 다시 검색합니다" onClick={() => run(lastQuery)}>
                    별 제한 없이 보는 중 · 되돌리기
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
                        try {
                          localStorage.setItem(PAGE_SIZE_KEY, e.target.value);
                        } catch {
                          // not remembered; nothing else changes
                        }
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
                  repo={r}
                  onOpenSkill={(id) => {
                    const item = items.find((x) => x.id === id);
                    if (item) onOpen(item);
                  }}
                />
              ))}
            </div>
          )}

          <div className="results">
            {pageItems.map(({ item: it, more, same }, i) => (
              <Fragment key={it.id}>
                <ResultCard
                  item={it}
                  position={i}
                  provisional={provisional}
                  belowMinStars={liftedStars != null && (it.stars ?? 0) < liftedStars ? liftedStars : undefined}
                  href={skillHref(it.id, fromOf(i))}
                  installed={installedAs(it)}
                  onSelect={() => onOpen(it, fromOf(i))}
                />
                {same && (
                  <button type="button" className="linkish small fold-more" onClick={() => setOpenNames((s) => new Set(s).add(same.key))}>
                    같은 이름 <span className="mono">{it.name}</span> {same.count}개 더 보기
                    {same.riskier && <span className="warn-text"> · 위험 주의 포함</span>}
                  </button>
                )}
                {more && (
                  <button type="button" className="linkish small fold-more" onClick={() => setOpenRepos((s) => new Set(s).add(more.repo))}>
                    <span className="mono">{more.repo}</span>에서 {more.count}개 더 보기
                  </button>
                )}
              </Fragment>
            ))}
            {status === 'done' && items.length === 0 && (
              <div className="empty">
                <p>
                  결과가 없습니다.
                  {(health?.skills ?? 0) < FEW_SKILLS
                    ? ' 아직 스킬 목록을 모으는 중이라 결과가 적을 수 있습니다. 잠시 뒤 다시 검색해 보세요.'
                    : ' 다른 영어 표현으로 검색해 보세요.'}
                </p>
                {(sources.length < 3 || maxRisk !== 'high' || (final?.minStars ?? 0) > 0) && (
                  <div className="examples">
                    <span className="muted small">걸려 있는 조건:</span>
                    {sources.length < 3 && (
                      <button
                        type="button"
                        className="chip-btn"
                        onClick={() => {
                          const all: SourceKind[] = ['marketplace', 'skillssh', 'github'];
                          setSources(all);
                          run(lastQuery, maxRisk, liftedStars, all);
                        }}
                      >
                        출처 {3 - sources.length}곳 꺼짐 · 모두 켜고 다시 찾기
                      </button>
                    )}
                    {maxRisk !== 'high' && (
                      <button
                        type="button"
                        className="chip-btn"
                        onClick={() => {
                          setMaxRisk('high');
                          run(lastQuery, 'high', liftedStars);
                        }}
                      >
                        위험 {maxRisk === 'low' ? '낮음만' : '주의까지'} · 모두 보고 다시 찾기
                      </button>
                    )}
                    {(final?.minStars ?? 0) > 0 && (
                      <button type="button" className="chip-btn" onClick={() => run(lastQuery, maxRisk, final!.minStars!)}>
                        별 {final!.minStars!.toLocaleString()} 이상만 · 이번만 풀고 다시 찾기
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {items.length > 0 && sorted.length === 0 && (
              <p className="empty">
                선택한 필터에 맞는 결과가 없습니다.{' '}
                <button type="button" className="linkish" onClick={() => changeFacets(NO_FACETS)}>
                  필터 초기화
                </button>
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

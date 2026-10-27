import { Icon } from '../components/Icon.tsx';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiGet, streamNdjson } from '../api.ts';
import { FacetPanel, facetCount, matchFacets, NO_FACETS, type Facets } from '../components/FacetPanel.tsx';
import { RepoCard } from '../components/RepoCard.tsx';
import { ResultCard } from '../components/ResultCard.tsx';
import { TranslationNotice } from '../components/TranslationNotice.tsx';
import { STAGES } from '../labels.ts';
import type { Health, Job, ResultItem, RiskLevel, SearchEvent, SettingsResponse, SourceKind } from '../types.ts';

const EXAMPLES = ['pull request review', 'extract tables from pdf', 'react performance', 'postgres migration review', 'commit message'];
const SOURCE_LABEL: Record<SourceKind, string> = { marketplace: '마켓플레이스', skillssh: 'skills.sh', github: 'GitHub' };

type SortKey = 'popular' | 'stars' | 'recent' | 'name';
// Default order (user decision, same as the server): downloads, then stars, then relevance.
const byPopular = (a: ResultItem, b: ResultItem) =>
  (b.installs ?? -1) - (a.installs ?? -1) || (b.stars ?? -1) - (a.stars ?? -1) || b.breakdown.R - a.breakdown.R;
const SORTS: Array<{ key: SortKey; label: string; compare: (a: ResultItem, b: ResultItem) => number }> = [
  { key: 'popular', label: '다운로드 → 스타 → 연관도', compare: byPopular },
  { key: 'stars', label: '스타 많은 순', compare: (a, b) => (b.stars ?? -1) - (a.stars ?? -1) || byPopular(a, b) },
  {
    key: 'recent',
    label: '최근 업데이트 순',
    compare: (a, b) => (b.lastCommitAt ? Date.parse(b.lastCommitAt) : 0) - (a.lastCommitAt ? Date.parse(a.lastCommitAt) : 0) || byPopular(a, b),
  },
  { key: 'name', label: '이름순', compare: (a, b) => a.name.localeCompare(b.name) },
];

/** Mirrors server/src/search/pipeline.ts: a one-word query as a name, and whether a result carries that name. */
function navigationalWord(query: string): string | null {
  const q = query.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,99}$/.test(q) ? q : null;
}
function nameMatches(item: ResultItem, word: string): boolean {
  const name = item.name.toLowerCase();
  return name === word || name.startsWith(`${word}-`) || item.id.match(/^gh:[^/]+\/([^:]+):/)?.[1] === word;
}

type Status = 'idle' | 'running' | 'done' | 'error';

export function SearchPage({ onOpen, onQuery }: { onOpen: (item: ResultItem) => void; onQuery: (q: string) => void }) {
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
  const [githubToken, setGithubToken] = useState<boolean | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [syncJob, setSyncJob] = useState<Job | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('popular');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  // Sidebar filters narrow the current results in the browser; they stay set across searches.
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const noticesRef = useRef<HTMLDetailsElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    apiGet<SettingsResponse>('/settings')
      .then((s) => setGithubToken(s.githubToken))
      .catch(() => {});
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [h, j] = await Promise.all([apiGet<Health>('/health'), apiGet<{ jobs: Job[] }>('/jobs')]);
        setHealth(h);
        const running = j.jobs.find((x) => x.kind === 'sync' && (x.status === 'running' || x.status === 'paused')) ?? null;
        setSyncJob(running);
        if (running) timer = setTimeout(poll, 3000);
      } catch {
        timer = setTimeout(poll, 5000);
      }
    };
    poll();
    return () => clearTimeout(timer);
  }, []);

  // "/" jumps to the search box (unless the user is already typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const textInput = el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type);
      const typing = el && (textInput || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key !== '/' || typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (inputRef.current?.offsetParent === null) return; // search page hidden
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
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
    async (q: string, risk = maxRisk) => {
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
      setProvisional(false);
      setLastQuery(text);
      onQuery(text);
      try {
        await streamNdjson<SearchEvent>(
          '/search',
          { query: text, filters: { sources, maxRisk: risk } },
          (e) => {
            if (ac.signal.aborted) return;
            switch (e.type) {
              case 'stage':
                setStage(e.stage);
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
    [sources, maxRisk, onQuery],
  );

  const toggleSource = (s: SourceKind) => setSources((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const filtered = items.filter((it) => matchFacets(it, facets));
  const compare = SORTS.find((s) => s.key === sort)!.compare;
  const word = navigationalWord(lastQuery);
  // Same rule as the server: an exact skill/repo name ("rea") is a lookup, so its skills come first by default.
  const sorted = filtered.sort(sort === 'popular' && word ? (a, b) => Number(nameMatches(b, word)) - Number(nameMatches(a, word)) || compare(a, b) : compare);
  const filtering = facetCount(facets) > 0;
  const showFacets = status !== 'idle' && (items.length > 0 || filtering);
  const changeFacets = (f: Facets) => {
    setFacets(f);
    setPage(1);
  };
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageItems = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const goPage = (p: number) => {
    setPage(Math.min(Math.max(1, p), pageCount));
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Warnings that change what the results mean (failures, incomplete results) stay visible;
  // routine notes (no GitHub token, hidden description-less results) fold into the "알림" toggle.
  const isUrgent = (w: { source: string; message: string }) =>
    w.source === 'github' ? w.message.startsWith('GitHub 검색 실패') : ['query', 'server', 'client', 'skillssh', 'enrich'].includes(w.source);
  const urgent = warnings.filter(isUrgent);
  const minor: Array<{ key: string; node: ReactNode }> = [
    ...warnings.filter((w) => !isUrgent(w)).map((w, i) => ({ key: `w${i}`, node: w.message })),
    ...(final && final.hiddenNoDescription > 0 ? [{ key: 'nodesc', node: `설명이 없어 판단할 수 없는 결과 ${final.hiddenNoDescription}개는 숨겼습니다.` }] : []),
    ...(final && (final.hiddenLowStars ?? 0) > 0
      ? [
          {
            key: 'stars',
            node: `GitHub 스타 ${(final.minStars ?? 0).toLocaleString()}개 미만(또는 스타 수를 모르는) 저장소의 결과 ${final.hiddenLowStars}개는 숨겼습니다. 설정에서 바꿀 수 있습니다.`,
          },
        ]
      : []),
  ];
  const hiddenRisky = final && maxRisk !== 'high' ? final.hiddenHighRisk : 0;

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
            <kbd>/</kbd> 검색창으로 이동
          </span>
        </div>
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

      {syncJob && (
        <p className="status-line muted small">
          <span className="spinner" aria-hidden="true" /> 마켓플레이스 동기화 중 {syncJob.done}/{syncJob.total || '?'} · 색인 스킬 {health?.skills ?? 0}개
        </p>
      )}

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
              <span className={health.claudeVersion ? '' : 'warn-text'}>claude-code {health.claudeVersion ?? '없음'}</span>
              <span>skills-cli {health.skillsCli}</span>
              <span>
                색인 스킬 {health.skills.toLocaleString()} · 플러그인 {health.plugins.toLocaleString()}
              </span>
            </p>
          )}
          {health && !health.claudeVersion && <p className="warn-text small">Claude Code를 찾지 못해 플러그인 설치가 되지 않습니다.</p>}
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
                      <b>{sorted.length}</b>
                      {filtering && <span className="muted"> / {items.length}</span>}개 결과
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
                  <span>
                    <b>{sorted.length}</b>
                    {filtering && <span className="muted"> / {items.length}</span>}개 결과
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
                      run(lastQuery, 'high');
                    }}
                  >
                    위험 높음 {hiddenRisky}개 숨김 · 모두 보기
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

          <div role="status">
            {urgent.map((w, i) => (
              <div key={i} className="warn-strip">
                <Icon name="alert" size={15} /> <span>{w.message}</span>
              </div>
            ))}
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
            {pageItems.map((it, i) => (
              <ResultCard key={it.id} item={it} position={i} provisional={provisional} onSelect={() => onOpen(it)} />
            ))}
            {status === 'done' && items.length === 0 && <p className="empty">결과가 없습니다. 다른 영어 표현으로 검색해 보세요.</p>}
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
                {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, sorted.length)} / {sorted.length}개
              </span>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}

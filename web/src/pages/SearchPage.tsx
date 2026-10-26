import { Icon } from '../components/Icon.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, streamNdjson } from '../api.ts';
import { ResultCard } from '../components/ResultCard.tsx';
import { TranslationNotice } from '../components/TranslationNotice.tsx';
import { STAGES } from '../labels.ts';
import type { Health, Job, ResultItem, RiskLevel, SearchEvent, SettingsResponse, SourceKind } from '../types.ts';

const EXAMPLES = ['pull request review', 'extract tables from pdf', 'react performance', 'postgres migration review', 'commit message'];
const SOURCE_LABEL: Record<SourceKind, string> = { marketplace: '마켓플레이스', skillssh: 'skills.sh', github: 'GitHub' };
const STAGE_ORDER = ['collect', 'enrich', 'score'];

type SortKey = 'score' | 'relevance' | 'installs' | 'stars' | 'recent' | 'name';
const SORTS: Array<{ key: SortKey; label: string; compare: (a: ResultItem, b: ResultItem) => number }> = [
  { key: 'score', label: '종합 점수', compare: (a, b) => b.score - a.score },
  { key: 'relevance', label: '적합도', compare: (a, b) => b.breakdown.R - a.breakdown.R || b.score - a.score },
  { key: 'installs', label: '다운로드 많은 순', compare: (a, b) => (b.installs ?? -1) - (a.installs ?? -1) || b.score - a.score },
  { key: 'stars', label: '스타 많은 순', compare: (a, b) => (b.stars ?? -1) - (a.stars ?? -1) || b.score - a.score },
  {
    key: 'recent',
    label: '최근 업데이트 순',
    compare: (a, b) => (b.lastCommitAt ? Date.parse(b.lastCommitAt) : 0) - (a.lastCommitAt ? Date.parse(a.lastCommitAt) : 0) || b.score - a.score,
  },
  { key: 'name', label: '이름순', compare: (a, b) => a.name.localeCompare(b.name) },
];

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
  const [sort, setSort] = useState<SortKey>('score');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const resultsRef = useRef<HTMLDivElement>(null);
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
  const stageIdx = stage ? STAGE_ORDER.indexOf(stage) : -1;
  const sorted = [...items].sort(SORTS.find((s) => s.key === sort)!.compare);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageItems = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const goPage = (p: number) => {
    setPage(Math.min(Math.max(1, p), pageCount));
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="page search-page">
      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="필요한 기능을 영어로 입력하세요 (예: extract tables from pdf)"
          maxLength={300}
          aria-label="검색어"
          autoFocus
        />
        <button type="submit" className="primary" disabled={!query.trim() || sources.length === 0}>
          검색
        </button>
      </form>
      <div className="filters">
        <span className="muted small">출처</span>
        {(Object.keys(SOURCE_LABEL) as SourceKind[]).map((s) => (
          <label key={s} className="chip">
            <input type="checkbox" checked={sources.includes(s)} onChange={() => toggleSource(s)} />
            {SOURCE_LABEL[s]}
            {s === 'github' && githubToken === false && <span className="muted small"> (토큰 없음)</span>}
          </label>
        ))}
        <span className="muted small sep">최대 위험</span>
        <select value={maxRisk} onChange={(e) => setMaxRisk(e.target.value as RiskLevel)} aria-label="최대 위험 등급">
          <option value="low">낮음만</option>
          <option value="medium">주의까지 (기본)</option>
          <option value="high">모두 (위험 높음 포함)</option>
        </select>
      </div>

      <p className="info-box hint">
        <b>영어로 검색하세요.</b> 검색어를 번역하지 않고 그대로 찾습니다. 스킬 설명이 대부분 영어라 한국어로 검색하면 결과가 적거나 부정확합니다. 예: <code>extract tables from pdf</code>
      </p>
      <TranslationNotice />

      {syncJob && (
        <div className="info-box">
          마켓플레이스 동기화 중… {syncJob.done}/{syncJob.total || '?'} · 현재 색인 플러그인 {health?.plugins ?? 0}개, 스킬 {health?.skills ?? 0}개
        </div>
      )}

      {status === 'idle' && (
        <div className="empty">
          <p>원하는 기능을 영어로 적으면 공식·커뮤니티 마켓플레이스, skills.sh, GitHub에서 Claude Code 스킬을 찾아 점수와 위험 신호를 붙여 보여 줍니다. 결과를 누르면 상세 페이지로 이동합니다.</p>
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
            <p className="muted small">
              색인: 플러그인 {health.plugins}개 · 스킬 {health.skills}개 · Claude Code {health.claudeVersion ?? '없음'} · skills CLI {health.skillsCli}
            </p>
          )}
        </div>
      )}

      {status !== 'idle' && (
        <div className="progress" aria-live="polite">
          {STAGE_ORDER.map((s, i) => (
            <span key={s} className={`step ${status === 'done' || i < stageIdx ? 'done' : i === stageIdx && status === 'running' ? 'now' : ''}`}>
              {STAGES[s]}
            </span>
          ))}
          {doneInfo && <span className="muted small">{doneInfo.cached ? '캐시 결과' : `${(doneInfo.elapsedMs / 1000).toFixed(1)}초`}</span>}
          {final && <span className="muted small">· 결과 {final.items.length}개</span>}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="warnings" role="status">
          {warnings.map((w, i) => (
            <div key={i} className="warn-strip">
              <Icon name="alert" size={15} /> <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {provisional && items.length > 0 && <p className="muted small">임시 결과입니다. 후보 확인이 끝나면 갱신됩니다.</p>}
      {final && final.hiddenNoDescription > 0 && (
        <p className="muted small">설명이 없어 판단할 수 없는 결과 {final.hiddenNoDescription}개는 숨겼습니다.</p>
      )}
      {final && final.hiddenHighRisk > 0 && maxRisk !== 'high' && (
        <p className="muted small">
          위험 등급 필터로 {final.hiddenHighRisk}개를 숨겼습니다.{' '}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setMaxRisk('high');
              run(lastQuery, 'high');
            }}
          >
            모두 보기
          </button>
        </p>
      )}

      {items.length > 0 && (
        <div className="sort-row">
          <label>
            <span className="muted small">정렬</span>{' '}
            <select value={sort} onChange={(e) => {
                setSort(e.target.value as SortKey);
                setPage(1);
              }} aria-label="정렬 기준">
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {(sort === 'installs' || sort === 'stars') && (
            <span className="muted small">{sort === 'installs' ? '다운로드 수' : '스타 수'}를 모르는 스킬은 뒤로 보냅니다</span>
          )}
        </div>
      )}

      <div className="results" ref={resultsRef}>
        {pageItems.map((it, i) => (
          <ResultCard key={it.id} item={it} position={i} provisional={provisional} onSelect={() => onOpen(it)} />
        ))}
        {status === 'done' && items.length === 0 && <p className="empty">결과가 없습니다. 다른 영어 표현으로 검색해 보세요.</p>}
        {status === 'running' && items.length === 0 && <p className="muted">검색 중…</p>}
      </div>

      {sorted.length > 0 && (
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
        </nav>
      )}
    </div>
  );
}

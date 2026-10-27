import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, apiSend } from '../api.ts';
import { FolderInput } from '../components/FolderInput.tsx';
import { Icon } from '../components/Icon.tsx';
import { ResultCard } from '../components/ResultCard.tsx';
import { Translated } from '../components/Translated.tsx';
import { TranslationNotice } from '../components/TranslationNotice.tsx';
import type { RecommendResult, ResultItem, SettingsResponse } from '../types.ts';

/** What to do next, per error status of POST /readme-skills. */
const ERROR_HINT: Record<number, string> = {
  400: '폴더의 전체 경로(예: C:\\Users\\me\\project)를 입력하거나 "폴더 선택"으로 고르세요.',
  404: '이 폴더 바로 아래에 README(README.md 등)가 없습니다. 프로젝트 루트 폴더를 골랐는지 확인하세요.',
  413: 'README가 1MB를 넘어 읽지 않았습니다.',
};

export function RecommendPage({ onOpen }: { onOpen: (item: ResultItem) => void }) {
  const [projectPath, setProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RecommendResult | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<SettingsResponse>('/settings')
      .then((s) => setProjectPath((cur) => cur || s.settings.defaultProjectPath))
      .catch(() => {});
  }, []);

  const analyze = async (path = projectPath) => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await apiSend<RecommendResult>('POST', '/readme-skills', { projectPath: path.trim() }));
      setPage(1);
    } catch (e) {
      setResult(null);
      const status = e instanceof ApiError ? e.status : 0;
      setError({ message: String((e as Error).message ?? e), hint: ERROR_HINT[status] });
    } finally {
      setBusy(false);
    }
  };

  const skills = result?.skills ?? [];
  const pageCount = Math.max(1, Math.ceil(skills.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageItems = skills.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const goPage = (p: number) => {
    setPage(Math.min(Math.max(1, p), pageCount));
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="page recommend-page">
      <h1>README 추천</h1>
      <p className="muted">
        프로젝트 폴더를 고르면 맨 위의 README를 읽고, 이 프로젝트와 비슷한 스킬을 다운로드·인기 순으로 보여 줍니다. AI 없이 README의 단어로만
        찾습니다.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void analyze();
        }}
      >
        <FolderInput
          value={projectPath}
          onChange={(p) => {
            setProjectPath(p);
            void analyze(p);
          }}
          placeholder="프로젝트 폴더 경로"
        />
        <button type="submit" className="primary" disabled={!projectPath.trim() || busy}>
          {busy ? '분석 중…' : '분석'}
        </button>
      </form>

      {error && (
        <div className="warn-box">
          <b>{error.message}</b>
          {error.hint && <div className="small">{error.hint}</div>}
        </div>
      )}

      {result && (
        <>
          <section className="readme-summary">
            <h2>README 요약</h2>
            <h3 className="summary-title">{result.summary.title}</h3>
            {result.summary.intro ? <Translated className="summary" text={result.summary.intro} /> : <p className="muted">소개 문단이 없습니다.</p>}
            {result.summary.features.length > 0 && (
              <ul className="explain">
                {result.summary.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            <p className="muted small keyword-line">
              핵심 단어{' '}
              {result.keywords.map((k) => (
                <code key={k.term} title={`가중치 ${k.weight}`}>
                  {k.term}
                </code>
              ))}
            </p>
          </section>

          {skills.length === 0 ? (
            <p className="empty">비슷한 스킬을 찾지 못했습니다. README의 단어와 겹치는 스킬이 색인에 없습니다.</p>
          ) : (
            <>
              <div className="results-toolbar" ref={listRef}>
                <div className="toolbar-left">
                  <span>
                    비슷한 스킬 <b>{skills.length}</b>개 <span className="muted small">· 다운로드 → 스타 순</span>
                  </span>
                </div>
                <div className="toolbar-right">
                  <TranslationNotice compact />
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
                </div>
              </div>
              <div className="results">
                {pageItems.map((m, i) => (
                  <div key={m.item.id} title={`README와 겹친 단어: ${m.matchedTerms.join(', ')}`}>
                    <ResultCard item={m.item} position={i} onSelect={() => onOpen(m.item)} />
                  </div>
                ))}
              </div>
              {pageCount > 1 && (
                <nav className="pager" aria-label="추천 결과 페이지">
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
                    {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, skills.length)} / {skills.length}개
                  </span>
                </nav>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

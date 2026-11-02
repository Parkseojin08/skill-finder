import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, apiSend } from '../api.ts';
import { FolderInput } from '../components/FolderInput.tsx';
import { Icon } from '../components/Icon.tsx';
import { ResultCard, skillHref } from '../components/ResultCard.tsx';
import { useInstalled } from '../installed.ts';
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
  const installedAs = useInstalled();
  const [projectPath, setProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RecommendResult | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  /** High-risk skills are hidden like in search (project review 2026-11-02: a curl|sh skill ranked 10th). */
  const [showRisky, setShowRisky] = useState(false);
  /** The keywords shown as chips (the first analysis's, plus added words), and the ones turned off. */
  const [terms, setTerms] = useState<string[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<string[]>([]);
  const [newWord, setNewWord] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<SettingsResponse>('/settings')
      .then((s) => setProjectPath((cur) => cur || s.settings.defaultProjectPath))
      .catch(() => {});
  }, []);

  /** `tuning`: the same project again with keywords turned off or added; without it a fresh analysis. */
  const analyze = async (path = projectPath, tuning?: { off: Set<string>; added: string[] }) => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { projectPath: path.trim(), exclude: tuning ? [...tuning.off] : undefined, extra: tuning?.added };
      const r = await apiSend<RecommendResult>('POST', '/readme-skills', body);
      setResult(r);
      setPage(1);
      setShowRisky(false);
      if (!tuning) {
        setTerms(r.keywords.map((k) => k.term));
        setOff(new Set());
        setAdded([]);
      }
    } catch (e) {
      setResult(null);
      const status = e instanceof ApiError ? e.status : 0;
      setError({ message: String((e as Error).message ?? e), hint: ERROR_HINT[status] });
    } finally {
      setBusy(false);
    }
  };

  // Turning a keyword off or adding one recalculates at once (project review 2026-11-02; local only, no AI).
  const toggleTerm = (t: string) => {
    const next = new Set(off);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setOff(next);
    void analyze(projectPath, { off: next, added });
  };
  const addWord = () => {
    const w = newWord.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(w) || terms.includes(w)) return;
    const nextAdded = [...added, w];
    setTerms([w, ...terms]);
    setAdded(nextAdded);
    setNewWord('');
    void analyze(projectPath, { off, added: nextAdded });
  };

  const all = result?.skills ?? [];
  const hiddenRisky = showRisky ? 0 : all.filter((m) => m.item.riskLevel === 'high').length;
  const skills = showRisky ? all : all.filter((m) => m.item.riskLevel !== 'high');
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
          onChange={setProjectPath}
          onPick={(p) => void analyze(p)}
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
            <h2>{/package\.json$|pyproject\.toml$|Cargo\.toml$/i.test(result.readmePath) ? `${result.readmePath.split(/[\\/]/).pop()} 요약 (README 없음)` : 'README 요약'}</h2>
            <h3 className="summary-title">{result.summary.title}</h3>
            {result.summary.intro ? <Translated className="summary" text={result.summary.intro} /> : <p className="muted">소개 문단이 없습니다.</p>}
            {result.summary.features.length > 0 && (
              <ul className="explain">
                {result.summary.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            <div className="keyword-line">
              <span className="muted small">핵심 단어 · 눌러서 빼거나 다시 넣기</span>
              {terms.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip-btn mono${off.has(t) ? ' off' : ''}`}
                  aria-pressed={!off.has(t)}
                  title={off.has(t) ? '빼 둔 단어 · 눌러서 다시 넣기' : '눌러서 이 단어 빼기'}
                  onClick={() => toggleTerm(t)}
                  disabled={busy}
                >
                  {t}
                </button>
              ))}
              <form
                className="add-word"
                onSubmit={(e) => {
                  e.preventDefault();
                  addWord();
                }}
              >
                <input value={newWord} onChange={(e) => setNewWord(e.target.value)} placeholder="단어 더하기 (영어)" aria-label="추천에 더할 단어" maxLength={41} />
                <button type="submit" className="ghost" disabled={busy || !newWord.trim()}>
                  더하기
                </button>
              </form>
            </div>
          </section>

          {skills.length === 0 ? (
            <p className="empty">
              {hiddenRisky > 0 ? (
                <>
                  위험 높음으로 숨긴 {hiddenRisky}개만 있습니다.{' '}
                  <button type="button" className="linkish" onClick={() => setShowRisky(true)}>
                    보기
                  </button>
                </>
              ) : (
                '비슷한 스킬을 찾지 못했습니다. README의 단어와 겹치는 스킬이 색인에 없습니다.'
              )}
            </p>
          ) : (
            <>
              <div className="results-toolbar" ref={listRef}>
                <div className="toolbar-left">
                  <span>
                    비슷한 스킬 <b>{skills.length}</b>개 <span className="muted small">· 다운로드 → 스타 순</span>
                  </span>
                  {hiddenRisky > 0 && (
                    <button
                      type="button"
                      className="status-chip action"
                      title="외부 스크립트 실행·비밀값 접근처럼 위험이 큰 스킬입니다. 상세 화면에서 이유를 확인한 뒤 설치하세요."
                      onClick={() => {
                        setShowRisky(true);
                        setPage(1);
                      }}
                    >
                      위험 높음 {hiddenRisky}개 숨김 · 보기
                    </button>
                  )}
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
                    <ResultCard item={m.item} position={i} href={skillHref(m.item.id)} installed={installedAs(m.item)} onSelect={() => onOpen(m.item)} />
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

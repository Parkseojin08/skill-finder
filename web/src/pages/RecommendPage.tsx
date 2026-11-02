import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, apiSend } from '../api.ts';
import { FolderInput } from '../components/FolderInput.tsx';
import { Icon } from '../components/Icon.tsx';
import { ResultCard, skillHref } from '../components/ResultCard.tsx';
import { useInstalled } from '../installed.ts';
import { Translated } from '../components/Translated.tsx';
import { TranslationNotice } from '../components/TranslationNotice.tsx';
import { readPageSize, savePageSize } from '../lib/prefs.ts';
import type { RecommendResult, ResultItem, SettingsResponse } from '../types.ts';
import { t } from '../i18n.ts';

/** What to do next, per error status of POST /readme-skills. */
const ERROR_HINT: Record<number, string> = {
  400: t('폴더의 전체 경로(예: C:\\Users\\me\\project)를 입력하거나 "폴더 선택"으로 고르세요.'),
  404: t('프로젝트 루트 폴더를 골랐는지 확인하세요. 아래에 이 프로젝트를 나타내는 영어 단어를 넣어 직접 찾을 수도 있습니다.'),
  413: t('README가 1MB를 넘어 읽지 않았습니다.'),
};

/** The summary's heading: what was read ("package.json + CLAUDE.md 요약 (README 없음)"), or the typed words. */
function readFrom(result: RecommendResult): string {
  if (!result.readmePath) return t('넣은 단어로 찾은 결과');
  const files = [result.readmePath, ...(result.alsoRead ?? [])].map((p) => p.split(/[\\/]/).pop()!);
  return /^readme/i.test(files[0]) ? t('README 요약') : t('{0} 요약 (README 없음)', files.join(' + '));
}

export function RecommendPage({ onOpen }: { onOpen: (item: ResultItem) => void }) {
  const installedAs = useInstalled();
  const [projectPath, setProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RecommendResult | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string; status?: number } | null>(null);
  /** Why a word was not added ("이미 있음", not an English word): said instead of ignoring it (review 2026-11-02). */
  const [wordMsg, setWordMsg] = useState<string | null>(null);
  const [manualWords, setManualWords] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readPageSize);
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
      setError({ message: String((e as Error).message ?? e), hint: ERROR_HINT[status], status });
    } finally {
      setBusy(false);
    }
  };

  // Turning a keyword off or adding one recalculates at once (project review 2026-11-02; local only, no AI).
  const toggleTerm = (t: string) => {
    if (busy) return;
    const next = new Set(off);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setOff(next);
    void analyze(projectPath, { off: next, added });
  };
  const addWord = () => {
    const w = newWord.trim().toLowerCase();
    setWordMsg(null);
    if (terms.includes(w)) return setWordMsg(t('이미 있는 단어입니다.'));
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(w)) return setWordMsg(t('스킬 설명이 영어라 영어 단어만 더할 수 있습니다(영문·숫자·-, 2~41자). 예: typescript, nextjs'));
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
      <h1>{t('README 추천')}</h1>
      <p className="muted">
        {t('프로젝트 폴더를 고르면 맨 위의 README를 읽고, 이 프로젝트와 비슷한 스킬을 다운로드·인기 순으로 보여 줍니다. AI 없이 README의 단어로만 찾습니다. README가 없으면 package.json 같은 설명 파일과 CLAUDE.md·AGENTS.md를 읽습니다.')}
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
          placeholder={t('프로젝트 폴더 경로')}
        />
        <button type="submit" className="primary" disabled={!projectPath.trim() || busy}>
          {busy ? t('분석 중…') : t('분석')}
        </button>
      </form>

      {error && (
        <div className="warn-box">
          <b>{error.message}</b>
          {error.hint && <div className="small">{error.hint}</div>}
        </div>
      )}
      {error?.status === 404 && (
        // no README or package file: the project described in a few English words instead (local, no AI)
        <form
          className="row add-word"
          onSubmit={(e) => {
            e.preventDefault();
            const words = [...new Set(manualWords.toLowerCase().split(/[\s,]+/).filter((w) => /^[a-z][a-z0-9-]{1,40}$/.test(w)))].slice(0, 20);
            if (!words.length) return;
            setTerms(words);
            setOff(new Set());
            setAdded(words);
            void analyze(projectPath, { off: new Set(), added: words });
          }}
        >
          <input value={manualWords} onChange={(e) => setManualWords(e.target.value)} placeholder={t('예: react dashboard charts')} aria-label={t('이 프로젝트를 나타내는 영어 단어')} />
          <button type="submit" className="ghost" disabled={busy || !manualWords.trim()}>
            {t('단어로 찾기')}
          </button>
        </form>
      )}

      {result && (
        <>
          <section className="readme-summary">
            <h2>{readFrom(result)}</h2>
            <h3 className="summary-title">{result.summary.title}</h3>
            {result.summary.intro ? <Translated className="summary" text={result.summary.intro} /> : <p className="muted">{t('소개 문단이 없습니다.')}</p>}
            {result.summary.features.length > 0 && (
              <ul className="explain">
                {result.summary.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            <div className="keyword-line">
              <span className="muted small">{t('핵심 단어 · 눌러서 빼거나 다시 넣기')}</span>
              {terms.map((term) => (
                <button
                  key={term}
                  type="button"
                  className={`chip-btn mono${off.has(term) ? ' off' : ''}`}
                  aria-pressed={!off.has(term)}
                  title={off.has(term) ? t('빼 둔 단어 · 눌러서 다시 넣기') : t('눌러서 이 단어 빼기')}
                  onClick={() => toggleTerm(term)}
                  // not disabled while recalculating: that would drop the keyboard focus (review 2026-11-02)
                  aria-busy={busy}
                >
                  {term}
                </button>
              ))}
              <form
                className="add-word"
                onSubmit={(e) => {
                  e.preventDefault();
                  addWord();
                }}
              >
                <input value={newWord} onChange={(e) => setNewWord(e.target.value)} placeholder={t('단어 더하기 (영어)')} aria-label={t('추천에 더할 단어')} maxLength={41} />
                <button type="submit" className="ghost" disabled={busy || !newWord.trim()}>
                  {t('더하기')}
                </button>
              </form>
            </div>
            {wordMsg && (
              <p className="warn-text small" role="status">
                {wordMsg}
              </p>
            )}
          </section>

          {skills.length === 0 ? (
            <p className="empty">
              {hiddenRisky > 0 ? (
                <>
                  {t('위험 높음으로 숨긴 ')}{hiddenRisky}{t('개만 있습니다.')}{' '}
                  <button type="button" className="linkish" onClick={() => setShowRisky(true)}>
                    {t('보기')}
                  </button>
                </>
              ) : (
                t('비슷한 스킬을 찾지 못했습니다. README의 단어와 겹치는 스킬이 색인에 없습니다.')
              )}
            </p>
          ) : (
            <>
              <div className="results-toolbar" ref={listRef}>
                <div className="toolbar-left">
                  <span>
                    {t('비슷한 스킬 ')}<b>{skills.length}</b>{t('개 ')}<span className="muted small">{t('· 다운로드 → 스타 순')}</span>
                  </span>
                  {hiddenRisky > 0 && (
                    <button
                      type="button"
                      className="status-chip action"
                      title={t('외부 스크립트 실행·비밀값 접근처럼 위험이 큰 스킬입니다. 상세 화면에서 이유를 확인한 뒤 설치하세요.')}
                      onClick={() => {
                        setShowRisky(true);
                        setPage(1);
                      }}
                    >
                      {t('위험 높음 ')}{hiddenRisky}{t('개 숨김 · 보기')}
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
                      savePageSize(Number(e.target.value));
                    }}
                    aria-label={t('페이지당 개수')}
                  >
                    {[5, 10, 20].map((n) => (
                      <option key={n} value={n}>
                        {n}{t('개씩')}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="results">
                {pageItems.map((m, i) => (
                  <div key={m.item.id}>
                    <ResultCard item={m.item} position={i} href={skillHref(m.item.id)} installed={installedAs(m.item)} onSelect={() => onOpen(m.item)} />
                    <p className="muted small matched-terms">{t('겹친 단어: ')}{m.matchedTerms.join(', ')}</p>
                  </div>
                ))}
              </div>
              {pageCount > 1 && (
                <nav className="pager" aria-label={t('추천 결과 페이지')}>
                  <button type="button" className="ghost" onClick={() => goPage(currentPage - 1)} disabled={currentPage === 1} aria-label={t('이전 페이지')}>
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
                  <button type="button" className="ghost" onClick={() => goPage(currentPage + 1)} disabled={currentPage === pageCount} aria-label={t('다음 페이지')}>
                    <Icon name="back" size={15} className="flip" />
                  </button>
                  <span className="muted small pager-info">
                    {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, skills.length)} / {skills.length}{t('개')}
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

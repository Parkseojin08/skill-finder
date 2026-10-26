import { useEffect, useState } from 'react';
import { ApiError, apiGet, apiSend } from '../api.ts';
import { FolderInput } from '../components/FolderInput.tsx';
import { Icon } from '../components/Icon.tsx';
import { ResultCard } from '../components/ResultCard.tsx';
import { Translated } from '../components/Translated.tsx';
import { TranslationNotice } from '../components/TranslationNotice.tsx';
import type { RecommendResult, ResultItem, SettingsResponse, SkillMatch } from '../types.ts';

/** What to do next, per error status of POST /readme-skills. */
const ERROR_HINT: Record<number, string> = {
  400: '폴더의 전체 경로(예: C:\\Users\\me\\project)를 입력하거나 "폴더 선택"으로 고르세요.',
  404: '이 폴더 바로 아래에 README(README.md 등)가 없습니다. 프로젝트 루트 폴더를 골랐는지 확인하세요.',
  413: 'README가 1MB를 넘어 읽지 않았습니다.',
};

function Terms({ terms }: { terms: string[] }) {
  return (
    <span className="match-terms">
      {terms.map((t) => (
        <code key={t}>{t}</code>
      ))}
    </span>
  );
}

function MatchCard({ m, position, onOpen }: { m: SkillMatch; position: number; onOpen: (item: ResultItem) => void }) {
  return (
    <div className="match">
      <ResultCard item={m.item} position={position} onSelect={() => onOpen(m.item)} />
      <p className="match-why small">
        <span className="muted">겹친 단어</span> <Terms terms={m.matchedTerms} /> <span className="muted">· 일치 점수 {m.score}</span>
      </p>
    </div>
  );
}

export function RecommendPage({ onOpen }: { onOpen: (item: ResultItem) => void }) {
  const [projectPath, setProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RecommendResult | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

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
    } catch (e) {
      setResult(null);
      const status = e instanceof ApiError ? e.status : 0;
      setError({ message: String((e as Error).message ?? e), hint: ERROR_HINT[status] });
    } finally {
      setBusy(false);
    }
  };

  const others = result ? result.candidates.filter((c) => c.item.id !== result.recommended?.item.id) : [];

  return (
    <div className="page recommend-page">
      <h1>README 추천</h1>
      <p className="muted">
        프로젝트 폴더를 고르면 맨 위의 README를 읽고 요약한 뒤, 색인된 스킬 중 이 프로젝트에 맞는 것을 추천합니다. AI 없이 README의 단어로만
        판단합니다.
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
            <p className="muted small mono">{result.readmePath}</p>
          </section>

          <TranslationNotice />

          {result.status === 'no-match' && (
            <p className="empty">맞는 스킬을 찾지 못했습니다. README의 단어와 겹치는 스킬이 색인에 없습니다.</p>
          )}

          {result.status === 'recommended' && result.recommended && (
            <section className="recommend-pick">
              <h2>
                <Icon name="check" size={16} /> 추천 스킬
              </h2>
              <MatchCard m={result.recommended} position={0} onOpen={onOpen} />
            </section>
          )}

          {result.status === 'candidates' && (
            <p className="note">
              하나로 확정하지 못했습니다. 비슷하게 맞는 스킬이 여럿이거나 겹친 단어가 적습니다. 잘 맞는 순서로 보여 줍니다.
            </p>
          )}

          {others.length > 0 && (
            <section className="recommend-list">
              <h2>{result.status === 'recommended' ? '다른 후보' : '후보'}</h2>
              <div className="results">
                {others.map((m, i) => (
                  <MatchCard key={m.item.id} m={m} position={i + 1} onOpen={onOpen} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

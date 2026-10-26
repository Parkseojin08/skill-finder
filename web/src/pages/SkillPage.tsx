import { Icon } from '../components/Icon.tsx';
import { useEffect, useState } from 'react';
import { apiGet } from '../api.ts';
import { BreakdownTable, QualityBadges, RiskBadge, RiskFlags, SourceBadges } from '../components/Badges.tsx';
import { InstallPanel } from '../components/InstallPanel.tsx';
import { Markdown, splitFrontmatter } from '../components/Markdown.tsx';
import { Translated } from '../components/Translated.tsx';
import { TranslationNotice } from '../components/TranslationNotice.tsx';
import { formatAgo, formatBytes, formatCount, METHOD, QUALITY, RISK_FLAGS } from '../labels.ts';
import type { Breakdown, ResultItem, SettingsResponse, SkillDetail } from '../types.ts';

type Tab = 'overview' | 'install' | 'skill' | 'files';

export function SkillPage({ id, item, query, onBack }: { id: string; item: ResultItem | null; query: string; onBack: () => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [file, setFile] = useState<{ path: string; content: string | null; error?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    apiGet<SkillDetail>(`/skills/${encodeURIComponent(id)}`, { q: query || undefined })
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    apiGet<SettingsResponse>('/settings')
      .then((s) => alive && setSettings(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, query]);

  const openFile = (path: string) => {
    setFile({ path, content: null });
    apiGet<{ path: string; content: string }>(`/skills/${encodeURIComponent(id)}/file`, { path })
      .then((r) => setFile({ path, content: r.content }))
      .catch((e) => setFile({ path, content: null, error: String(e.message ?? e) }));
  };

  const name = detail?.name ?? item?.name ?? '';
  const sources = item?.sources ?? detail?.sources ?? [];
  const breakdown: Partial<Breakdown> = { ...(item?.breakdown ?? {}), ...(detail?.partialBreakdown ?? {}) };
  const flags = detail?.riskFlags ?? item?.riskFlags ?? [];
  const quality = detail?.qualityWarnings ?? item?.qualityWarnings ?? [];
  const riskLevel = detail?.riskLevel ?? item?.riskLevel;
  const md = detail?.skillMd ? splitFrontmatter(detail.skillMd) : null;
  const method = detail?.install.method ?? item?.install.method;

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'overview', label: '개요' },
    { key: 'install', label: '설치' },
    { key: 'skill', label: 'SKILL.md' },
    { key: 'files', label: `파일${detail ? ` (${detail.filesTotal})` : ''}` },
  ];

  return (
    <div className="page skill-page">
      <button type="button" className="linkish back" onClick={onBack}>
        <Icon name="back" size={15} /> 검색 결과로
      </button>

      <header className="skill-head">
        <div>
          <h1>{name || '스킬'}</h1>
          {detail?.plugin && (
            <p className="muted small">
              {detail.plugin.marketplace} 마켓플레이스 · {detail.plugin.name} 플러그인
            </p>
          )}
          <div className="badges">
            <SourceBadges sources={sources} />
            {riskLevel && <RiskBadge level={riskLevel} />}
            {method && <span className="badge">{METHOD[method]}</span>}
          </div>
        </div>
        {item && (
          <div className="skill-score" title="검색 결과 기준 점수">
            <span className="big">{Math.round(item.score * 100)}</span>
            <span className="muted small">/ 100</span>
          </div>
        )}
      </header>

      <div className="tabs page-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="warn-box">{error}</p>}
      {!detail && !error && <p className="muted">불러오는 중…</p>}

      {detail && tab === 'overview' && (
        <div className="tab-body">
          <TranslationNotice />
          <section>
            <h2>설명</h2>
            {detail.description || item?.description ? <Translated className="summary" text={detail.description ?? item!.description} /> : <p className="muted">설명 없음</p>}
            {detail.whenToUse && (
              <>
                <h3>언제 쓰나</h3>
                <Translated className="muted" text={detail.whenToUse} />
              </>
            )}
            <div className="meta">
              <span className="stat"><Icon name="download" size={14} /> 설치 {formatCount(item?.installs ?? detail.installs)}</span>
              <span className="stat"><Icon name="star" size={14} /> {formatCount(item?.stars ?? detail.stars)}</span>
              <span className="stat"><Icon name="clock" size={14} /> {formatAgo(detail.lastCommitAt)}</span>
              {detail.license && <span className="stat">{detail.license}</span>}
              {detail.archived && <span className="badge risk-medium">보관된 저장소</span>}
              {detail.url && (
                <a className="stat" href={detail.url} target="_blank" rel="noopener noreferrer">
                  GitHub에서 보기 <Icon name="external" size={13} />
                </a>
              )}
            </div>
          </section>

          <section>
            <h2>점수</h2>
            <BreakdownTable breakdown={breakdown} weights={settings?.settings.weights} />
            <p className="muted small">
              {item
                ? '관련도는 키워드 일치와 검색 순위로, 인기는 이번 검색 결과 안에서 비교해 계산했습니다.'
                : '관련도와 인기는 검색 결과에서 열었을 때만 표시됩니다.'}
            </p>
          </section>

          <section>
            <h2>위험·품질</h2>
            <div className="badges">
              {riskLevel && <RiskBadge level={riskLevel} />}
              <RiskFlags flags={flags} />
              <QualityBadges codes={quality} />
            </div>
            {flags.length + quality.length > 0 ? (
              <ul className="explain">
                {flags.map((f) => (
                  <li key={f}>
                    <b>{RISK_FLAGS[f]?.label ?? f}</b> — {RISK_FLAGS[f]?.meaning ?? ''}
                  </li>
                ))}
                {quality.map((q) => (
                  <li key={q} className="muted">
                    <b>{QUALITY[q]?.label ?? q}</b> — {QUALITY[q]?.meaning ?? ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">발견된 위험 신호나 품질 경고가 없습니다.</p>
            )}
            {detail.plugin?.strictConflict && <p className="warn-box">로드 실패 가능: strict:false 항목과 plugin.json이 모두 구성요소를 선언합니다.</p>}
          </section>

          {detail.plugin && (
            <section>
              <h2>플러그인</h2>
              <p>
                <b>{detail.plugin.id}</b>
              </p>
              {detail.plugin.description && <Translated className="muted" text={detail.plugin.description} />}
              <div className="badges">
                {detail.plugin.hooks && <span className="badge flag">훅</span>}
                {detail.plugin.mcp && <span className="badge flag">MCP 서버</span>}
                {detail.plugin.bin && <span className="badge flag">실행 파일(bin)</span>}
                {detail.plugin.monitors && <span className="badge flag">모니터</span>}
              </div>
              <p className="muted small">이 스킬을 설치하면 아래 스킬 {detail.plugin.skills.length}개가 들어 있는 플러그인 전체가 설치됩니다.</p>
              <ul className="plugin-skills">
                {detail.plugin.skills.map((s) => (
                  <li key={s.id} className={s.id === id ? 'current' : ''}>
                    {s.name}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {detail && tab === 'install' && (
        <div className="tab-body">
          <section>
            <InstallPanel skill={detail} defaultScope={settings?.settings.defaultScope ?? 'user'} defaultProjectPath={settings?.settings.defaultProjectPath ?? ''} />
          </section>
        </div>
      )}

      {detail && tab === 'skill' && (
        <div className="tab-body">
          <section>
            <p className="muted small">SKILL.md는 원문(영어) 그대로 보여 줍니다. 요약은 개요 탭의 설명을 보세요.</p>
            {detail.origin === 'wellknown' && <p className="muted">well-known 출처라 미리보기를 제공하지 않습니다.</p>}
            {detail.skillMdError && <p className="warn-box">{detail.skillMdError}</p>}
            {md?.frontmatter && (
              <details className="frontmatter">
                <summary>frontmatter</summary>
                <pre>{md.frontmatter}</pre>
              </details>
            )}
            {md && <Markdown text={md.body} />}
          </section>
        </div>
      )}

      {detail && tab === 'files' && (
        <div className="tab-body files-layout">
          <section>
            <ul className="file-list">
              {detail.files.map((f) => (
                <li key={f.path}>
                  {f.isText ? (
                    <button type="button" className={`linkish ${file?.path === f.path ? 'current' : ''}`} onClick={() => openFile(f.path)}>
                      {f.path}
                    </button>
                  ) : (
                    <span className="muted" title="텍스트 파일만 열 수 있습니다">
                      {f.path}
                    </span>
                  )}
                  <span className="muted small"> {formatBytes(f.size)}</span>
                </li>
              ))}
              {detail.filesTotal > detail.files.length && <li className="muted small">… 외 {detail.filesTotal - detail.files.length}개</li>}
            </ul>
          </section>
          <section className="file-view">
            {!file && <p className="muted">왼쪽에서 파일을 고르면 원문을 보여 줍니다 (텍스트 파일, 256KB 이하).</p>}
            {file && (
              <>
                <div className="muted small">{file.path}</div>
                {file.error ? <p className="warn-box">{file.error}</p> : file.content == null ? <p className="muted">불러오는 중…</p> : <pre>{file.content}</pre>}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

import { Icon } from '../components/Icon.tsx';
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../api.ts';
import { BreakdownTable, QualityBadges, RiskBadge, RiskFlags, RiskSummary, SourceBadges } from '../components/Badges.tsx';
import { InstallPanel, riskierSiblings, SiblingRiskNote } from '../components/InstallPanel.tsx';
import { CopyButton } from '../components/CopyButton.tsx';
import { ShareMenu } from '../components/ShareMenu.tsx';
import { useInstalled } from '../installed.ts';
import { Markdown, splitFrontmatter } from '../components/Markdown.tsx';
import { Translated } from '../components/Translated.tsx';
import { TranslationNotice } from '../components/TranslationNotice.tsx';
import { HelpTip } from '../components/HelpTip.tsx';
import { FavoriteButton } from '../components/FavoriteButton.tsx';
import { formatAgo, formatBytes, formatCount, HELP, LOW_RISK_NOTE, METHOD, QUALITY, RISK_FLAGS, RISK_RANK } from '../labels.ts';
import type { Breakdown, OpenedFrom, ResultItem, SettingsResponse, SkillDetail } from '../types.ts';
import { t } from '../i18n.ts';

type Tab = 'overview' | 'install' | 'skill' | 'files';

/** What the install button actually fetches (UI debate 2-5): the plugin and its marketplace, or the repo and commit. */
function installTarget(d: SkillDetail): string | null {
  const p = d.install;
  if (p.method === 'plugin') return `${p.pluginId ?? p.pluginName}${p.marketplace ? t(' (마켓플레이스 {0})', p.marketplace.repo) : ''}`;
  if (p.method === 'skills-cli') return `${p.repo}${p.pinnedRef ? ` @ ${p.pinnedRef.slice(0, 7)}` : ''}`;
  return d.repo;
}

export function SkillPage({
  id,
  item,
  query,
  from,
  backLabel,
  onBack,
  onOpenSkill,
}: {
  id: string;
  item: ResultItem | null;
  query: string;
  from?: OpenedFrom;
  /** Names the screen it was opened from ("검색 결과로", "설치됨으로"). */
  backLabel: string;
  onBack: () => void;
  /** Another skill (one in the same plugin). */
  onOpenSkill: (id: string) => void;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  // the tab is in the address (?tab=install), so a reload or a copied address opens the same one (review 2026-11-02)
  const [tab, setTabState] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'install' || t === 'skill' || t === 'files' ? t : 'overview';
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    const p = new URLSearchParams(window.location.search);
    if (t === 'overview') p.delete('tab');
    else p.set('tab', t);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${p}`);
  };
  const [file, setFile] = useState<{ path: string; content: string | null; error?: string } | null>(null);
  /** The file asked for last: an earlier, slower answer must not replace it. */
  const fileAsked = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    apiGet<SkillDetail>(`/skills/${encodeURIComponent(id)}`, {
      q: query || undefined,
      sid: from?.sid,
      pos: from ? String(from.pos) : undefined,
      page: from ? String(from.page) : undefined,
      prov: from?.provisional ? '1' : undefined,
    })
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    apiGet<SettingsResponse>('/settings')
      .then((s) => alive && setSettings(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, query, attempt]);

  const openFile = (path: string) => {
    fileAsked.current = path;
    setFile({ path, content: null });
    apiGet<{ path: string; content: string }>(`/skills/${encodeURIComponent(id)}/file`, { path })
      .then((r) => fileAsked.current === path && setFile({ path, content: r.content }))
      .catch((e) => fileAsked.current === path && setFile({ path, content: null, error: String(e.message ?? e) }));
  };

  const name = detail?.name ?? item?.name ?? '';
  const installedAs = useInstalled();
  useEffect(() => {
    if (name) document.title = `${name} · Skill Finder`;
  }, [name]);
  // the skill's own sources once loaded. Its skills.sh page: the search's link when it came from there (skills.sh's
  // own id), else the detail's (built from the folder name); one badge, not both
  const cardSkillsSh = (item?.sources ?? []).filter((s) => s.kind === 'skillssh');
  const sources = detail ? [...detail.sources.filter((s) => s.kind !== 'skillssh' || !cardSkillsSh.length), ...cardSkillsSh] : (item?.sources ?? []);
  const breakdown: Partial<Breakdown> = { ...(item?.breakdown ?? {}), ...(detail?.partialBreakdown ?? {}) };
  const flags = detail?.riskFlags ?? item?.riskFlags ?? [];
  const quality = detail?.qualityWarnings ?? item?.qualityWarnings ?? [];
  const riskLevel = detail?.riskLevel ?? item?.riskLevel;
  const md = detail?.skillMd ? splitFrontmatter(detail.skillMd) : null;
  const method = detail?.install.method ?? item?.install.method;

  const skillsSh = detail ? sources.find((s) => s.kind === 'skillssh') : undefined;
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'overview', label: t('개요') },
    { key: 'install', label: t('설치') },
    { key: 'skill', label: 'SKILL.md' },
    { key: 'files', label: t('파일{0}', detail ? ` (${detail.filesTotal})` : '') },
  ];

  return (
    <div className="page skill-page">
      <button type="button" className="linkish back" onClick={onBack}>
        <Icon name="back" size={15} /> {backLabel}
      </button>

      <header className="skill-head">
        <div>
          <h1>{name || t('스킬')}</h1>
          {detail?.plugin && (
            <p className="muted small">
              {detail.plugin.marketplace}{t(' 마켓플레이스 · ')}{detail.plugin.name}{t(' 플러그인')}
            </p>
          )}
          {detail && installedAs(detail) && (
            <p className="state-on small">
              <Icon name="check" size={13} />{t(' 이 PC에 설치됨 · ')}{installedAs(detail)}
            </p>
          )}
          {detail && installTarget(detail) && (
            <p className="muted small">
              {t('설치 대상: ')}<span className="mono">{installTarget(detail)}</span>
            </p>
          )}
          <div className="badges">
            <SourceBadges sources={sources} />
            {riskLevel && <RiskSummary level={riskLevel} flags={flags} />}
            {method && <span className="pill">{METHOD[method]}</span>}
          </div>
        </div>
        <div className="skill-side">
          {item && (
            <div className="skill-score" title={t('검색 결과 기준 점수')}>
              <span className="big">{Math.round(item.score * 100)}</span>
              <span className="muted small">/ 100</span>
            </div>
          )}
          {detail && tab !== 'install' && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setTab('install');
                // This button unmounts on the install tab; keep keyboard focus on the tab it opened.
                requestAnimationFrame(() => document.getElementById('tab-install')?.focus());
              }}
            >
              <Icon name="download" size={16} />
              {detail.install.method === 'manual-only' ? t('설치 방법 보기') : t('설치하기')}
            </button>
          )}
        </div>
      </header>

      <div
        className="tabs page-tabs"
        role="tablist"
        aria-label={t('스킬 정보')}
        // arrow keys move between tabs, as screen readers expect of a tab list (review 2026-11-02)
        onKeyDown={(e) => {
          const at = tabs.findIndex((t) => t.key === tab);
          const next = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
          if (next === null) return;
          e.preventDefault();
          const t = tabs[(next + tabs.length) % tabs.length];
          setTab(t.key);
          document.getElementById(`tab-${t.key}`)?.focus();
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            id={`tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            aria-controls="tab-panel"
            tabIndex={tab === t.key ? 0 : -1}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="warn-box" role="alert">
          <p>{error}</p>
          <div className="row">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setError(null);
                setAttempt((a) => a + 1);
              }}
            >
              {t('다시 시도')}
            </button>
            <button type="button" className="ghost" onClick={onBack}>
              {backLabel}
            </button>
          </div>
        </div>
      )}
      {!detail && !error && <p className="muted">{t('불러오는 중…')}</p>}

      {detail && tab === 'overview' && (
        <div className="tab-body" role="tabpanel" id="tab-panel" aria-labelledby="tab-overview">
          <TranslationNotice />
          <section>
            <h2>{t('설명')}</h2>
            {detail.description || item?.description ? <Translated className="summary" text={detail.description ?? item!.description} /> : <p className="muted">{t('설명 없음')}</p>}
            {detail.whenToUse && (
              <>
                <h3>{t('언제 쓰나')}</h3>
                <Translated className="muted" text={detail.whenToUse} />
              </>
            )}
            <div className="meta">
              <span className="stat"><Icon name="download" size={14} />{t(' 설치 ')}{formatCount(item?.installs ?? detail.installs)}</span>
              <span className="stat"><Icon name="star" size={14} /> {formatCount(item?.stars ?? detail.stars)}</span>
              <span className="stat"><Icon name="clock" size={14} /> {formatAgo(detail.lastCommitAt)}</span>
              {detail.license && <span className="stat">{detail.license}</span>}
              <span
                className="stat"
                title={t('설치하면 이름과 설명이 매 요청마다 Claude의 컨텍스트에 들어가고, 쓸 때는 SKILL.md 전체를 읽습니다. 글자 수로 센 추정치입니다.')}
              >
                {t('컨텍스트 매 턴 약 ')}{detail.tokens.perTurn.toLocaleString()}
                {detail.tokens.onUse != null && t(' · 쓸 때 약 {0}', detail.tokens.onUse.toLocaleString())}{t(' 토큰')}
              </span>
              {detail.archived && <span className="badge risk-medium">{t('보관된 저장소')}</span>}
              {detail.url && (
                <a className="stat" href={detail.url} target="_blank" rel="noopener noreferrer">
                  {t('GitHub에서 보기 ')}<Icon name="external" size={13} />
                </a>
              )}
              {skillsSh && (
                // its page shows Gen·Socket·Snyk audits; the app sends nothing there (review 2026-11-02)
                <a className="stat" href={skillsSh.url} target="_blank" rel="noopener noreferrer" title={t('skills.sh 페이지의 보안 감사(Gen·Socket·Snyk) 결과를 엽니다. 외부 사이트입니다.')}>
                  {t('skills.sh 보안 감사 ')}<Icon name="external" size={13} />
                </a>
              )}
              <ShareMenu detail={detail} />
              <FavoriteButton id={detail.id} name={detail.name} className="stat" />
            </div>
          </section>

          {detail.plugin && (
            <section>
              <h2>{t('플러그인')}</h2>
              <p>
                <b>{detail.plugin.id}</b>
              </p>
              {detail.plugin.description && <Translated className="muted" text={detail.plugin.description} />}
              <div className="badges">
                {detail.plugin.hooks && <span className="badge flag">{t('훅')}</span>}
                {detail.plugin.mcp && <span className="badge flag">{t('MCP 서버')}</span>}
                {detail.plugin.bin && <span className="badge flag">{t('실행 파일(bin)')}</span>}
                {detail.plugin.monitors && <span className="badge flag">{t('모니터')}</span>}
              </div>
              <p className="muted small">{t('이 스킬을 설치하면 아래 스킬 ')}{detail.plugin.skills.length}{t('개가 들어 있는 플러그인 전체가 설치됩니다.')}</p>
              <SiblingRiskNote skills={riskierSiblings(detail)} here />
              <ul className="plugin-skills">
                {detail.plugin.skills.map((s) => (
                  <li key={s.id} className={s.id === id ? 'current' : ''}>
                    {s.id === id ? (
                      s.name
                    ) : (
                      <button type="button" className="linkish" onClick={() => onOpenSkill(s.id)}>
                        {s.name}
                      </button>
                    )}
                    {RISK_RANK[s.riskLevel] > RISK_RANK[detail.riskLevel] && (
                      <>
                        {' '}
                        <RiskBadge level={s.riskLevel} />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2>
              {t('위험·품질')}
              <HelpTip label={t('위험 등급')} text={HELP.risk} />
            </h2>
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
              <p className="muted small">{t('발견된 위험 신호나 품질 경고가 없습니다.')}</p>
            )}
            {riskLevel === 'low' && <p className="muted small">{LOW_RISK_NOTE}</p>}
            {detail.plugin?.strictConflict && <p className="warn-box">{t('로드 실패 가능: strict:false 항목과 plugin.json이 모두 구성요소를 선언합니다.')}</p>}
          </section>

          <section>
            <h2>
              {t('점수')}
              <HelpTip label={t('점수')} text={HELP.score} />
            </h2>
            <BreakdownTable breakdown={breakdown} />
            <p className="muted small">
              {item
                ? t('관련도는 키워드 일치와 검색 순위로, 인기는 이번 검색 결과 안에서 비교해 계산했습니다.')
                : t('관련도와 인기는 검색 결과에서 열었을 때만 표시됩니다.')}
            </p>
          </section>
        </div>
      )}

      {detail && tab === 'install' && (
        <div className="tab-body" role="tabpanel" id="tab-panel" aria-labelledby="tab-install">
          <section>
            <InstallPanel skill={detail} defaultScope={settings?.settings.defaultScope ?? 'user'} defaultProjectPath={settings?.settings.defaultProjectPath ?? ''} />
          </section>
        </div>
      )}

      {detail && tab === 'skill' && (
        <div className="tab-body" role="tabpanel" id="tab-panel" aria-labelledby="tab-skill">
          <section>
            <p className="muted small">{t('SKILL.md는 원문(영어) 그대로 보여 줍니다. 요약은 개요 탭의 설명을 보세요.')}</p>
            {detail.origin === 'wellknown' && <p className="muted">{t('well-known 출처라 미리보기를 제공하지 않습니다.')}</p>}
            {detail.skillMdError && <p className="warn-box">{detail.skillMdError}</p>}
            {md?.frontmatter && (
              <details className="frontmatter">
                <summary>frontmatter</summary>
                <pre>{md.frontmatter}</pre>
              </details>
            )}
            {md && (
              <Markdown
                text={md.body}
                onRelativeLink={(path) => {
                  if (detail.files.some((f) => f.path === path && f.isText)) {
                    setTab('files');
                    openFile(path);
                  } else if (detail.url) {
                    window.open(`${detail.url}/${path}`, '_blank', 'noopener,noreferrer');
                  }
                }}
              />
            )}
          </section>
        </div>
      )}

      {detail && tab === 'files' && (
        <div className="tab-body files-layout" role="tabpanel" id="tab-panel" aria-labelledby="tab-files">
          <section>
            <ul className="file-list">
              {detail.files.map((f) => (
                <li key={f.path}>
                  {f.isText ? (
                    <button type="button" className={`linkish ${file?.path === f.path ? 'current' : ''}`} onClick={() => openFile(f.path)}>
                      {f.path}
                    </button>
                  ) : (
                    <span className="muted" title={t('텍스트 파일만 열 수 있습니다')}>
                      {f.path}
                    </span>
                  )}
                  <span className="muted small"> {formatBytes(f.size)}</span>
                </li>
              ))}
              {detail.filesTotal > detail.files.length && <li className="muted small">{t('… 외 ')}{detail.filesTotal - detail.files.length}{t('개')}</li>}
            </ul>
          </section>
          <section className="file-view">
            {!file && <p className="muted">{t('왼쪽에서 파일을 고르면 원문을 보여 줍니다 (텍스트 파일, 256KB 이하).')}</p>}
            {file && (
              <>
                <div className="muted small file-head">
                  {file.path}
                  {file.content != null && <CopyButton text={file.content} label={t('원문 복사')} className="linkish small" />}
                </div>
                {file.error ? <p className="warn-box">{file.error}</p> : file.content == null ? <p className="muted">{t('불러오는 중…')}</p> : <pre>{file.content}</pre>}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

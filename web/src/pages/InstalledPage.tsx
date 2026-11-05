import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { FolderInput } from '../components/FolderInput.tsx';
import { forgetInstalled } from '../installed.ts';
import { TRANSLATE_TO, useKorean } from '../translate.ts';
import { RiskBadge, RiskSummary } from '../components/Badges.tsx';
import { ActiveFacets, FacetPanel, facetCount, matchFacets, NO_FACETS, type Facets } from '../components/FacetPanel.tsx';
import { Icon } from '../components/Icon.tsx';
import { CATEGORY, RISK_LEVEL, TRUST } from '../labels.ts';
import { readPageSize, savePageSize } from '../lib/prefs.ts';
import type { InstallChange, InstalledResponse, SettingsResponse } from '../types.ts';
import { installedMarkdown, saveFile } from '../lib/exportList.ts';
import { InstallHistory } from '../components/InstallHistory.tsx';
import { TeamPreset } from '../components/TeamPreset.tsx';
import { serverText, t } from '../i18n.ts';
import { tj } from '../i18nNodes.tsx';

/** How an install compares with the index (UI debate 3-3); shown only, nothing is updated from here. */
const CHANGE: Record<InstallChange, string | null> = {
  same: null,
  changed: t('색인된 내용과 다름 (새 버전이 있거나 고친 사본)'),
  unknown: null,
};

type Plugin = InstalledResponse['plugins'][number];
/**
 * What the server adds to each skill row (feature review F9 stage 1, P8): the agents reading its folder, whether it
 * is in Claude Code's folder (the only one the app removes from, D#0763), and the files besides SKILL.md with a signal.
 */
type AgentFields = {
  agents?: Array<{ id: string; name: string }>;
  removable?: boolean;
  fileFindings?: Array<{ path: string; flags: string[] }>;
};
type Skill = InstalledResponse['skills'][number] & AgentFields;
/** A row of the skills table: installed directly, or brought in by a plugin (removed with it). */
type Row = (Skill & { plugin?: undefined }) | (InstalledResponse['pluginSkills'][number] & AgentFields);

const CLAUDE_CODE = 'claude-code';
/** Rows from before the agents field are Claude Code's (the only folder read then). */
const agentsOf = (r: Row) => r.agents ?? [{ id: CLAUDE_CODE, name: 'Claude Code' }];
const forClaude = (r: Row) => agentsOf(r).some((a) => a.id === CLAUDE_CODE);
/** The agents of server/src/install/agents.ts, in its order. */
const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  'github-copilot': 'GitHub Copilot',
  opencode: 'OpenCode',
};

/**
 * The table's own side filters above the search's provider/category/method ones (user request 2026-11-04): OR within
 * a group, AND across groups, like FacetPanel. A row has several values when several agents read its folder.
 */
type RowFilters = { agent: string[]; scope: string[]; source: string[]; risk: string[]; indexed: string[] };
type RowGroup = keyof RowFilters;
const NO_ROW_FILTERS: RowFilters = { agent: [], scope: [], source: [], risk: [], indexed: [] };
const ROW_VALUE: Record<RowGroup, (r: Row) => string[]> = {
  agent: (r) => agentsOf(r).map((a) => a.id),
  scope: (r) => [r.scope],
  source: (r) => [r.plugin ? 'plugin' : 'direct'],
  risk: (r) => [r.risk.level],
  indexed: (r) => [r.skillId ? 'yes' : 'no'],
};
const ROW_GROUPS = Object.keys(ROW_VALUE) as RowGroup[];
const ROW_OPTIONS: Record<RowGroup, Record<string, string>> = {
  agent: AGENT_LABEL,
  scope: { project: t('이 프로젝트'), user: t('개인 (모든 프로젝트)') },
  source: { direct: t('직접 설치'), plugin: t('플러그인에 포함') },
  risk: RISK_LEVEL,
  indexed: { yes: t('색인에 있음'), no: t('색인에 없음') },
};
const ROW_TITLE: Record<RowGroup, string> = { agent: t('에이전트'), scope: t('범위'), source: t('설치 경로'), risk: t('위험'), indexed: t('색인') };
const matchRow = (r: Row, f: RowFilters, skip?: RowGroup) =>
  ROW_GROUPS.every((g) => g === skip || f[g].length === 0 || ROW_VALUE[g](r).some((v) => f[g].includes(v)));
type RemoveRequest = {
  key: string;
  label: string;
  detail: string;
  body: { kind: 'plugin' | 'skill'; id: string; scope: string; projectPath?: string };
};

const SCOPE_LABEL: Record<string, string> = { user: t('개인'), project: t('프로젝트'), local: t('로컬'), synced: t('앱 동기화') };

function Description({ text }: { text: string }) {
  const { ko } = useKorean(text);
  return (
    <span title={ko ? text : undefined} lang={ko ? (TRANSLATE_TO ?? 'en') : 'en'}>
      {ko ?? text}
    </span>
  );
}

/** A project folder's chip: its name, or with its parent when another chip has the same name. */
function chipLabel(path: string, all: string[]): string {
  const parts = (p: string) => p.split(/[\\/]/).filter(Boolean);
  const name = parts(path).pop() ?? path;
  const twin = all.some((o) => o !== path && (parts(o).pop() ?? '').toLowerCase() === name.toLowerCase());
  return twin ? parts(path).slice(-2).join('\\') : name;
}

/** `onOpenSkill`'s `project`: the folder listed, where installing from the skill page starts (peer request 2026-11-04). */
export function InstalledPage({ onOpenSkill }: { onOpenSkill: (id: string, project?: string) => void }) {
  const [projectPath, setProjectPath] = useState('');
  const [data, setData] = useState<InstalledResponse | null>(null);
  /** The folder `data` lists (the input may already hold another one). */
  const [loadedPath, setLoadedPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<RemoveRequest | null>(null);
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const [rowFilters, setRowFilters] = useState<RowFilters>(NO_ROW_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readPageSize);
  const tableRef = useRef<HTMLDivElement>(null);

  // Only the latest request may update the screen: typing a path fires one request per pause, and an
  // older answer for a half-typed path ("…skill finde") arriving last used to show "스킬 (0)".
  const seq = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback((path: string) => {
    const id = ++seq.current;
    // the folder goes in the address, so coming back from a skill page shows the same list (review 2026-11-02)
    if (window.location.pathname === '/installed') {
      const p = path.trim();
      window.history.replaceState(window.history.state, '', p ? `/installed?project=${encodeURIComponent(p)}` : '/installed');
    }
    setLoading(true);
    setError(null);
    apiGet<InstalledResponse>('/installed', { projectPath: path.trim() || undefined })
      .then((d) => {
        if (id !== seq.current) return;
        setData(d);
        setLoadedPath(path.trim());
        setPage(1);
      })
      .catch((e) => id === seq.current && setError(String(e.message ?? e)))
      .finally(() => id === seq.current && setLoading(false));
  }, []);

  useEffect(() => {
    apiGet<SettingsResponse>('/settings')
      .then((s) => {
        // Don't overwrite a folder the user already typed or picked while settings were loading.
        setProjectPath((cur) => {
          const path = cur || new URLSearchParams(window.location.search).get('project') || s.settings.defaultProjectPath;
          load(path);
          return path;
        });
      })
      .catch(() => load(''));
  }, [load]);

  const remove = async ({ key, label, body }: RemoveRequest) => {
    setConfirming(null);
    setBusy(key);
    setMsg(null);
    try {
      const r = await apiSend<{ ok: boolean; message: string }>('POST', '/uninstall', body);
      forgetInstalled();
      setMsg({ ok: true, text: `${label}: ${serverText(r.message)}` });
      load(projectPath);
    } catch (e) {
      setMsg({ ok: false, text: `${label}: ${String((e as Error).message ?? e)}` });
    } finally {
      setBusy(null);
    }
  };

  const removePlugin = (p: Plugin) =>
    setConfirming({
      key: `p:${p.id}:${p.scope}:${p.projectPath ?? ''}`,
      label: t('플러그인 {0}', p.id),
      detail: p.scope === 'user' ? t('개인 범위(모든 프로젝트)에서 제거합니다.') : t('{0} 프로젝트에서 제거합니다.', p.projectPath ?? projectPath),
      body: { kind: 'plugin', id: p.id, scope: p.scope, projectPath: p.scope === 'user' ? undefined : (p.projectPath ?? projectPath) },
    });

  const removeSkill = (s: Skill) =>
    setConfirming({
      key: `s:${s.path}`,
      label: t('스킬 {0}', s.name),
      detail: t('{0} 폴더를 지웁니다.', s.path),
      body: { kind: 'skill', id: s.folder, scope: s.scope, projectPath: s.scope === 'user' ? undefined : projectPath },
    });

  // Plugins this app can remove vs. ones synced from the Claude app account (managed there).
  const managed = (data?.plugins ?? []).filter((p) => p.scope === 'user' || p.scope === 'project' || p.scope === 'local');
  const synced = (data?.plugins ?? []).filter((p) => !managed.includes(p));
  // said once above each table instead of on every row (project review 2026-11-02)
  const unindexedPlugins = managed.filter((p) => !p.topRisk).length;

  // Every skill Claude Code loads here, plugins' included (user report 2026-11-04), narrowed by the side filters and
  // shown a page at a time. Rows not in the index have no provider, category or method: those filters leave them out.
  const rows: Row[] = [...((data?.skills ?? []) as Skill[]), ...(data?.pluginSkills ?? [])];
  const otherAgentRows = rows.filter((r) => !forClaude(r)).length;
  const itemOf = (r: Row) => (r.skillId ? (data?.items[r.skillId] ?? null) : null);
  const facetOk = (r: Row) => {
    if (facetCount(facets) === 0) return true;
    const it = itemOf(r);
    return !!it && matchFacets(it, facets);
  };
  const shownRows = rows.filter((r) => matchRow(r, rowFilters) && facetOk(r));
  const unindexedSkills = rows.filter((r) => !r.skillId).length;
  // a plugin that is off loads none of its skills, and Claude Code does not read the other agents' folders
  const perTurn = rows.filter((r) => r.plugin?.enabled !== false && forClaude(r)).reduce((n, r) => n + r.tokens.perTurn, 0);
  const pageCount = Math.max(1, Math.ceil(shownRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = shownRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const goPage = (p: number) => {
    setPage(Math.min(Math.max(1, p), pageCount));
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const changeFacets = (f: Facets) => {
    setFacets(f);
    setPage(1);
  };
  const toggleRowFilter = (g: RowGroup, v: string) => {
    setRowFilters((f) => ({ ...f, [g]: f[g].includes(v) ? f[g].filter((x) => x !== v) : [...f[g], v] }));
    setPage(1);
  };
  const resetFilters = () => {
    setFacets(NO_FACETS);
    setRowFilters(NO_ROW_FILTERS);
    setPage(1);
  };
  const rowGroups = (
    <>
      {ROW_GROUPS.map((g) => {
        const counts = new Map<string, number>();
        for (const r of rows) if (matchRow(r, rowFilters, g) && facetOk(r)) for (const v of ROW_VALUE[g](r)) counts.set(v, (counts.get(v) ?? 0) + 1);
        return (
          <fieldset key={g} className="facet">
            <legend>{ROW_TITLE[g]}</legend>
            {Object.entries(ROW_OPTIONS[g]).map(([k, label]) => (
              <label key={k} className="facet-opt">
                <input type="checkbox" checked={rowFilters[g].includes(k)} disabled={!counts.get(k) && !rowFilters[g].includes(k)} onChange={() => toggleRowFilter(g, k)} />
                <span className="facet-label">{label}</span>
                <span className="facet-count">{counts.get(k) ?? 0}</span>
              </label>
            ))}
          </fieldset>
        );
      })}
    </>
  );
  const rowFiltersOn = ROW_GROUPS.flatMap((g) => rowFilters[g].map((k) => [g, k] as const));

  return (
    <div className="page">
      <h1>{t('설치됨')}</h1>
      <p className="muted">{t('설치한 플러그인과 스킬을 확인하고 삭제할 수 있습니다. 프로젝트 폴더를 고르면 그 프로젝트에 설치된 스킬과 플러그인(안에 든 스킬 포함)이 함께 보입니다.')}</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          load(projectPath);
        }}
      >
        <FolderInput
          value={projectPath}
          onChange={(p) => {
            setProjectPath(p);
            // typing: load after a pause, not on every keystroke
            clearTimeout(typingTimer.current);
            typingTimer.current = setTimeout(() => load(p), 400);
          }}
          onPick={(p) => {
            clearTimeout(typingTimer.current);
            load(p);
          }}
          placeholder={t('프로젝트 폴더 (비우면 개인 범위만)')}
        />
        <button type="submit" disabled={loading}>
          {loading ? t('불러오는 중…') : t('새로 고침')}
        </button>
        {data && (
          <button type="button" className="ghost" onClick={() => saveFile(`skill-finder-installed-${new Date().toISOString().slice(0, 10)}.md`, installedMarkdown(data, projectPath.trim()), 'text/markdown')}>
            {t('목록 내보내기')}
          </button>
        )}
      </form>
      {(data?.projects.length ?? 0) > 0 && (
        <div className="examples">
          <span className="muted small">{t('앱으로 설치한 프로젝트:')}</span>
          {data!.projects.map((p) => (
            <button
              key={p}
              type="button"
              className={`chip-btn mono${p.toLowerCase() === projectPath.trim().toLowerCase() ? ' current' : ''}`}
              title={p}
              onClick={() => {
                clearTimeout(typingTimer.current);
                setProjectPath(p);
                load(p);
              }}
            >
              {chipLabel(p, data!.projects)}
            </button>
          ))}
        </div>
      )}
      <div role="status">{msg && <p className={msg.ok ? 'ok-box' : 'warn-box'}>{msg.text}</p>}</div>
      {confirming && (
        <ConfirmDialog title={t('{0} 삭제', confirming.label)} confirmLabel={t('삭제')} danger onConfirm={() => remove(confirming)} onCancel={() => setConfirming(null)}>
          <p>{confirming.detail}</p>
          <p className="muted small">{t('되돌릴 수 없습니다. 다시 쓰려면 다시 설치해야 합니다.')}</p>
        </ConfirmDialog>
      )}
      {error && <p className="warn-box">{error}</p>}
      {data && (
        <>
          <section>
            <h2>{t('플러그인 ({0})', managed.length)}</h2>
            {data.pluginError && <p className="warn-box">{data.pluginError}</p>}
            <p className="muted small">
              {t('플러그인을 지우면 그 안의 스킬·훅·MCP 서버가 함께 제거됩니다. 다음 Claude Code 세션부터 반영됩니다.')}
              {unindexedPlugins > 0 && t(' 색인에 없는 플러그인 {0}개는 위험 등급을 알 수 없습니다.', unindexedPlugins)}
            </p>
            {managed.length === 0 ? (
              !data.pluginError && <p className="muted small">{t('설치한 플러그인이 없습니다.')}</p>
            ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('플러그인')}</th>
                  <th>{t('버전')}</th>
                  <th>{t('범위')}</th>
                  <th>{t('상태')}</th>
                  <th>{t('위험')}</th>
                  <th>
                    <span className="sr-only">{t('작업')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {managed.map((p) => {
                  const key = `p:${p.id}:${p.scope}:${p.projectPath ?? ''}`;
                  return (
                    <tr key={key}>
                      <td>
                        <b className="mono">{p.id}</b>
                        {p.projectPath && <div className="muted small">{p.projectPath}</div>}
                        {p.skills.length > 0 && (
                          <details className="plugin-skills">
                            <summary className="muted small">{t('스킬 {0}개', p.skills.length)}</summary>
                            <ul>
                              {p.skills.map((s) => (
                                <li key={s.id}>
                                  <button type="button" className="linkish mono" onClick={() => onOpenSkill(s.id, loadedPath || undefined)}>
                                    {s.name}
                                  </button>{' '}
                                  <RiskBadge level={s.riskLevel} />
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      <td>{p.version ?? '–'}</td>
                      <td>{SCOPE_LABEL[p.scope] ?? p.scope}</td>
                      <td>
                        <span className={p.enabled ? 'state-on' : 'muted'}>{p.enabled == null ? '–' : p.enabled ? t('켜짐') : t('꺼짐')}</span>
                        {p.enabledWhere && <div className="muted small">{p.scope === 'user' ? t('모든 프로젝트') : t('해당 프로젝트에서')}</div>}
                      </td>
                      <td>
                        {p.topRisk ? (
                          <>
                            <RiskBadge level={p.topRisk} />
                            <div className="muted small">{t('안의 스킬 중 가장 높은 등급')}</div>
                          </>
                        ) : (
                          <span className="muted small">–</span>
                        )}
                        {p.change === 'changed' && <div className="warn-text small">{t('설치된 커밋이 색인한 커밋과 다름')}</div>}
                      </td>
                      <td className="actions">
                        <button type="button" className="ghost danger" disabled={busy !== null} onClick={() => removePlugin(p)} aria-label={busy === key ? t('{0} 삭제 중', p.id) : t('{0} 삭제', p.id)} aria-busy={busy === key}>
                          {busy === key ? t('삭제 중…') : t('삭제')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            )}
            {synced.length > 0 && (
              <details className="synced">
                <summary>
                  {tj('Claude 앱 계정에서 동기화된 플러그인 {0}개 {1}', synced.length, <span className="muted small">{t('· 앱 설정에서 관리')}</span>)}
                </summary>
                <ul className="synced-list">
                  {synced.map((p) => (
                    <li key={`${p.id}:${p.scope}`}>
                      <span className="mono">{p.id.replace(/@synced$/, '')}</span>
                      <span className="muted small">{p.version ?? ''}</span>
                      <span className={p.enabled ? 'state-on small' : 'muted small'}>{p.enabled == null ? '–' : p.enabled ? t('켜짐') : t('꺼짐')}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
          <section>
            <h2>{t('스킬 ({0})', rows.length)}</h2>
            {rows.length > 0 && (
              <p className="muted small" title={t('설치된 스킬마다 이름과 설명이 매 요청에 들어갑니다. 글자 수로 센 추정치입니다.')}>
                {t('이 스킬들이 매 요청에 차지하는 컨텍스트: 약 {0} 토큰(이름·설명)', perTurn.toLocaleString())}
              </p>
            )}
            {unindexedSkills > 0 && (
              <p className="muted small">
                {t('색인에 없는 스킬 {0}개(앱 밖에서 설치했거나 아직 모으지 않은 스킬)는 상세 화면이 없고, 설치된 파일에 지금 규칙을 돌린 위험 등급만 보입니다.', unindexedSkills)}
              </p>
            )}
            {otherAgentRows > 0 && (
              <p className="muted small">
                {t('다른 에이전트(Codex·Cursor·Gemini CLI·GitHub Copilot·OpenCode) 폴더의 스킬 {0}개도 함께 보입니다. 보기만 하고, 이 앱에서 지우지는 않습니다.', otherAgentRows)}
              </p>
            )}
            {rows.length === 0 ? (
              <p className="muted small">{t('설치된 스킬이 없습니다.')}</p>
            ) : (
              <div className="results-layout">
                <FacetPanel
                  items={rows.filter((r) => matchRow(r, rowFilters)).flatMap((r) => itemOf(r) ?? [])}
                  value={facets}
                  onChange={changeFacets}
                  extra={{ node: rowGroups, active: rowFiltersOn.length, reset: () => setRowFilters(NO_ROW_FILTERS) }}
                />
                <div className="results-main">
                  <div className="results-toolbar" ref={tableRef}>
                    <div className="toolbar-left">
                      <span className="muted small">{t('{0}개 중 {1}개', rows.length, shownRows.length)}</span>
                      {rowFiltersOn.map(([g, k]) => (
                        <button key={`${g}:${k}`} type="button" className="status-chip action" aria-label={t('필터 {0} 끄기', ROW_OPTIONS[g][k])} onClick={() => toggleRowFilter(g, k)}>
                          {t('필터 {0}', ROW_OPTIONS[g][k])} ×
                        </button>
                      ))}
                      <ActiveFacets value={facets} onChange={changeFacets} />
                    </div>
                    <div className="toolbar-right">
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
                            {t('{0}개씩', n)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {shownRows.length === 0 ? (
                    <p className="empty">
                      {t('조건에 맞는 스킬이 없습니다.')}{' '}
                      <button type="button" className="linkish" onClick={resetFilters}>
                        {t('필터 초기화')}
                      </button>
                    </p>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('이름')}</th>
                          <th>{t('에이전트')}</th>
                          <th>{t('범위')}</th>
                          <th>{t('설명')}</th>
                          <th>{t('위험')}</th>
                          <th>
                            <span className="sr-only">{t('작업')}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((s) => {
                          const key = `s:${s.path}`;
                          const item = itemOf(s);
                          return (
                            <tr key={key}>
                              <td>
                                {s.skillId ? (
                                  <button type="button" className="linkish mono" onClick={() => onOpenSkill(s.skillId!, loadedPath || undefined)}>
                                    {s.name}
                                  </button>
                                ) : (
                                  <b className="mono">{s.name}</b>
                                )}
                                <div className="muted small">{s.path}</div>
                                {/* what the index knows of it: who stands behind it and its categories */}
                                {item && (
                                  <div className="installed-index muted small">
                                    {TRUST[item.trust]?.label ?? item.trust}
                                    {item.categories
                                      .filter((c) => c !== 'other')
                                      .map((c) => (
                                        <span key={c} className="cat-tag">
                                          #{CATEGORY[c] ?? c}
                                        </span>
                                      ))}
                                  </div>
                                )}
                              </td>
                              <td className="small">{agentsOf(s).map((a) => AGENT_LABEL[a.id] ?? a.name).join(', ')}</td>
                              <td>
                                {s.scope === 'user' ? t('개인') : t('프로젝트')}
                                {s.plugin && (
                                  <div className="muted small" title={t('플러그인 {0}에 들어 있는 스킬입니다. 플러그인을 지우면 함께 지워집니다.', s.plugin.id)}>
                                    {t('플러그인 {0}', s.plugin.id.replace(/@.*$/, ''))}
                                    {s.plugin.enabled === false && ` · ${t('꺼짐')}`}
                                  </div>
                                )}
                              </td>
                              <td className="small">
                                <Description text={s.description} />
                              </td>
                              <td>
                                {/* the current rules run on the installed files, wherever they came from */}
                                <RiskSummary level={s.risk.level} flags={s.risk.flags} />
                                {s.installedRisk && s.installedRisk !== s.risk.level && <div className="muted small">{t('설치할 때는 {0}', RISK_LEVEL[s.installedRisk])}</div>}
                                {CHANGE[s.change] && <div className="warn-text small">{CHANGE[s.change]}</div>}
                                {(s.fileFindings?.length ?? 0) > 0 && (
                                  <div className="muted small mono" title={s.fileFindings!.map((f) => `${f.path}: ${f.flags.join(', ')}`).join('\n')}>
                                    {t('파일에서 찾음: {0}', s.fileFindings!.map((f) => f.path).join(', '))}
                                  </div>
                                )}
                              </td>
                              <td className="actions">
                                {/* a plugin's skill goes with the plugin (its row above); other agents' folders are shown only */}
                                {!s.plugin && s.removable === false && (
                                  <button type="button" className="ghost danger" disabled title={t('다른 에이전트 폴더의 스킬은 이 앱에서 지우지 않습니다. 그 에이전트에서 지우세요.')}>
                                    {t('삭제')}
                                  </button>
                                )}
                                {!s.plugin && s.removable !== false && (
                                  <button type="button" className="ghost danger" disabled={busy !== null} onClick={() => removeSkill(s)} aria-label={busy === key ? t('{0} 삭제 중', s.name) : t('{0} 삭제', s.name)} aria-busy={busy === key}>
                                    {busy === key ? t('삭제 중…') : t('삭제')}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  {pageCount > 1 && (
                    <nav className="pager" aria-label={t('설치된 스킬 페이지')}>
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
                        {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, shownRows.length)} / {t('{0}개', shownRows.length)}
                      </span>
                    </nav>
                  )}
                </div>
              </div>
            )}
          </section>
          {/* a preset installs into Claude Code: the other agents' skills stay out of it */}
          <TeamPreset data={{ ...data, skills: (data.skills as Skill[]).filter((s) => forClaude(s)) }} projectPath={projectPath} onInstalled={() => load(projectPath)} />
          <section>
            <InstallHistory />
          </section>
        </>
      )}
    </div>
  );
}

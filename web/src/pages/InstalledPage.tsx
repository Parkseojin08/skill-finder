import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { FolderInput } from '../components/FolderInput.tsx';
import { forgetInstalled } from '../installed.ts';
import { useKorean } from '../translate.ts';
import { RiskBadge, RiskSummary } from '../components/Badges.tsx';
import { RISK_LEVEL } from '../labels.ts';
import type { InstallChange, InstalledResponse, SettingsResponse } from '../types.ts';

/** How an install compares with the index (UI debate 3-3); shown only, nothing is updated from here. */
const CHANGE: Record<InstallChange, string | null> = {
  same: null,
  changed: '색인된 내용과 다름 (새 버전이 있거나 고친 사본)',
  unknown: null,
};

type Plugin = InstalledResponse['plugins'][number];
type Skill = InstalledResponse['skills'][number];
type RemoveRequest = {
  key: string;
  label: string;
  detail: string;
  body: { kind: 'plugin' | 'skill'; id: string; scope: string; projectPath?: string };
};

const SCOPE_LABEL: Record<string, string> = { user: '개인', project: '프로젝트', local: '로컬', synced: '앱 동기화' };

function Description({ text }: { text: string }) {
  const { ko } = useKorean(text);
  return (
    <span title={ko ? text : undefined} lang={ko ? 'ko' : 'en'}>
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

export function InstalledPage({ onOpenSkill }: { onOpenSkill: (id: string) => void }) {
  const [projectPath, setProjectPath] = useState('');
  const [data, setData] = useState<InstalledResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<RemoveRequest | null>(null);

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
      .then((d) => id === seq.current && setData(d))
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
      setMsg({ ok: true, text: `${label}: ${r.message}` });
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
      label: `플러그인 ${p.id}`,
      detail: p.scope === 'user' ? '개인 범위(모든 프로젝트)에서 제거합니다.' : `${p.projectPath ?? projectPath} 프로젝트에서 제거합니다.`,
      body: { kind: 'plugin', id: p.id, scope: p.scope, projectPath: p.scope === 'user' ? undefined : (p.projectPath ?? projectPath) },
    });

  const removeSkill = (s: Skill) =>
    setConfirming({
      key: `s:${s.path}`,
      label: `스킬 ${s.name}`,
      detail: `${s.path} 폴더를 지웁니다.`,
      body: { kind: 'skill', id: s.folder, scope: s.scope, projectPath: s.scope === 'user' ? undefined : projectPath },
    });

  // Plugins this app can remove vs. ones synced from the Claude app account (managed there).
  const managed = (data?.plugins ?? []).filter((p) => p.scope === 'user' || p.scope === 'project' || p.scope === 'local');
  const synced = (data?.plugins ?? []).filter((p) => !managed.includes(p));
  // said once above each table instead of on every row (project review 2026-11-02)
  const unindexedPlugins = managed.filter((p) => !p.topRisk).length;
  const unindexedSkills = (data?.skills ?? []).filter((s) => !s.skillId).length;

  return (
    <div className="page">
      <h1>설치됨</h1>
      <p className="muted">설치한 플러그인과 스킬을 확인하고 삭제할 수 있습니다. 프로젝트 폴더를 고르면 그 프로젝트에 설치된 스킬도 함께 보입니다.</p>
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
          placeholder="프로젝트 폴더 (비우면 개인 범위만)"
        />
        <button type="submit" disabled={loading}>
          {loading ? '불러오는 중…' : '새로 고침'}
        </button>
      </form>
      {(data?.projects.length ?? 0) > 0 && (
        <div className="examples">
          <span className="muted small">앱으로 설치한 프로젝트:</span>
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
        <ConfirmDialog title={`${confirming.label} 삭제`} confirmLabel="삭제" danger onConfirm={() => remove(confirming)} onCancel={() => setConfirming(null)}>
          <p>{confirming.detail}</p>
          <p className="muted small">되돌릴 수 없습니다. 다시 쓰려면 다시 설치해야 합니다.</p>
        </ConfirmDialog>
      )}
      {error && <p className="warn-box">{error}</p>}
      {data && (
        <>
          <section>
            <h2>플러그인 ({managed.length})</h2>
            {data.pluginError && <p className="warn-box">{data.pluginError}</p>}
            <p className="muted small">
              플러그인을 지우면 그 안의 스킬·훅·MCP 서버가 함께 제거됩니다. 다음 Claude Code 세션부터 반영됩니다.
              {unindexedPlugins > 0 && ` 색인에 없는 플러그인 ${unindexedPlugins}개는 위험 등급을 알 수 없습니다.`}
            </p>
            {managed.length === 0 ? (
              !data.pluginError && <p className="muted small">설치한 플러그인이 없습니다.</p>
            ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>플러그인</th>
                  <th>버전</th>
                  <th>범위</th>
                  <th>상태</th>
                  <th>위험</th>
                  <th />
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
                            <summary className="muted small">스킬 {p.skills.length}개</summary>
                            <ul>
                              {p.skills.map((s) => (
                                <li key={s.id}>
                                  <button type="button" className="linkish mono" onClick={() => onOpenSkill(s.id)}>
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
                        <span className={p.enabled ? 'state-on' : 'muted'}>{p.enabled == null ? '–' : p.enabled ? '켜짐' : '꺼짐'}</span>
                        {p.enabledWhere && <div className="muted small">{p.scope === 'user' ? '모든 프로젝트' : '해당 프로젝트에서'}</div>}
                      </td>
                      <td>
                        {p.topRisk ? (
                          <>
                            <RiskBadge level={p.topRisk} />
                            <div className="muted small">안의 스킬 중 가장 높은 등급</div>
                          </>
                        ) : (
                          <span className="muted small">–</span>
                        )}
                        {p.change === 'changed' && <div className="warn-text small">설치된 커밋이 색인한 커밋과 다름</div>}
                      </td>
                      <td className="actions">
                        <button type="button" className="ghost danger" disabled={busy !== null} onClick={() => removePlugin(p)} aria-label={busy === key ? `${p.id} 삭제 중` : `${p.id} 삭제`} aria-busy={busy === key}>
                          {busy === key ? '삭제 중…' : '삭제'}
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
                  Claude 앱 계정에서 동기화된 플러그인 {synced.length}개 <span className="muted small">· 앱 설정에서 관리</span>
                </summary>
                <ul className="synced-list">
                  {synced.map((p) => (
                    <li key={`${p.id}:${p.scope}`}>
                      <span className="mono">{p.id.replace(/@synced$/, '')}</span>
                      <span className="muted small">{p.version ?? ''}</span>
                      <span className={p.enabled ? 'state-on small' : 'muted small'}>{p.enabled == null ? '–' : p.enabled ? '켜짐' : '꺼짐'}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
          <section>
            <h2>스킬 ({data.skills.length})</h2>
            {unindexedSkills > 0 && (
              <p className="muted small">
                색인에 없는 스킬 {unindexedSkills}개(앱 밖에서 설치했거나 아직 모으지 않은 스킬)는 상세 화면이 없고, 설치된 파일에 지금 규칙을 돌린 위험 등급만 보입니다.
              </p>
            )}
            <table className="table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>범위</th>
                  <th>설명</th>
                  <th>위험</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.skills.map((s) => {
                  const key = `s:${s.path}`;
                  return (
                    <tr key={key}>
                      <td>
                        {s.skillId ? (
                          <button type="button" className="linkish mono" onClick={() => onOpenSkill(s.skillId!)}>
                            {s.name}
                          </button>
                        ) : (
                          <b className="mono">{s.name}</b>
                        )}
                        <div className="muted small">{s.path}</div>
                      </td>
                      <td>{s.scope === 'user' ? '개인' : '프로젝트'}</td>
                      <td className="small">
                        <Description text={s.description} />
                      </td>
                      <td>
                        {/* the current rules run on the installed files, wherever they came from */}
                        <RiskSummary level={s.risk.level} flags={s.risk.flags} />
                        {s.installedRisk && s.installedRisk !== s.risk.level && <div className="muted small">설치할 때는 {RISK_LEVEL[s.installedRisk]}</div>}
                        {CHANGE[s.change] && <div className="warn-text small">{CHANGE[s.change]}</div>}
                      </td>
                      <td className="actions">
                        <button type="button" className="ghost danger" disabled={busy !== null} onClick={() => removeSkill(s)} aria-label={busy === key ? `${s.name} 삭제 중` : `${s.name} 삭제`} aria-busy={busy === key}>
                          {busy === key ? '삭제 중…' : '삭제'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {data.skills.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted small">
                      설치된 스킬이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

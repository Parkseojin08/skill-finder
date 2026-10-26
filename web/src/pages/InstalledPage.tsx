import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { FolderInput } from '../components/FolderInput.tsx';
import { useKorean } from '../translate.ts';
import type { InstalledResponse, SettingsResponse } from '../types.ts';

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

export function InstalledPage() {
  const [projectPath, setProjectPath] = useState('');
  const [data, setData] = useState<InstalledResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<RemoveRequest | null>(null);

  const load = useCallback((path: string) => {
    setLoading(true);
    setError(null);
    apiGet<InstalledResponse>('/installed', { projectPath: path.trim() || undefined })
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    apiGet<SettingsResponse>('/settings')
      .then((s) => {
        setProjectPath(s.settings.defaultProjectPath);
        load(s.settings.defaultProjectPath);
      })
      .catch(() => load(''));
  }, [load]);

  const remove = async ({ key, label, body }: RemoveRequest) => {
    setConfirming(null);
    setBusy(key);
    setMsg(null);
    try {
      const r = await apiSend<{ ok: boolean; message: string }>('POST', '/uninstall', body);
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
            load(p);
          }}
          placeholder="프로젝트 폴더 (비우면 개인 범위만)"
        />
        <button type="submit" disabled={loading}>
          {loading ? '불러오는 중…' : '새로 고침'}
        </button>
      </form>
      {msg && <p className={msg.ok ? 'ok-box' : 'warn-box'}>{msg.text}</p>}
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
            <h2>플러그인 ({data.plugins.length})</h2>
            {data.pluginError && <p className="warn-box">{data.pluginError}</p>}
            <p className="muted small">플러그인을 지우면 그 안의 스킬·훅·MCP 서버가 함께 제거됩니다. 다음 Claude Code 세션부터 반영됩니다.</p>
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>버전</th>
                  <th>범위</th>
                  <th>상태</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.plugins.map((p) => {
                  const key = `p:${p.id}:${p.scope}:${p.projectPath ?? ''}`;
                  const removable = p.scope === 'user' || p.scope === 'project' || p.scope === 'local';
                  return (
                    <tr key={key}>
                      <td>
                        <b className="mono">{p.id}</b>
                        {p.projectPath && <div className="muted small">{p.projectPath}</div>}
                      </td>
                      <td>{p.version ?? '–'}</td>
                      <td>{SCOPE_LABEL[p.scope] ?? p.scope}</td>
                      <td>
                        <span className={p.enabled ? 'state-on' : 'muted'}>{p.enabled == null ? '–' : p.enabled ? '켜짐' : '꺼짐'}</span>
                        {p.enabledWhere && <div className="muted small">{p.scope === 'user' ? '모든 프로젝트' : '해당 프로젝트에서'}</div>}
                      </td>
                      <td className="actions">
                        {removable ? (
                          <button type="button" className="ghost danger" disabled={busy !== null} onClick={() => removePlugin(p)}>
                            {busy === key ? '삭제 중…' : '삭제'}
                          </button>
                        ) : (
                          <span className="muted small" title="Claude 앱 계정에서 동기화된 플러그인은 앱 설정에서 관리합니다">
                            앱에서 관리
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <section>
            <h2>스킬 ({data.skills.length})</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>범위</th>
                  <th>설명</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.skills.map((s) => {
                  const key = `s:${s.path}`;
                  return (
                    <tr key={key}>
                      <td>
                        <b className="mono">{s.name}</b>
                        <div className="muted small">{s.path}</div>
                      </td>
                      <td>{s.scope === 'user' ? '개인' : '프로젝트'}</td>
                      <td className="small">
                        <Description text={s.description} />
                      </td>
                      <td className="actions">
                        <button type="button" className="ghost danger" disabled={busy !== null} onClick={() => removeSkill(s)}>
                          {busy === key ? '삭제 중…' : '삭제'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {data.skills.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted small">
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

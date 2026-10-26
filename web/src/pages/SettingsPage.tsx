import { useEffect, useState } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { FolderInput } from '../components/FolderInput.tsx';
import { BREAKDOWN } from '../labels.ts';
import type { Breakdown, Settings, SettingsResponse } from '../types.ts';

export function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (r: SettingsResponse) => {
    setData(r);
    setDraft(r.settings);
  };

  useEffect(() => {
    apiGet<SettingsResponse>('/settings')
      .then(apply)
      .catch((e) => setMsg({ ok: false, text: String(e.message ?? e) }));
  }, []);

  const save = async (body: unknown, okText: string) => {
    try {
      apply(await apiSend<SettingsResponse>('PUT', '/settings', body));
      setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
  };

  if (!data || !draft) return <div className="page">{msg ? <p className="warn-box">{msg.text}</p> : <p className="muted">불러오는 중…</p>}</div>;

  const setW = (k: keyof Breakdown, v: number) => setDraft({ ...draft, weights: { ...draft.weights, [k]: v } });

  return (
    <div className="page settings">
      <h1>설정</h1>
      {msg && <p className={msg.ok ? 'ok-box' : 'warn-box'}>{msg.text}</p>}

      <section>
        <h2>GitHub 토큰</h2>
        <p>
          상태: <b>{data.githubToken ? '설정됨' : '없음'}</b>
        </p>
        <p className="muted small">공개 저장소 검색에는 권한 없는 fine-grained PAT면 충분합니다. 토큰이 없으면 GitHub 코드 검색을 건너뛰고, 저장소 파일 목록은 git으로 조회합니다.</p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            save({ githubToken: token.trim() }, token.trim() ? '토큰을 .env에 저장했습니다' : '토큰을 지웠습니다').then(() => setToken(''));
          }}
        >
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_… (비우고 저장하면 삭제)" autoComplete="off" spellCheck={false} />
          <button type="submit">저장</button>
        </form>
      </section>

      <section>
        <h2>점수 가중치</h2>
        <div className="grid2">
          {(Object.keys(BREAKDOWN) as Array<keyof Breakdown>).map((k) => (
            <label key={k} className="field">
              <span>
                {BREAKDOWN[k]} ({k}): {draft.weights[k].toFixed(2)}
              </span>
              <input type="range" min={0} max={1} step={0.05} value={draft.weights[k]} onChange={(e) => setW(k, Number(e.target.value))} />
            </label>
          ))}
        </div>
        <p className="muted small">근거 데이터가 없는 기본값입니다. 합이 1이 아니어도 비율로 정규화됩니다.</p>
      </section>

      <section>
        <h2>설치 기본값</h2>
        <div className="grid2">
          <label className="field">
            <span>기본 설치 범위</span>
            <select value={draft.defaultScope} onChange={(e) => setDraft({ ...draft, defaultScope: e.target.value as 'user' | 'project' })}>
              <option value="user">개인</option>
              <option value="project">프로젝트</option>
            </select>
          </label>
          <div className="field">
            <span>기본 프로젝트 폴더</span>
            <FolderInput value={draft.defaultProjectPath} onChange={(p) => setDraft({ ...draft, defaultProjectPath: p })} label="기본 프로젝트 폴더" />
          </div>
        </div>
        <label className="chip">
          <input type="checkbox" checked={draft.telemetryDisabled} onChange={(e) => setDraft({ ...draft, telemetryDisabled: e.target.checked })} />
          skills CLI 텔레메트리 끄기 (DISABLE_TELEMETRY=1). 끄지 않으면 skills.sh 순위 집계에 익명 정보가 전송됩니다.
        </label>
      </section>

      <section>
        <h2>스킬 수집</h2>
        <label className="chip">
          <input type="checkbox" checked={draft.autoCollect} onChange={(e) => setDraft({ ...draft, autoCollect: e.target.checked })} />
          커뮤니티 마켓플레이스 스킬을 백그라운드에서 자동으로 모으기
        </label>
        <p className="muted small">
          지연 색인 마켓플레이스의 스킬 정보를 동기화 뒤에 조금씩 모읍니다. 검색하는 동안은 잠시 멈춰서 검색 속도에 영향을 주지 않습니다. 진행 상황은 마켓플레이스 화면에서
          보고 멈출 수 있습니다.
        </p>
      </section>

      <div className="row">
        <button type="button" className="primary" onClick={() => save({ settings: draft }, '설정을 저장했습니다 (검색 캐시를 비웠습니다)')}>
          설정 저장
        </button>
        <button type="button" className="ghost" onClick={() => setDraft(data.settings)}>
          되돌리기
        </button>
      </div>
    </div>
  );
}

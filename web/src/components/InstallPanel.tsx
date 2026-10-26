import { useEffect, useRef, useState } from 'react';
import { apiGet, streamNdjson } from '../api.ts';
import { METHOD, SCOPE } from '../labels.ts';
import type { InstallPreview, InstallScope, RiskLevel, SkillDetail } from '../types.ts';
import { RiskBadge, RiskFlags } from './Badges.tsx';
import { FolderInput } from './FolderInput.tsx';

type LogLine = { line: string; stream: string };
type InstallEvent = { type: 'log'; line: string; stream: string } | { type: 'result'; ok: boolean; exitCode: number; message: string };

export function InstallPanel({ skill, defaultScope, defaultProjectPath }: { skill: SkillDetail; defaultScope: 'user' | 'project'; defaultProjectPath: string }) {
  const plan = skill.install;
  const [scope, setScope] = useState<InstallScope>(plan.scopes.includes(defaultScope) ? defaultScope : (plan.scopes[0] ?? 'user'));
  const [projectPath, setProjectPath] = useState(defaultProjectPath);
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (plan.method === 'manual-only') return;
    let alive = true;
    const t = setTimeout(() => {
      apiGet<InstallPreview>('/install/preview', { id: skill.id, scope, projectPath: scope === 'user' ? undefined : projectPath })
        .then((p) => alive && setPreview(p))
        .catch((e) => alive && setPreview({ plan, steps: [], location: '', error: String(e.message ?? e) }));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [skill.id, scope, projectPath, plan]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable
    }
  };

  if (plan.method === 'manual-only') {
    return (
      <section className="install">
        <h3>설치</h3>
        <p className={plan.disabled ? 'warn-box' : 'muted'}>{plan.reason}</p>
        <div className="cmd">
          <code>{plan.command}</code>
          <button type="button" className="ghost" onClick={() => copy(plan.command)}>
            {copied ? '복사됨' : '복사'}
          </button>
        </div>
        <p className="muted small">앱에서는 실행하지 않습니다. 내용을 확인한 뒤 터미널에서 직접 실행하세요.</p>
        <button type="button" disabled>
          설치 (비활성)
        </button>
      </section>
    );
  }

  const install = async () => {
    setConfirming(false);
    setRunning(true);
    setLog([]);
    setResult(null);
    try {
      await streamNdjson<InstallEvent>('/install', { id: skill.id, scope, projectPath: scope === 'user' ? undefined : projectPath }, (e) => {
        if (e.type === 'log') setLog((l) => [...l, { line: e.line, stream: e.stream }]);
        else setResult({ ok: e.ok, message: e.message });
      });
    } catch (e) {
      setResult({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setRunning(false);
    }
  };

  const ready = preview && !preview.error && preview.steps.length > 0;

  return (
    <section className="install">
      <h3>
        설치 <span className="muted small">· {METHOD[plan.method]}</span>
      </h3>
      {plan.method === 'plugin' && (
        <p className="note">
          스킬 하나가 아니라 <b>{plan.pluginId}</b> 플러그인 전체가 설치됩니다
          {skill.plugin ? ` (스킬 ${skill.plugin.skills.length}개${skill.plugin.hooks ? ', 훅' : ''}${skill.plugin.mcp ? ', MCP 서버' : ''}${skill.plugin.bin ? ', 실행 파일' : ''} 포함)` : ''}.
        </p>
      )}
      <fieldset className="scopes" disabled={running}>
        <legend>범위</legend>
        {plan.scopes.map((s) => (
          <label key={s}>
            <input type="radio" name="scope" value={s} checked={scope === s} onChange={() => setScope(s)} />
            {SCOPE[s]}
          </label>
        ))}
      </fieldset>
      {scope !== 'user' && (
        <div className="field">
          <span>프로젝트 폴더</span>
          <FolderInput value={projectPath} onChange={setProjectPath} disabled={running} />
        </div>
      )}
      {preview?.error && <p className="warn-box">{preview.error}</p>}
      {ready && (
        <div className="preview">
          <div className="muted small">실행할 명령</div>
          {preview.steps.map((s, i) => (
            <div key={i} className="cmd">
              <code>{s.display}</code>
            </div>
          ))}
          <div className="muted small">
            설치 위치: {preview.location}
            {preview.createsLockFile && <> · 프로젝트 루트에 <code>skills-lock.json</code>이 생깁니다</>}
          </div>
        </div>
      )}
      <button type="button" className="primary" disabled={!ready || running} onClick={() => setConfirming(true)}>
        {running ? '설치 중…' : '설치…'}
      </button>
      {(log.length > 0 || result) && (
        <div className="install-log">
          <pre ref={logRef}>
            {log.map((l, i) => (
              <div key={i} className={`log-${l.stream}`}>
                {l.line}
              </div>
            ))}
          </pre>
          {result && <p className={result.ok ? 'ok-box' : 'warn-box'}>{result.message}</p>}
        </div>
      )}
      {confirming && preview && (
        <ConfirmDialog
          name={skill.name}
          preview={preview}
          riskLevel={skill.riskLevel}
          riskFlags={skill.riskFlags}
          onCancel={() => setConfirming(false)}
          onConfirm={install}
        />
      )}
    </section>
  );
}

function ConfirmDialog(props: {
  name: string;
  preview: InstallPreview;
  riskLevel: RiskLevel;
  riskFlags: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="confirm" onCancel={props.onCancel} aria-labelledby="confirm-title">
      <h3 id="confirm-title">{props.name} 설치</h3>
      <p className="warn-box">
        스킬은 에이전트 권한으로 실행됩니다. 스크립트와 명령이 내 컴퓨터에서 Claude Code와 같은 권한으로 돌아갈 수 있으니, 내용을 확인한 출처만 설치하세요.
      </p>
      <div className="muted small">정확한 명령</div>
      {props.preview.steps.map((s, i) => (
        <div key={i} className="cmd">
          <code>{s.display}</code>
          <span className="muted small"> (작업 폴더: {s.cwd})</span>
        </div>
      ))}
      <div className="muted small">설치 위치</div>
      <p>{props.preview.location}</p>
      {props.preview.createsLockFile && <p className="muted small">프로젝트 루트에 skills-lock.json 파일이 생성됩니다.</p>}
      <div className="badges">
        <RiskBadge level={props.riskLevel} />
        <RiskFlags flags={props.riskFlags} />
      </div>
      <div className="dialog-actions">
        <button type="button" className="ghost" onClick={props.onCancel}>
          취소
        </button>
        <button type="button" className="primary" onClick={props.onConfirm} autoFocus>
          설치
        </button>
      </div>
    </dialog>
  );
}

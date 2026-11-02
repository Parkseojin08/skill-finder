import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, streamNdjson } from '../api.ts';
import { forgetInstalled } from '../installed.ts';
import { HELP, METHOD, RISK_FLAGS, RISK_LEVEL, RISK_RANK, SCOPE } from '../labels.ts';
import { HelpTip } from './HelpTip.tsx';
import type { ExistingSkill, InstallPlan, InstallPreview, InstallScan, InstallScope, RiskLevel, SkillDetail } from '../types.ts';
import { CopyButton } from './CopyButton.tsx';
import { InstallScanView, scanIsHigh } from './InstallScan.tsx';
import { RiskBadge, RiskFlags, RiskSummary } from './Badges.tsx';
import { FolderInput, rememberProject } from './FolderInput.tsx';
import { serverText, t } from '../i18n.ts';
import { tj } from '../i18nNodes.tsx';

type LogLine = { line: string; stream: string };
type PluginSkill = NonNullable<SkillDetail['plugin']>['skills'][number];

/**
 * The other skills a plugin install brings in that rank above the chosen one (UI debate 1-1): a "주의" skill can
 * install a "위험 높음" one beside it, and the dialog would otherwise show only the chosen skill's level.
 */
export function riskierSiblings(skill: SkillDetail): PluginSkill[] {
  if (skill.install.method !== 'plugin' || !skill.plugin) return [];
  return skill.plugin.skills
    .filter((s) => s.id !== skill.id && RISK_RANK[s.riskLevel] > RISK_RANK[skill.riskLevel])
    .sort((a, b) => RISK_RANK[b.riskLevel] - RISK_RANK[a.riskLevel] || a.name.localeCompare(b.name));
}

/**
 * A same-name skill folder the install replaces (the skills CLI runs with -y, D-5). Another or an unknown skill
 * needs a deliberate tick (project review 2026-11-02 #9); the same skill again is a plain reinstall.
 */
export function needsOverwriteCheck(existing: ExistingSkill | null | undefined): boolean {
  return !!existing && existing.same !== true;
}

export function OverwriteNote({ existing }: { existing: ExistingSkill | null | undefined }) {
  if (!existing) return null;
  if (existing.same) {
    return (
      <p className="note">
        {tj('이미 설치되어 있습니다{0}. 다시 설치하면 {1}를 새 파일로 바꿉니다. 그 폴더에서 고친 내용은 사라집니다.', existing.change === 'changed' ? t('(색인의 내용과 다름)') : '', <code>{existing.path}</code>)}
      </p>
    );
  }
  return (
    <p className="warn-box">
      {tj('같은 이름의 {0}{1}이 이미 {2}에 있습니다. 설치하면 그 폴더를 덮어씁니다.', existing.same === false ? t('다른 스킬') : t('출처를 알 수 없는 스킬'), existing.name ? `(${existing.name})` : '', <code>{existing.path}</code>)}
    </p>
  );
}

/** The folder the skills CLI installs into (its sanitizeName; server install/installed.ts skillFolderName). */
const folderName = (name: string) => name.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 255) || 'unnamed-skill';

/** After an install: when it takes effect, where, and how to call it (project review F4). */
function UsageNote({ plan, skillName, pluginName, scope, projectPath }: { plan: InstallPlan; skillName: string; pluginName: string | null; scope: InstallScope; projectPath: string }) {
  const command = plan.method === 'plugin' ? `/${plan.pluginName ?? pluginName ?? 'plugin'}:${folderName(skillName)}` : `/${folderName(skillName)}`;
  const where = scope === 'user' ? t('모든 프로젝트') : scope === 'project' ? t('{0} 폴더에서 연 Claude Code', projectPath) : t('{0} 폴더에서 연 Claude Code(나만)', projectPath);
  return (
    <div className="note small usage-note">
      {tj('{0} · 다음 Claude Code 세션부터 {1}에서 쓸 수 있습니다. 설명과 맞는 일을 시키면 Claude가 알아서 쓰고, 직접 부르려면 {2}를 입력하세요. 지우려면 설치됨 화면에서 삭제합니다.', <b>{t('사용법')}</b>, where, <code>{command}</code>)}
    </div>
  );
}

/** `here`: shown above the plugin's own skill list, so no pointer to it. */
export function SiblingRiskNote({ skills, here = false }: { skills: PluginSkill[]; here?: boolean }) {
  if (skills.length === 0) return null;
  const top = skills[0].riskLevel;
  const named = skills.slice(0, 3).map((s) => {
    const flag = s.riskFlags.find((f) => !RISK_FLAGS[f]?.info);
    return `${s.name}(${RISK_LEVEL[s.riskLevel]}${flag ? `, ${RISK_FLAGS[flag]?.label ?? flag}` : ''})`;
  });
  return (
    <p className={top === 'high' ? 'warn-box' : 'note'}>
      {t('같은 플러그인에 이 스킬보다 위험한 스킬 {0}개가 함께 설치됩니다: {1}', skills.length, named.join(', '))}
      {skills.length > named.length && t(' 외 {0}개', skills.length - named.length)}.{!here && t(' 개요 탭의 플러그인 목록에서 확인하세요.')}
    </p>
  );
}

/** Whether the files installed are the ones the risk check read (UI debate 1-3). */
function versionNote(plan: InstallPlan): string | null {
  if (plan.method === 'skills-cli' && plan.pinnedRef) return t('검사한 커밋 {0} 그대로 설치합니다.', plan.pinnedRef.slice(0, 7));
  if (plan.method === 'skills-cli' || plan.method === 'plugin') return t('설치할 때 최신 버전을 받습니다. 위험 검사를 한 버전과 다를 수 있습니다.');
  return null;
}
type InstallEvent = { type: 'log'; line: string; stream: string } | { type: 'result'; ok: boolean; exitCode: number; message: string };

export function InstallPanel({ skill, defaultScope, defaultProjectPath }: { skill: SkillDetail; defaultScope: 'user' | 'project'; defaultProjectPath: string }) {
  const plan = skill.install;
  const [scope, setScope] = useState<InstallScope>(plan.scopes.includes(defaultScope) ? defaultScope : (plan.scopes[0] ?? 'user'));
  const [projectPath, setProjectPath] = useState(defaultProjectPath);
  /** `key`: the scope and folder it was asked for; a preview for other input is not used (it may be on its way). */
  const [preview, setPreview] = useState<(InstallPreview & { key: string }) | null>(null);
  const inputKey = `${scope}|${scope === 'user' ? '' : projectPath}`;
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [scan, setScan] = useState<InstallScan | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (plan.method === 'manual-only') return;
    let alive = true;
    setScan(null);
    setScanError(null);
    apiGet<InstallScan>(`/skills/${encodeURIComponent(skill.id)}/install-scan`)
      .then((s) => alive && setScan(s))
      .catch((e) => alive && setScanError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [skill.id, plan.method]);

  useEffect(() => {
    if (plan.method === 'manual-only') return;
    let alive = true;
    const key = `${scope}|${scope === 'user' ? '' : projectPath}`;
    // no folder yet: nothing to ask (an empty path used to show "절대경로여야 합니다" before anything was typed)
    if (scope !== 'user' && !projectPath.trim()) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      apiGet<InstallPreview>('/install/preview', { id: skill.id, scope, projectPath: scope === 'user' ? undefined : projectPath })
        .then((p) => alive && setPreview({ ...p, key }))
        .catch((e) => alive && setPreview({ plan, steps: [], location: '', error: String(e.message ?? e), key }));
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
        <h3>{t('설치')}</h3>
        <p className={plan.disabled ? 'warn-box' : 'muted'}>{serverText(plan.reason)}</p>
        <div className="cmd">
          <code>{plan.command}</code>
          <button type="button" className="ghost" onClick={() => copy(plan.command)}>
            {copied ? t('복사됨') : t('복사')}
          </button>
        </div>
        <p className="muted small">{t('앱에서는 실행하지 않습니다. 내용을 확인한 뒤 터미널에서 직접 실행하세요.')}</p>
        <button type="button" disabled>
          {t('설치 (비활성)')}
        </button>
      </section>
    );
  }

  const install = async () => {
    setConfirming(false);
    setRunning(true);
    setLog([]);
    setResult(null);
    let answered = false;
    let failure: string | null = null;
    try {
      // the folder the dialog showed as replaced; the server checks it is still the one there
      const body = { id: skill.id, scope, projectPath: scope === 'user' ? undefined : projectPath, overwrite: current?.existing?.path };
      await streamNdjson<InstallEvent>('/install', body, (e) => {
        if (e.type === 'log') setLog((l) => [...l, { line: e.line, stream: e.stream }]);
        else {
          answered = true;
          setResult({ ok: e.ok, message: serverText(e.message) });
          if (e.ok) forgetInstalled();
          if (e.ok && scope !== 'user') rememberProject(projectPath);
        }
      });
    } catch (e) {
      failure = String((e as Error).message ?? e);
      // the server refused it before starting (400, 409): that is its answer, nothing is still running
      if (e instanceof ApiError && e.status > 0) {
        answered = true;
        setResult({ ok: false, message: failure });
      }
    }
    // The answer stopped without a result (a dropped connection, a closed tab): say whether it is still running
    // rather than leaving the log hanging (project review F4).
    if (!answered) {
      const status = await apiGet<{ installing: boolean }>('/install/status').catch(() => null);
      const where = t('설치됨 화면에서 설치됐는지 확인하세요.');
      setResult({
        ok: false,
        message: status?.installing ? t('응답이 끊겼지만 설치는 아직 진행 중입니다. 잠시 뒤 {0}', where) : t('{0}설치 결과를 받지 못했습니다. {1}', failure ? `${failure}. ` : '', where),
      });
    }
    setRunning(false);
  };

  // the preview for what is typed now, and the file check done (or failed): the dialog then shows what will happen
  // (review 2026-11-02: it could open on the previous folder's preview, or before the check said "download and run")
  const current = preview && preview.key === inputKey ? preview : null;
  const ready = !!current && !current.error && current.steps.length > 0 && (scan !== null || scanError !== null);
  const noFolder = scope !== 'user' && !projectPath.trim();
  const waiting = !running && (noFolder ? t('폴더를 고른 뒤 설치') : !current ? t('확인 중…') : scan === null && scanError === null ? t('파일 검사 중…') : null);
  const siblings = riskierSiblings(skill);
  const version = versionNote(plan);

  return (
    <section className="install">
      <h3>
        {tj('설치 {0}', <span className="muted small">· {METHOD[plan.method]}</span>)}
      </h3>
      {plan.method === 'plugin' && (
        <p className="note">
          {tj('스킬 하나가 아니라 {0} 플러그인 전체가 설치됩니다{1}.', <b>{plan.pluginId}</b>, skill.plugin ? t(' (스킬 {0}개{1}{2}{3} 포함)', skill.plugin.skills.length, skill.plugin.hooks ? t(', 훅') : '', skill.plugin.mcp ? t(', MCP 서버') : '', skill.plugin.bin ? t(', 실행 파일') : '') : '')}{' '}</p>
      )}
      <SiblingRiskNote skills={siblings} />
      <fieldset className="scopes" disabled={running}>
        <legend>
          {t('범위')}
          <HelpTip label={t('범위')} text={HELP.scope} />
        </legend>
        {plan.scopes.map((s) => (
          <label key={s}>
            <input type="radio" name="scope" value={s} checked={scope === s} onChange={() => setScope(s)} />
            {SCOPE[s]}
          </label>
        ))}
      </fieldset>
      {scope !== 'user' && (
        <div className="field">
          <span>{t('프로젝트 폴더')}</span>
          <FolderInput value={projectPath} onChange={setProjectPath} disabled={running} />
        </div>
      )}
      {current?.error && <p className="warn-box">{serverText(current.error)}</p>}
      {current && !current.error && current.steps.length > 0 && (
        <div className="preview">
          <div className="muted small">{t('실행할 명령')}</div>
          {current.steps.map((s, i) => (
            <div key={i} className="cmd">
              <code>{s.display}</code>
              {s.note && <span className="muted small">{serverText(s.note)}</span>}
              <CopyButton text={s.display} />
            </div>
          ))}
          {current.steps.length > 1 && <CopyButton text={current.steps.map((s) => s.display).join('\n')} label={t('명령 모두 복사')} className="linkish small" />}
          <div className="muted small">
            {t('설치 위치: {0}', serverText(current.location))}
            {current.createsLockFile && <>{' '}{tj('· 프로젝트 루트에 {0}이 생깁니다', <code>skills-lock.json</code>)}</>}
          </div>
          {version && <div className="muted small">{version}</div>}
          <OverwriteNote existing={current.existing} />
        </div>
      )}
      <InstallScanView scan={scan} error={scanError} />
      {/* what is being installed, right above the button (UI debate 2-5) */}
      <div className="badges">
        <RiskSummary level={skill.riskLevel} flags={skill.riskFlags} />
      </div>
      <button type="button" className="primary" disabled={!ready || running} onClick={() => setConfirming(true)}>
        {running ? t('설치 중…') : (waiting ?? (current?.existing?.same ? t('다시 설치…') : t('설치…')))}
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
          {result && (
            <p className={result.ok ? 'ok-box' : 'warn-box'} role={result.ok ? 'status' : 'alert'}>
              {result.message}
            </p>
          )}
          {result?.ok && <UsageNote plan={plan} skillName={skill.name} pluginName={skill.plugin?.name ?? null} scope={scope} projectPath={projectPath} />}
        </div>
      )}
      {confirming && current && (
        <ConfirmDialog
          name={skill.name}
          preview={current}
          riskLevel={skill.riskLevel}
          riskFlags={skill.riskFlags}
          siblings={siblings}
          version={version}
          scan={scan}
          scanFailed={scanError !== null}
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
  siblings: PluginSkill[];
  version: string | null;
  scan: InstallScan | null;
  /** The file check could not run: installing anyway needs the tick, as for high risk. */
  scanFailed: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // High risk (this skill or one the plugin brings in) needs one deliberate tick (UI debate 2-9); about 1% of
  // skills, so the extra step is rare.
  const high = props.riskLevel === 'high' || props.siblings.some((s) => s.riskLevel === 'high') || scanIsHigh(props.scan) || props.scanFailed;
  const [checked, setChecked] = useState(false);
  const overwrite = needsOverwriteCheck(props.preview.existing);
  const [overwriteChecked, setOverwriteChecked] = useState(false);
  useEffect(() => {
    // back to the "설치…" button when it goes (removed, not closed: the browser would drop the focus)
    const opener = document.activeElement as HTMLElement | null;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (opener?.isConnected) setTimeout(() => opener.focus(), 0);
    };
  }, []);
  return (
    <dialog ref={ref} className="confirm" onCancel={props.onCancel} aria-labelledby="confirm-title">
      <h3 id="confirm-title">{t('{0} 설치', props.name)}</h3>
      <p className="warn-box">
        {t('스킬은 에이전트 권한으로 실행됩니다. 스크립트와 명령이 내 컴퓨터에서 Claude Code와 같은 권한으로 돌아갈 수 있으니, 내용을 확인한 출처만 설치하세요.')}
      </p>
      <div className="muted small">{t('정확한 명령')}</div>
      {props.preview.steps.map((s, i) => (
        <div key={i} className="cmd cmd-stacked">
          <code>{s.display}</code>
          <span className="muted small">
            {t('작업 폴더: {0}', s.cwd)}
            {s.note && ` · ${serverText(s.note)}`}
          </span>
        </div>
      ))}
      <div className="muted small">{t('설치 위치')}</div>
      <p>{serverText(props.preview.location)}</p>
      {props.preview.createsLockFile && <p className="muted small">{t('프로젝트 루트에 skills-lock.json 파일이 생성됩니다.')}</p>}
      {props.version && <p className="muted small">{props.version}</p>}
      <div className="badges">
        <RiskBadge level={props.riskLevel} />
        <RiskFlags flags={props.riskFlags} />
      </div>
      <SiblingRiskNote skills={props.siblings} />
      <InstallScanView scan={props.scan} compact />
      {props.scanFailed && <p className="warn-box">{t('함께 들어올 파일을 검사하지 못했습니다. 무엇이 설치되는지 앱이 확인하지 못했으니, 저장소를 직접 보고 설치하세요.')}</p>}
      <OverwriteNote existing={props.preview.existing} />
      {overwrite && (
        <label className="confirm-check">
          <input type="checkbox" checked={overwriteChecked} onChange={(e) => setOverwriteChecked(e.target.checked)} />
          {t('기존 폴더를 덮어쓰는 것을 확인했습니다')}
        </label>
      )}
      {high && (
        <label className="confirm-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />{t('위 명령과 위험 신호를 확인했습니다')}
        </label>
      )}
      <div className="dialog-actions">
        {/* Cancel first, as in the delete dialog: Enter alone must not install (UI debate 1-2) */}
        <button type="button" className="ghost" onClick={props.onCancel} autoFocus>
          {t('취소')}
        </button>
        <button type="button" className="primary" onClick={props.onConfirm} disabled={(high && !checked) || (overwrite && !overwriteChecked)}>
          {props.preview.existing?.same ? t('다시 설치') : t('설치')}
        </button>
      </div>
    </dialog>
  );
}

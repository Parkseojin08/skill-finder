import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet } from '../api.ts';
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
import { OverwriteKeepNote } from './Quarantine.tsx';
import { CLAUDE_ONLY_FLAGS, InstallRefused, saveAgents, savedAgents, streamInstall, type AgentId, type AgentTarget, type ChangedSinceScan, type InstallPreviewMore } from '../lib/security.ts';

type LogLine = { line: string; stream: string };
/** The preview with the server's own high-risk judgement (feature review P7); types.ts is left as it is. */
export type InstallPreviewHigh = InstallPreview & { highRisk?: boolean };
/**
 * What the confirm dialog had ticked, sent with /install (the server refuses high risk without `high`; `high` also
 * covers a check that could not run). `overwrite` and `scanFailed` are recorded with the install (F7).
 */
export type InstallAcks = { high?: boolean; overwrite?: boolean; scanFailed?: boolean };

/** Every same-name folder the install replaces: the server's list for the ticked agents, or its one folder. */
export const existingOf = (p: InstallPreviewMore | null | undefined): ExistingSkill[] => p?.existingAll ?? (p?.existing ? [p.existing] : []);
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

/** Where the install goes, for the note on the copy kept of a replaced folder (F14). */
export type InstallWhere = { scope: InstallScope; projectPath: string };

/** All of a preview's same-name folders, one note each (other agents' folders too, F9 stage 2). */
export function OverwriteNotes({ preview, where }: { preview: InstallPreviewMore | null | undefined; where?: InstallWhere }) {
  return (
    <>
      {existingOf(preview).map((e) => (
        <OverwriteNote key={e.path} existing={e} where={where} />
      ))}
    </>
  );
}

const SHORT = (sha: string | null) => (sha ? sha.slice(0, 7) : '?');

/**
 * The install was refused because the repo moved after the check (B6, decision 11): what moved, and what the check of
 * the new commit found that the old one did not. The install tab has the new check; the confirm dialog opens again.
 */
export function ChangedNote({ changed }: { changed: ChangedSinceScan }) {
  const what = { marketplace: t('마켓플레이스'), plugin: t('플러그인 저장소'), skill: t('저장소') } as const;
  return (
    <div className="warn-box" role="alert">
      <b>{t('검사 후 바뀜')}</b> — {t('위험 검사를 한 뒤 저장소가 바뀌어 설치하지 않았습니다. 새 커밋을 다시 검사했습니다.')}
      <ul className="scan-findings">
        {changed.changes.map((c, i) => (
          <li key={i}>
            {what[c.what]} <code>{c.repo}</code> <code>{SHORT(c.checked)}</code> → <code>{SHORT(c.now)}</code>
          </li>
        ))}
      </ul>
      {changed.gone && <p>{t('새 커밋에는 이 스킬(플러그인)이 없습니다. 설치하지 마세요.')}</p>}
      {changed.newFlags.length > 0 ? (
        <p>
          {t('새 위험 신호:')} <RiskFlags flags={changed.newFlags} />
        </p>
      ) : (
        !changed.gone && <p className="small">{t('새 위험 신호는 없습니다.')}</p>
      )}
      {changed.raised.length > 0 && <p>{t('위험 등급이 오른 스킬: {0}', changed.raised.join(', '))}</p>}
      {changed.added.length > 0 && <p>{t('새로 들어온 스킬: {0}', changed.added.join(', '))}</p>}
      {changed.removed.length > 0 && <p>{t('빠진 스킬: {0}', changed.removed.join(', '))}</p>}
    </div>
  );
}

/**
 * The agents a skills CLI install goes to (F9 stage 2, decision 12): Claude Code by default; only agents set up on this
 * PC can be ticked. Agents sharing a folder (a project's .agents/skills) are installed together.
 */
function AgentChoice({ targets, chosen, onChange, disabled }: { targets: AgentTarget[]; chosen: AgentId[]; onChange: (next: AgentId[]) => void; disabled: boolean }) {
  const name = (id: AgentId) => targets.find((x) => x.id === id)?.name ?? id;
  return (
    <fieldset className="scopes" disabled={disabled}>
      <legend>{t('설치할 에이전트')}</legend>
      {targets.map((a) => (
        <label key={a.id} title={a.detected ? a.dir : t('이 PC에서 찾지 못했습니다')} className={a.detected ? '' : 'muted'}>
          <input
            type="checkbox"
            checked={a.detected && chosen.includes(a.id)}
            disabled={!a.detected}
            onChange={(e) => onChange(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))}
          />
          {a.name}
          {a.detected && a.sharedWith.length > 0 && chosen.includes(a.id) && <span className="muted small"> ({t('{0}와 같은 폴더', a.sharedWith.map(name).join(', '))})</span>}
        </label>
      ))}
    </fieldset>
  );
}

export function OverwriteNote({ existing, where }: { existing: ExistingSkill | null | undefined; where?: InstallWhere }) {
  if (!existing) return null;
  // the copy kept before the folder is replaced (F14): only a skills CLI install replaces one (user or project scope).
  // The same skill with the same content again is not copied (routes/install.ts), so that case says nothing.
  const keep =
    where && where.scope !== 'local' && !(existing.same && existing.change === 'same') ? (
      <OverwriteKeepNote scope={where.scope} projectPath={where.scope === 'user' ? undefined : where.projectPath} path={existing.path} />
    ) : null;
  if (existing.same) {
    return (
      <>
        <p className="note">
          {tj('이미 설치되어 있습니다{0}. 다시 설치하면 {1}를 새 파일로 바꿉니다. 그 폴더에서 고친 내용은 사라집니다.', existing.change === 'changed' ? t('(색인의 내용과 다름)') : '', <code>{existing.path}</code>)}
        </p>
        {keep}
      </>
    );
  }
  return (
    <>
      <p className="warn-box">
        {tj('같은 이름의 {0}{1}이 이미 {2}에 있습니다. 설치하면 그 폴더를 덮어씁니다.', existing.same === false ? t('다른 스킬') : t('출처를 알 수 없는 스킬'), existing.name ? `(${existing.name})` : '', <code>{existing.path}</code>)}
      </p>
      {keep}
    </>
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

export function InstallPanel({
  skill,
  defaultScope,
  defaultProjectPath,
  onRechecked,
}: {
  skill: SkillDetail;
  defaultScope: 'user' | 'project';
  defaultProjectPath: string;
  /** The server read the skill again after it changed (B6): the page reloads the detail for its new risk. */
  onRechecked?: () => void;
}) {
  const plan = skill.install;
  // a plugin installs all of its skills: the riskiest one counts
  const topRisk = (plan.method === 'plugin' ? (skill.plugin?.skills ?? []) : []).reduce<RiskLevel>((top, s) => (RISK_RANK[s.riskLevel] > RISK_RANK[top] ? s.riskLevel : top), skill.riskLevel);
  const [scope, setScope] = useState<InstallScope>(plan.scopes.includes(defaultScope) ? defaultScope : (plan.scopes[0] ?? 'user'));
  const [projectPath, setProjectPath] = useState(defaultProjectPath);
  /** `key`: the scope, folder and agents it was asked for; a preview for other input is not used (it may be on its way). */
  const [preview, setPreview] = useState<(InstallPreviewMore & { key: string }) | null>(null);
  // the agents ticked (F9 stage 2): this browser's default; a plugin is Claude Code's only
  const [chosenAgents, setChosenAgents] = useState<AgentId[]>(savedAgents);
  const [targets, setTargets] = useState<AgentTarget[] | null>(null);
  const cliInstall = plan.method === 'skills-cli';
  const agents: AgentId[] = !cliInstall
    ? ['claude-code']
    : targets
      ? targets.filter((a) => a.detected && chosenAgents.includes(a.id)).map((a) => a.id)
      : chosenAgents.filter((a) => a === 'claude-code');
  /** The install was refused as changed since the check (B6): shown, and the confirm dialog opens again once checked. */
  const [changed, setChanged] = useState<ChangedSinceScan | null>(null);
  const [reconfirm, setReconfirm] = useState(false);
  /** Bumped to ask for the file check and the preview again (after the server checked a new commit). */
  const [nonce, setNonce] = useState(0);
  const inputKey = `${scope}|${scope === 'user' ? '' : projectPath}|${agents.join(',')}|${nonce}`;
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
  }, [skill.id, plan.method, nonce]);

  useEffect(() => {
    if (plan.method === 'manual-only') return;
    let alive = true;
    const key = inputKey;
    // no folder yet: nothing to ask (an empty path used to show "절대경로여야 합니다" before anything was typed)
    if (scope !== 'user' && !projectPath.trim()) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      apiGet<InstallPreviewMore>('/install/preview', { id: skill.id, scope, projectPath: scope === 'user' ? undefined : projectPath, agents: cliInstall ? agents.join(',') : undefined })
        .then((p) => {
          if (!alive) return;
          setPreview({ ...p, key });
          if (p.targets?.length) setTargets(p.targets);
        })
        .catch((e) => alive && setPreview({ plan, steps: [], location: '', error: String(e.message ?? e), key }));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // inputKey holds the scope, folder, agents and nonce
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.id, inputKey, plan]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  // the preview for what is typed now, and the file check done (or failed): the dialog then shows what will happen
  // (review 2026-11-02: it could open on the previous folder's preview, or before the check said "download and run")
  const current = preview && preview.key === inputKey ? preview : null;
  const noAgent = cliInstall && agents.length === 0;
  const ready = !!current && !current.error && current.steps.length > 0 && (scan !== null || scanError !== null) && !noAgent;
  // B6: the new commit is checked (file check and preview are in again): the confirm dialog opens again
  useEffect(() => {
    if (reconfirm && ready && !running) {
      setReconfirm(false);
      setConfirming(true);
    }
  }, [reconfirm, ready, running]);

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

  const install = async (acks: InstallAcks) => {
    setConfirming(false);
    setRunning(true);
    setLog([]);
    setResult(null);
    let answered = false;
    let failure: string | null = null;
    try {
      // the folders the dialog showed as replaced; the server checks they are still the ones there
      const replaced = existingOf(current).map((e) => e.path);
      const body = {
        id: skill.id,
        scope,
        projectPath: scope === 'user' ? undefined : projectPath,
        overwrite: replaced.length > 1 ? replaced : replaced[0],
        acks,
        ...(cliInstall ? { agents } : {}),
      };
      setChanged(null);
      await streamInstall<InstallEvent>(body, (e) => {
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
        // B6: changed since the check. It was checked again; show what changed and ask again once that check is in
        const moved = e instanceof InstallRefused ? e.changed : null;
        if (moved) {
          setChanged(moved);
          setScan(null);
          setNonce((n) => n + 1);
          setReconfirm(true);
          onRechecked?.();
        }
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

  const noFolder = scope !== 'user' && !projectPath.trim();
  const waiting = !running && (noFolder ? t('폴더를 고른 뒤 설치') : noAgent ? t('에이전트를 하나 이상 고르세요') : !current ? t('확인 중…') : scan === null && scanError === null ? t('파일 검사 중…') : null);
  const siblings = riskierSiblings(skill);
  const version = versionNote(plan);
  // allowed-tools, hooks and `!`cmd`` are Claude Code's own (F9 stage 2; that others ignore them is a guess)
  const claudeOnly = cliInstall && agents.some((a) => a !== 'claude-code') ? skill.riskFlags.filter((f) => CLAUDE_ONLY_FLAGS.has(f)) : [];

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
      {/* a hint only, the scope is not changed for the user (peer request 2026-11-04) */}
      {scope === 'user' && plan.scopes.some((s) => s !== 'user') && RISK_RANK[topRisk] >= RISK_RANK.medium && (
        <p className="muted small">{t('위험 등급이 {0}입니다. 모든 프로젝트 대신 이 프로젝트에만 설치하는 것도 고려하세요.', RISK_LEVEL[topRisk])}</p>
      )}
      {scope !== 'user' && (
        <div className="field">
          <span>{t('프로젝트 폴더')}</span>
          <FolderInput value={projectPath} onChange={setProjectPath} disabled={running} />
        </div>
      )}
      {/* plugins are Claude Code's own: no choice of agent for them */}
      {cliInstall && targets && targets.length > 1 && (
        <AgentChoice
          targets={targets}
          chosen={chosenAgents}
          disabled={running}
          onChange={(next) => {
            setChosenAgents(next);
            saveAgents(next);
          }}
        />
      )}
      {claudeOnly.length > 0 && (
        <p className="muted small">
          {t('{0}은(는) Claude Code에서만 뜻이 있습니다. 다른 에이전트에서는 무시되거나 다르게 동작할 수 있습니다(추측).', claudeOnly.map((f) => RISK_FLAGS[f]?.label ?? f).join(', '))}
        </p>
      )}
      {changed && <ChangedNote changed={changed} />}
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
          <OverwriteNotes preview={current} where={{ scope, projectPath }} />
        </div>
      )}
      <InstallScanView scan={scan} error={scanError} />
      {/* what is being installed, right above the button (UI debate 2-5) */}
      <div className="badges">
        <RiskSummary level={skill.riskLevel} flags={skill.riskFlags} />
      </div>
      {(skill as SkillDetail & { riskRulesStale?: boolean }).riskRulesStale && (
        <p className="muted small">{t('이 위험 등급은 이전 위험 규칙으로 판정한 것입니다. SKILL.md를 다시 읽지 못해 지금 규칙(숨은 내용 등)으로는 아직 검사하지 못했습니다.')}</p>
      )}
      <button type="button" className="primary" disabled={!ready || running} onClick={() => setConfirming(true)}>
        {running ? t('설치 중…') : (waiting ?? (existingOf(current).some((e) => e.same) && !existingOf(current).some((e) => !e.same) ? t('다시 설치…') : t('설치…')))}
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
          changed={changed}
          where={{ scope, projectPath }}
          onCancel={() => setConfirming(false)}
          onConfirm={install}
        />
      )}
    </section>
  );
}

function ConfirmDialog(props: {
  name: string;
  preview: InstallPreviewMore;
  riskLevel: RiskLevel;
  riskFlags: string[];
  siblings: PluginSkill[];
  version: string | null;
  scan: InstallScan | null;
  /** The file check could not run: installing anyway needs the tick, as for high risk. */
  scanFailed: boolean;
  /** Asked again because the repo moved after the first check (B6): what changed, shown first. */
  changed: ChangedSinceScan | null;
  /** Where it installs, for the note on the copy kept of a replaced folder (F14). */
  where: InstallWhere;
  onCancel: () => void;
  onConfirm: (acks: InstallAcks) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // High risk (this skill or one the plugin brings in) needs one deliberate tick (UI debate 2-9); about 1% of
  // skills, so the extra step is rare.
  const high = props.riskLevel === 'high' || props.siblings.some((s) => s.riskLevel === 'high') || props.preview.highRisk === true || scanIsHigh(props.scan) || props.scanFailed;
  const [checked, setChecked] = useState(false);
  const overwrite = existingOf(props.preview).some(needsOverwriteCheck);
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
      {props.changed && <ChangedNote changed={props.changed} />}
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
      <OverwriteNotes preview={props.preview} where={props.where} />
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
        <button
          type="button"
          className="primary"
          onClick={() => props.onConfirm({ high: high && checked, overwrite: overwrite && overwriteChecked, scanFailed: props.scanFailed && checked })}
          disabled={(high && !checked) || (overwrite && !overwriteChecked)}
        >
          {props.preview.existing?.same && !overwrite ? t('다시 설치') : t('설치')}
        </button>
      </div>
    </dialog>
  );
}

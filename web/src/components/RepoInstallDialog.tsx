import { CheckCircleIcon, CircleNotchIcon, DownloadSimpleIcon, XCircleIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ApiError, apiGet, streamNdjson } from '../api.ts';
import { forgetInstalled } from '../installed.ts';
import { METHOD } from '../labels.ts';
import type { InstallScan, RepoResult, SettingsResponse } from '../types.ts';
import { RiskBadge, RiskSummary } from './Badges.tsx';
import { FolderInput, rememberProject } from './FolderInput.tsx';
import { needsOverwriteCheck, OverwriteNote, type InstallPreviewHigh } from './InstallPanel.tsx';
import { CopyButton } from './CopyButton.tsx';
import { InstallScanView, scanIsHigh } from './InstallScan.tsx';
import { serverText, t } from '../i18n.ts';

type Step = 'select' | 'confirm' | 'run';
type Status = 'wait' | 'run' | 'ok' | 'fail';
type InstallEvent = { type: 'log'; line: string; stream: string } | { type: 'result'; ok: boolean; exitCode: number; message: string };

/**
 * Installs several skills of one GitHub repo: pick skills (all installable ones by default), scope and folder,
 * review the exact command for each, then install them one by one (the server runs one install at a time).
 * Each install goes through the same /install endpoint and checks as a single skill.
 */
export function RepoInstallDialog({
  repo,
  open,
  onOpenChange,
  title,
  note,
  defaultProjectPath,
}: {
  repo: RepoResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Another title than "<repo> 설치" (a team preset), and a note above the list (what it could not find). */
  title?: string;
  note?: ReactNode;
  /** The folder chosen on the screen it was opened from (설치됨): its project scope is the default (peer request 2026-11-04). */
  defaultProjectPath?: string;
}) {
  const installable = repo.skills.filter((s) => s.installable);
  const [step, setStep] = useState<Step>('select');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(installable.map((s) => s.id)));
  const [scope, setScope] = useState<'user' | 'project'>(defaultProjectPath ? 'project' : 'user');
  const [projectPath, setProjectPath] = useState(defaultProjectPath ?? '');
  const [previews, setPreviews] = useState<Record<string, InstallPreviewHigh>>({});
  /** The other files each chosen skill installs, checked (project review F1); a failed check shows as an error line. */
  const [scans, setScans] = useState<Record<string, { scan: InstallScan | null; error?: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [log, setLog] = useState<string[]>([]);
  /** A chosen skill is high risk: one deliberate tick before installing, as in the single-skill dialog (2-9). */
  const [highChecked, setHighChecked] = useState(false);
  /** A chosen skill would replace another skill's folder of the same name: also one tick. */
  const [overwriteChecked, setOverwriteChecked] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep('select');
    setHighChecked(false);
    setError(null);
    setStatus({});
    setLog([]);
    apiGet<SettingsResponse>('/settings')
      .then((s) => {
        setScope(s.settings.defaultScope);
        setProjectPath((cur) => cur || s.settings.defaultProjectPath);
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const chosen = installable.filter((s) => selected.has(s.id));
  // the server's own judgement too (a plugin's other skill can be high): it refuses those without acks.high (P7)
  // a file check that could not run needs the same tick: the server checks again before installing and refuses it
  // unticked (stage 2, install/record.ts scanNeedsTick)
  const chosenHigh = chosen.filter((s) => s.riskLevel === 'high' || previews[s.id]?.highRisk === true || scanIsHigh(scans[s.id]?.scan) || !!scans[s.id]?.error);
  const toOverwrite = chosen.filter((s) => needsOverwriteCheck(previews[s.id]?.existing));
  const toggle = (id: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const review = async () => {
    setHighChecked(false); // the choice may have changed since the last review
    setOverwriteChecked(false);
    setBusy(true);
    setError(null);
    try {
      const pairs = await Promise.all(
        chosen.map(async (s) => [s.id, await apiGet<InstallPreviewHigh>('/install/preview', { id: s.id, scope, projectPath: scope === 'user' ? undefined : projectPath })] as const),
      );
      const failed = pairs.find(([, p]) => p.error);
      if (failed) throw new Error(failed[1].error);
      const scanned = await Promise.all(
        chosen.map(async (s) => {
          try {
            return [s.id, { scan: await apiGet<InstallScan>(`/skills/${encodeURIComponent(s.id)}/install-scan`) }] as const;
          } catch (e) {
            return [s.id, { scan: null, error: String((e as Error).message ?? e) }] as const;
          }
        }),
      );
      setPreviews(Object.fromEntries(pairs));
      setScans(Object.fromEntries(scanned));
      setStep('confirm');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setStep('run');
    setBusy(true);
    setStatus(Object.fromEntries(chosen.map((s) => [s.id, 'wait' as Status])));
    for (const s of chosen) {
      setStatus((cur) => ({ ...cur, [s.id]: 'run' }));
      setLog((l) => [...l, `── ${s.name}`]);
      let ok = false;
      let answered = false;
      try {
        // the tick names these skills ("위험 높음 N개(…)를 확인했습니다"): only they carry it
        const ticked = highChecked && chosenHigh.some((h) => h.id === s.id);
        const acks = { high: ticked, overwrite: overwriteChecked && needsOverwriteCheck(previews[s.id]?.existing), scanFailed: ticked && !!scans[s.id]?.error };
        const body = { id: s.id, scope, projectPath: scope === 'user' ? undefined : projectPath, overwrite: previews[s.id]?.existing?.path, acks };
        await streamNdjson<InstallEvent>('/install', body, (e) => {
          if (e.type === 'log') setLog((l) => [...l, e.line]);
          else {
            answered = true;
            ok = e.ok;
            setLog((l) => [...l, serverText(e.message)]);
          }
        });
      } catch (e) {
        // the server refused it before starting (400, 409): that is its answer, nothing is still running
        if (e instanceof ApiError && e.status > 0) answered = true;
        setLog((l) => [...l, String((e as Error).message ?? e)]);
      }
      // cut off without a result, as in the single install (F4): wait for it to finish before the next one, which
      // the server would otherwise refuse as "다른 설치가 진행 중"
      if (!answered) {
        let st = await apiGet<{ installing: boolean }>('/install/status').catch(() => null);
        if (st?.installing) setLog((l) => [...l, t('응답이 끊겼지만 설치는 아직 진행 중입니다. 끝나기를 기다립니다…')]);
        for (let i = 0; st?.installing && i < 120; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          st = await apiGet<{ installing: boolean }>('/install/status').catch(() => null);
        }
        setLog((l) => [...l, t('설치 결과를 받지 못했습니다. 설치됨 화면에서 설치됐는지 확인하세요.')]);
      }
      setStatus((cur) => ({ ...cur, [s.id]: ok ? 'ok' : 'fail' }));
      if (ok && scope === 'project') rememberProject(projectPath);
    }
    forgetInstalled();
    setBusy(false);
  };

  const done = chosen.filter((s) => status[s.id] === 'ok').length;
  const failedCount = chosen.filter((s) => status[s.id] === 'fail').length;
  const icon = (st: Status | undefined) =>
    st === 'ok' ? <CheckCircleIcon className="st-ok" /> : st === 'fail' ? <XCircleIcon className="st-fail" /> : st === 'run' ? <CircleNotchIcon className="animate-spin" /> : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="repo-install sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{title ?? t('{0} 설치', repo.repo)}</DialogTitle>
          <DialogDescription>
            {step === 'select' && t('설치할 스킬과 범위를 고르세요. 스킬마다 따로 설치되며, 다음 단계에서 실행할 명령을 확인합니다.')}
            {step === 'confirm' && t('아래 명령을 이 순서대로 실행합니다. 스킬은 에이전트 권한으로 실행되니 내용을 확인한 출처만 설치하세요.')}
            {step === 'run' && (busy ? t('설치 중… {0}/{1}', done + failedCount, chosen.length) : t('완료: 성공 {0}개{1}. 다음 Claude Code 세션부터 반영되고, 설명과 맞는 일을 시키거나 /이름으로 부르면 씁니다.', done, failedCount ? t(', 실패 {0}개', failedCount) : ''))}
          </DialogDescription>
          {/* the description changes in place, which is not announced: the same progress in a live region */}
          <p className="sr-only" role="status">
            {step === 'run' ? (busy ? t('설치 중 {0}/{1}', done + failedCount, chosen.length) : t('설치 완료: 성공 {0}개{1}', done, failedCount ? t(', 실패 {0}개', failedCount) : '')) : ''}
          </p>
        </DialogHeader>

        {step === 'select' && (
          <div className="flex flex-col gap-4">
            {note}
            <fieldset className="flex flex-col gap-2">
              <legend className="muted small">{t('스킬 ({0}/{1})', chosen.length, installable.length)}</legend>
              {repo.skills.map((s) => (
                <Label key={s.id} className="repo-skill-row">
                  <Checkbox checked={selected.has(s.id)} disabled={!s.installable} onCheckedChange={(on) => toggle(s.id, on === true)} />
                  <span className="mono">{s.name}</span>
                  <RiskBadge level={s.riskLevel} />
                  <span className="muted small">{s.installable ? METHOD[s.method] : t('앱에서 설치 불가')}</span>
                </Label>
              ))}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="muted small">{t('범위')}</legend>
              <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'user' | 'project')} className="flex gap-4">
                <Label className="flex items-center gap-2">
                  <RadioGroupItem value="user" />{t(' 개인 (모든 프로젝트)')}
                </Label>
                <Label className="flex items-center gap-2">
                  <RadioGroupItem value="project" />{t(' 프로젝트')}
                </Label>
              </RadioGroup>
              {scope === 'project' && <FolderInput value={projectPath} onChange={setProjectPath} />}
            </fieldset>
          </div>
        )}

        {step === 'confirm' && (
          <ol className="repo-install-steps">
            {chosen.map((s) => (
              <li key={s.id}>
                <div className="flex items-center gap-2">
                  <span className="mono">{s.name}</span>
                  {/* level and signal names, as the single-skill dialog shows (UI debate 2-9) */}
                  <RiskSummary level={s.riskLevel} flags={s.riskFlags ?? []} />
                </div>
                {previews[s.id]?.steps.map((st, i) => (
                  <div key={i} className="cmd cmd-stacked">
                    <code>{st.display}</code>
                    <span className="muted small">
                      {t('작업 폴더: {0}', st.cwd)}
                      {st.note && ` · ${serverText(st.note)}`}{' '}<CopyButton text={st.display} className="linkish small" />
                    </span>
                  </div>
                ))}
                <InstallScanView scan={scans[s.id]?.scan ?? null} error={scans[s.id]?.error} compact />
                <OverwriteNote existing={previews[s.id]?.existing} where={{ scope, projectPath }} />
              </li>
            ))}
          </ol>
        )}
        {step === 'confirm' && chosenHigh.length > 0 && (
          <Label className="flex items-center gap-2">
            <Checkbox checked={highChecked} onCheckedChange={(on) => setHighChecked(on === true)} />
            {t('위험 높음 {0}개({1})의 명령과 위험 신호를 확인했습니다', chosenHigh.length, chosenHigh.map((s) => s.name).join(', '))}
          </Label>
        )}

        {step === 'confirm' && (
          <CopyButton
            text={chosen.flatMap((s) => (previews[s.id]?.steps ?? []).map((st) => st.display)).join('\n')}
            label={t('명령 {0}개 모두 복사', chosen.length)}
            className="linkish small"
            title={t('터미널에서 직접 실행하거나 다른 사람에게 보낼 수 있게 명령만 복사합니다')}
          />
        )}
        {step === 'confirm' && toOverwrite.length > 0 && (
          <Label className="flex items-center gap-2">
            <Checkbox checked={overwriteChecked} onCheckedChange={(on) => setOverwriteChecked(on === true)} />
            {t('같은 이름의 기존 폴더 {0}개({1})를 덮어쓰는 것을 확인했습니다', toOverwrite.length, toOverwrite.map((s) => s.name).join(', '))}
          </Label>
        )}

        {step === 'run' && (
          <div className="flex flex-col gap-2">
            <ul className="repo-install-status">
              {chosen.map((s) => (
                <li key={s.id}>
                  {icon(status[s.id])}
                  <span className="mono">{s.name}</span>
                </li>
              ))}
            </ul>
            <div className="install-log">
              <pre ref={logRef}>{log.join('\n')}</pre>
            </div>
          </div>
        )}

        {error && <p className="warn-box">{error}</p>}

        <DialogFooter>
          {step === 'select' && (
            <Button onClick={() => void review()} disabled={busy || chosen.length === 0 || (scope === 'project' && !projectPath.trim())}>
              {busy ? t('명령 확인 중…') : t('다음: 명령 확인 ({0}개)', chosen.length)}
            </Button>
          )}
          {step === 'confirm' && (
            <>
              <Button variant="ghost" onClick={() => setStep('select')}>
                {t('뒤로')}
              </Button>
              <Button onClick={() => void run()} disabled={(chosenHigh.length > 0 && !highChecked) || (toOverwrite.length > 0 && !overwriteChecked)}>
                <DownloadSimpleIcon data-icon="inline-start" />
                {t('{0}개 설치', chosen.length)}
              </Button>
            </>
          )}
          {step === 'run' && !busy && <Button onClick={() => onOpenChange(false)}>{t('닫기')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

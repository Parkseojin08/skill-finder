import { CheckCircleIcon, CircleNotchIcon, DownloadSimpleIcon, XCircleIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { apiGet, streamNdjson } from '../api.ts';
import { METHOD } from '../labels.ts';
import type { InstallPreview, RepoResult, SettingsResponse } from '../types.ts';
import { RiskBadge } from './Badges.tsx';
import { FolderInput } from './FolderInput.tsx';

type Step = 'select' | 'confirm' | 'run';
type Status = 'wait' | 'run' | 'ok' | 'fail';
type InstallEvent = { type: 'log'; line: string; stream: string } | { type: 'result'; ok: boolean; exitCode: number; message: string };

/**
 * Installs several skills of one GitHub repo: pick skills (all installable ones by default), scope and folder,
 * review the exact command for each, then install them one by one (the server runs one install at a time).
 * Each install goes through the same /install endpoint and checks as a single skill.
 */
export function RepoInstallDialog({ repo, open, onOpenChange }: { repo: RepoResult; open: boolean; onOpenChange: (open: boolean) => void }) {
  const installable = repo.skills.filter((s) => s.installable);
  const [step, setStep] = useState<Step>('select');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(installable.map((s) => s.id)));
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [projectPath, setProjectPath] = useState('');
  const [previews, setPreviews] = useState<Record<string, InstallPreview>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep('select');
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
  const toggle = (id: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      const pairs = await Promise.all(
        chosen.map(async (s) => [s.id, await apiGet<InstallPreview>('/install/preview', { id: s.id, scope, projectPath: scope === 'user' ? undefined : projectPath })] as const),
      );
      const failed = pairs.find(([, p]) => p.error);
      if (failed) throw new Error(failed[1].error);
      setPreviews(Object.fromEntries(pairs));
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
      try {
        await streamNdjson<InstallEvent>('/install', { id: s.id, scope, projectPath: scope === 'user' ? undefined : projectPath }, (e) => {
          if (e.type === 'log') setLog((l) => [...l, e.line]);
          else {
            ok = e.ok;
            setLog((l) => [...l, e.message]);
          }
        });
      } catch (e) {
        setLog((l) => [...l, String((e as Error).message ?? e)]);
      }
      setStatus((cur) => ({ ...cur, [s.id]: ok ? 'ok' : 'fail' }));
    }
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
          <DialogTitle>{repo.repo} 설치</DialogTitle>
          <DialogDescription>
            {step === 'select' && '설치할 스킬과 범위를 고르세요. 스킬마다 따로 설치되며, 다음 단계에서 실행할 명령을 확인합니다.'}
            {step === 'confirm' && '아래 명령을 이 순서대로 실행합니다. 스킬은 에이전트 권한으로 실행되니 내용을 확인한 출처만 설치하세요.'}
            {step === 'run' && (busy ? `설치 중… ${done + failedCount}/${chosen.length}` : `완료: 성공 ${done}개${failedCount ? `, 실패 ${failedCount}개` : ''}. 다음 Claude Code 세션부터 반영됩니다.`)}
          </DialogDescription>
        </DialogHeader>

        {step === 'select' && (
          <div className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="muted small">스킬 ({chosen.length}/{installable.length})</legend>
              {repo.skills.map((s) => (
                <Label key={s.id} className="repo-skill-row">
                  <Checkbox checked={selected.has(s.id)} disabled={!s.installable} onCheckedChange={(on) => toggle(s.id, on === true)} />
                  <span className="mono">{s.name}</span>
                  <RiskBadge level={s.riskLevel} />
                  <span className="muted small">{s.installable ? METHOD[s.method] : '앱에서 설치 불가'}</span>
                </Label>
              ))}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="muted small">범위</legend>
              <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'user' | 'project')} className="flex gap-4">
                <Label className="flex items-center gap-2">
                  <RadioGroupItem value="user" /> 개인 (모든 프로젝트)
                </Label>
                <Label className="flex items-center gap-2">
                  <RadioGroupItem value="project" /> 프로젝트
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
                  <RiskBadge level={s.riskLevel} />
                </div>
                {previews[s.id]?.steps.map((st, i) => (
                  <div key={i} className="cmd cmd-stacked">
                    <code>{st.display}</code>
                    <span className="muted small">작업 폴더: {st.cwd}</span>
                  </div>
                ))}
              </li>
            ))}
          </ol>
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
              {busy ? '명령 확인 중…' : `다음: 명령 확인 (${chosen.length}개)`}
            </Button>
          )}
          {step === 'confirm' && (
            <>
              <Button variant="ghost" onClick={() => setStep('select')}>
                뒤로
              </Button>
              <Button onClick={() => void run()}>
                <DownloadSimpleIcon data-icon="inline-start" />
                {chosen.length}개 설치
              </Button>
            </>
          )}
          {step === 'run' && !busy && <Button onClick={() => onOpenChange(false)}>닫기</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

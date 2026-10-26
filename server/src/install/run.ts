import { runClaude } from '../claude/cli.ts';
import { run } from '../util/proc.ts';
import type { InstallPlan, InstallStep } from './plan.ts';

export type InstallLog = (line: string, stream?: 'stdout' | 'stderr' | 'info') => void;
export type InstallOutcome = { ok: boolean; exitCode: number; message: string; argv: string[][]; output: string };

/** Last stdout line that parses as a JSON object (`claude ... --json` prints its result there). */
export function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function parseJsonArray(stdout: string): unknown[] | null {
  const start = stdout.indexOf('[');
  if (start < 0) return null;
  try {
    const v = JSON.parse(stdout.slice(start));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const FAILURE_OUTCOMES = /fail|error|refus|denied|reject|not.?found|cancel/i;

export async function executeInstall(
  plan: InstallPlan,
  steps: InstallStep[],
  log: InstallLog,
  env: NodeJS.ProcessEnv,
): Promise<InstallOutcome> {
  const argv: string[][] = [];
  let output = '';
  const onLine = (line: string, stream: 'stdout' | 'stderr') => {
    output += line + '\n';
    log(line, stream);
  };
  const exec = async (step: InstallStep) => {
    argv.push([step.file, ...step.args]);
    log(`$ ${step.display.replace(/\s+# .*$/, '')}`, 'info');
    if (step.file === 'claude') return runClaude(step.args, { cwd: step.cwd, env, timeoutMs: 5 * 60_000, onLine });
    return run(process.execPath, step.args, { cwd: step.cwd, env, timeoutMs: 5 * 60_000, onLine });
  };

  for (const step of steps) {
    if (step.kind === 'ensure-marketplace') {
      const list = await runClaude(['plugin', 'marketplace', 'list', '--json'], { env, timeoutMs: 60_000 });
      const entries = (parseJsonArray(list.stdout) ?? []) as Array<{ name?: string; repo?: string }>;
      const name = plan.marketplace!.name;
      if (entries.some((e) => e.name === name)) {
        log(`마켓플레이스 ${name}은(는) 이미 등록되어 있습니다`, 'info');
        continue;
      }
      const r = await exec(step);
      const res = lastJsonLine(r.stdout);
      if (r.exitCode !== 0) {
        return { ok: false, exitCode: r.exitCode, message: String(res?.message ?? '마켓플레이스 등록에 실패했습니다'), argv, output };
      }
      continue;
    }
    const r = await exec(step);
    if (r.timedOut) return { ok: false, exitCode: r.exitCode, message: '시간 초과로 중단했습니다', argv, output };
    if (step.kind === 'plugin-install') {
      const res = lastJsonLine(r.stdout);
      const outcome = String(res?.outcome ?? '');
      const message = String(res?.message ?? (r.exitCode === 0 ? '설치했습니다' : '설치에 실패했습니다'));
      const ok = r.exitCode === 0 && !FAILURE_OUTCOMES.test(outcome);
      return {
        ok,
        exitCode: r.exitCode,
        message: ok ? `${message} — 다음 세션부터 또는 /reload-plugins 실행 후 반영됩니다` : message,
        argv,
        output,
      };
    }
    return {
      ok: r.exitCode === 0,
      exitCode: r.exitCode,
      message: r.exitCode === 0 ? '설치했습니다 — 새 Claude Code 세션에서 사용할 수 있습니다' : 'skills CLI가 오류로 끝났습니다',
      argv,
      output,
    };
  }
  return { ok: false, exitCode: -1, message: '실행할 단계가 없습니다', argv, output };
}

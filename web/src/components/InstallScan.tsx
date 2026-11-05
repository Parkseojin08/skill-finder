import type { InstallScan as Scan, RunConfigItem } from '../types.ts';
import { RiskFlags } from './Badges.tsx';
import { t } from '../i18n.ts';

const SKIP: Record<string, string> = { binary: t('바이너리'), large: t('256KB 초과'), limit: t('50개 넘음'), failed: t('받지 못함') };
const RUN_KIND: Record<RunConfigItem['kind'], string> = {
  hooks: t('훅 · 이벤트마다 실행하는 명령'),
  mcp: t('MCP 서버 · 켜 두는 프로그램'),
  monitors: t('모니터 · 백그라운드 명령'),
  bin: t('실행 파일 · bin/'),
};

/**
 * The text rules on a plugin's commands (feature review F3 minimal, P1): each run-config item's signals, and the
 * items with one. Older servers sent neither, so both are optional (web/src/types.ts is left as it is).
 */
type PluginConfig = Extract<Scan, { kind: 'plugin' }>['config'] & {
  findings?: Array<{ kind: RunConfigItem['kind']; source: string; flags: string[] }>;
};
const itemFlags = (it: RunConfigItem) => (it as RunConfigItem & { flags?: string[] }).flags ?? [];

/**
 * A download-and-run line in an installed file, or in a plugin's hook, MCP server or monitor command: as serious as
 * one in SKILL.md (needs the confirm tick; decision 10 for plugins).
 */
export function scanIsHigh(scan: Scan | null | undefined): boolean {
  if (scan?.kind === 'plugin') return ((scan.config as PluginConfig).findings ?? []).some((f) => f.flags.includes('curlPipeShell'));
  return scan?.kind === 'files' && scan.scan.findings.some((f) => f.flags.includes('curlPipeShell'));
}

/**
 * What the install brings besides SKILL.md (project review F1): the folder's other text files checked with the same
 * rules, or what a plugin runs once installed. `compact`: the confirm dialogs (findings and a one-line summary).
 */
export function InstallScanView({ scan, error, compact = false }: { scan: Scan | null; error?: string | null; compact?: boolean }) {
  if (error) return <p className="muted small">{t('설치될 파일을 확인하지 못했습니다: {0}', error)}</p>;
  if (!scan) return <p className="muted small">{t('설치될 파일 확인 중…')}</p>;
  if (scan.kind === 'none') return null;
  if (scan.kind === 'plugin') {
    const { items, commit } = scan.config;
    const findings = (scan.config as PluginConfig).findings ?? [];
    return (
      <div className="install-scan">
        <div className="muted small">{t('설치하면 실행되는 것')}</div>
        {findings.length > 0 && (
          <>
            <p className={scanIsHigh(scan) ? 'warn-box' : 'note'}>{t('훅·MCP 서버·모니터 명령을 같은 규칙으로 검사했습니다. 위험 신호가 있는 설정 {0}개:', findings.length)}</p>
            <ul className="scan-findings">
              {findings.map((f, i) => (
                <li key={i}>
                  <code>{f.source}</code> <RiskFlags flags={f.flags} />
                </li>
              ))}
            </ul>
          </>
        )}
        {items.length === 0 ? (
          <p className="muted small">{t('훅·MCP 서버·실행 파일이 없습니다.')}</p>
        ) : (
          items.map((it, i) => (
            <details key={i} className="scan-config" open={!compact && items.length === 1}>
              <summary>
                {RUN_KIND[it.kind]} <code>{it.source}</code> <RiskFlags flags={itemFlags(it)} />
              </summary>
              <pre>
                {it.text}
                {it.truncated && t('\n… (앞부분만 보임)')}
              </pre>
            </details>
          ))
        )}
        <p className="muted small">{t('검사한 커밋 {0}의 내용입니다. 플러그인은 설치할 때 최신을 받아 달라질 수 있습니다.', commit.slice(0, 7))}</p>
      </div>
    );
  }
  const { checked, findings, skipped, unlisted } = scan.scan;
  const reasons = Object.entries(
    skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {}),
  ).map(([r, n]) => `${SKIP[r] ?? r} ${n}`);
  return (
    <div className="install-scan">
      {!compact && <div className="muted small">{t('설치될 파일 검사')}</div>}
      <p className={findings.length ? (scanIsHigh(scan) ? 'warn-box' : 'note') : 'muted small'}>
        {t('SKILL.md 말고 함께 설치되는 텍스트 파일 {0}개를 같은 규칙으로 검사했습니다', checked)}
        {findings.length ? t('. 위험 신호가 있는 파일 {0}개:', findings.length) : t(' · 위험 신호 없음')}
        {!scan.pinned && t(' (설치는 최신 커밋을 받아 다를 수 있음)')}
      </p>
      {findings.length > 0 && (
        <ul className="scan-findings">
          {findings.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> <RiskFlags flags={f.flags} />
            </li>
          ))}
        </ul>
      )}
      {(skipped.length > 0 || unlisted > 0) && (
        <details className="muted small">
          <summary>
            {t('검사하지 않은 파일 {0}개 ({1})', skipped.length + unlisted, [...reasons, ...(unlisted ? [t('목록에 없음 {0}', unlisted)] : [])].join(', '))}
          </summary>
          <ul className="scan-skipped">
            {skipped.slice(0, 100).map((s) => (
              <li key={s.path}>
                <code>{s.path}</code> · {SKIP[s.reason] ?? s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

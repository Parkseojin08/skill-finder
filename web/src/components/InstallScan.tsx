import type { InstallScan as Scan, RunConfigItem } from '../types.ts';
import { RiskFlags } from './Badges.tsx';

const SKIP: Record<string, string> = { binary: '바이너리', large: '256KB 초과', limit: '50개 넘음', failed: '받지 못함' };
const RUN_KIND: Record<RunConfigItem['kind'], string> = {
  hooks: '훅 · 이벤트마다 실행하는 명령',
  mcp: 'MCP 서버 · 켜 두는 프로그램',
  monitors: '모니터 · 백그라운드 명령',
  bin: '실행 파일 · bin/',
};

/** A download-and-run line in an installed file: as serious as one in SKILL.md (needs the confirm tick). */
export function scanIsHigh(scan: Scan | null | undefined): boolean {
  return scan?.kind === 'files' && scan.scan.findings.some((f) => f.flags.includes('curlPipeShell'));
}

/**
 * What the install brings besides SKILL.md (project review F1): the folder's other text files checked with the same
 * rules, or what a plugin runs once installed. `compact`: the confirm dialogs (findings and a one-line summary).
 */
export function InstallScanView({ scan, error, compact = false }: { scan: Scan | null; error?: string | null; compact?: boolean }) {
  if (error) return <p className="muted small">설치될 파일을 확인하지 못했습니다: {error}</p>;
  if (!scan) return <p className="muted small">설치될 파일 확인 중…</p>;
  if (scan.kind === 'none') return null;
  if (scan.kind === 'plugin') {
    const { items, commit } = scan.config;
    return (
      <div className="install-scan">
        <div className="muted small">설치하면 실행되는 것</div>
        {items.length === 0 ? (
          <p className="muted small">훅·MCP 서버·실행 파일이 없습니다.</p>
        ) : (
          items.map((it, i) => (
            <details key={i} className="scan-config" open={!compact && items.length === 1}>
              <summary>
                {RUN_KIND[it.kind]} <code>{it.source}</code>
              </summary>
              <pre>
                {it.text}
                {it.truncated && '\n… (앞부분만 보임)'}
              </pre>
            </details>
          ))
        )}
        <p className="muted small">검사한 커밋 {commit.slice(0, 7)}의 내용입니다. 플러그인은 설치할 때 최신을 받아 달라질 수 있습니다.</p>
      </div>
    );
  }
  const { checked, findings, skipped, unlisted } = scan.scan;
  const reasons = Object.entries(
    skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {}),
  ).map(([r, n]) => `${SKIP[r] ?? r} ${n}`);
  return (
    <div className="install-scan">
      {!compact && <div className="muted small">설치될 파일 검사</div>}
      <p className={findings.length ? (scanIsHigh(scan) ? 'warn-box' : 'note') : 'muted small'}>
        SKILL.md 말고 함께 설치되는 텍스트 파일 {checked}개를 같은 규칙으로 검사했습니다
        {findings.length ? `. 위험 신호가 있는 파일 ${findings.length}개:` : ' · 위험 신호 없음'}
        {!scan.pinned && ' (설치는 최신 커밋을 받아 다를 수 있음)'}
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
            검사하지 않은 파일 {skipped.length + unlisted}개 ({[...reasons, ...(unlisted ? [`목록에 없음 ${unlisted}`] : [])].join(', ')})
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

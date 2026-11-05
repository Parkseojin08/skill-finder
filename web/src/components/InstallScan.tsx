import type { InstallScan as Scan, RunConfigItem } from '../types.ts';
import type { Evidence, HookRow, LspRow, McpRow, RunConfigTable } from '../lib/security.ts';
import { RiskFlags } from './Badges.tsx';
import { EvidenceLine } from './RiskEvidence.tsx';
import { t } from '../i18n.ts';

const SKIP: Record<string, string> = { binary: t('바이너리'), large: t('256KB 초과'), limit: t('50개 넘음'), failed: t('받지 못함') };
/** Every kind the server sends (F3 full adds LSP servers, hook scripts, command and agent documents). */
type Kind = RunConfigItem['kind'] | 'lsp' | 'script' | 'command' | 'agent';
const RUN_KIND: Record<Kind, string> = {
  hooks: t('훅 · 이벤트마다 실행하는 명령'),
  mcp: t('MCP 서버 · 켜 두는 프로그램'),
  monitors: t('모니터 · 백그라운드 명령'),
  bin: t('실행 파일 · bin/'),
  lsp: t('LSP 서버 · 파일을 열면 켜는 프로그램'),
  script: t('훅이 실행하는 스크립트'),
  command: t('명령(commands/) 문서'),
  agent: t('에이전트(agents/) 문서'),
};

/**
 * The text rules on a plugin's commands (feature review F3 minimal, P1), and with F3 full the rows a person reads and
 * each item's lines and level. Older servers sent none of these, so all are optional (web/src/types.ts is left as it is).
 */
type Item = Omit<RunConfigItem, 'kind'> & { kind: Kind; flags?: string[]; evidence?: Array<Evidence & { flag: string }>; level?: 'low' | 'medium' | 'high' };
type PluginConfig = { commit: string; items: Item[]; findings?: Array<{ kind: Kind; source: string; flags: string[] }>; table?: RunConfigTable };
type FilesScan = Extract<Scan, { kind: 'files' }>['scan'] & { evidence?: Array<Evidence & { flag: string }> };
const configOf = (scan: Extract<Scan, { kind: 'plugin' }>) => scan.config as unknown as PluginConfig;

/**
 * A download-and-run line in an installed file, or in a plugin's hook, MCP server or monitor command or a script they
 * run, or a plugin command or agent document rated high: as serious as one in SKILL.md (needs the confirm tick;
 * decision 10 for plugins). The server checks the same before installing (install/record.ts scanNeedsTick).
 */
export function scanIsHigh(scan: Scan | null | undefined): boolean {
  if (scan?.kind === 'plugin') {
    const c = configOf(scan);
    return (c.findings ?? []).some((f) => f.flags.includes('curlPipeShell')) || c.items.some((it) => it.level === 'high');
  }
  return scan?.kind === 'files' && scan.scan.findings.some((f) => f.flags.includes('curlPipeShell'));
}

const UNPINNED: Record<NonNullable<McpRow['unpinned']>, string> = {
  npx: t('버전 고정 안 됨 (npx, 버전 없음)'),
  uvx: t('버전 고정 안 됨 (uvx)'),
  pipx: t('버전 고정 안 됨 (pipx run)'),
  docker: t('버전 고정 안 됨 (docker :latest)'),
};

function HookTable({ rows }: { rows: HookRow[] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-left">
          <th className="py-1 pr-2 font-medium">{t('이벤트')}</th>
          <th className="py-1 pr-2 font-medium">matcher</th>
          <th className="py-1 pr-2 font-medium">{t('명령')}</th>
          <th className="py-1 font-medium">timeout</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-border align-top">
            <td className="py-1 pr-2">
              <code>{r.event}</code>
              {r.note === 'everyTime' && <span className="badge risk-medium ml-1">{t('매번 자동 실행')}</span>}
              {r.note === 'approval' && <span className="badge risk-medium ml-1">{t('도구 승인에 끼어듦')}</span>}
            </td>
            <td className="py-1 pr-2">{r.matcher ? <code>{r.matcher}</code> : <span className="muted">{t('전체')}</span>}</td>
            <td className="py-1 pr-2 break-all">
              <code>{r.command}</code>
            </td>
            <td className="py-1">{r.timeout != null ? t('{0}초', r.timeout) : '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function McpTable({ rows }: { rows: McpRow[] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-left">
          <th className="py-1 pr-2 font-medium">{t('이름')}</th>
          <th className="py-1 pr-2 font-medium">{t('방식')}</th>
          <th className="py-1 pr-2 font-medium">{t('명령 · 주소')}</th>
          <th className="py-1 font-medium">{t('env · 헤더 (키 이름만)')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-border align-top">
            <td className="py-1 pr-2">
              <code>{r.name}</code>
            </td>
            <td className="py-1 pr-2">{r.transport}</td>
            <td className="py-1 pr-2 break-all">
              {r.transport === 'stdio' ? <code>{[r.command ?? '', ...r.args].join(' ')}</code> : <code>{r.host ?? '?'}</code>}
              {r.unpinned && <span className="badge risk-medium ml-1">{UNPINNED[r.unpinned]}</span>}
              {r.external && <span className="badge risk-medium ml-1">{t('외부 서버로 보냄')}</span>}
            </td>
            <td className="py-1">{[...r.envKeys, ...r.headerKeys].length ? <code>{[...r.envKeys, ...r.headerKeys].join(', ')}</code> : '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LspTable({ rows }: { rows: LspRow[] }) {
  return (
    <ul className="scan-findings">
      {rows.map((r, i) => (
        <li key={i}>
          <code>{r.name}</code> · <code>{[r.command ?? '', ...r.args].join(' ')}</code>
          {r.extensions.length > 0 && <span className="muted small"> · {r.extensions.join(' ')}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The lines a finding's signals are on (F1), from the check's evidence. */
function FindingLines({ evidence }: { evidence: Array<Evidence & { flag: string }> | undefined }) {
  if (!evidence?.length) return null;
  return (
    <ul className="list-none pl-0">
      {evidence.slice(0, 10).map((e, i) => (
        <EvidenceLine key={i} e={e} />
      ))}
    </ul>
  );
}

/** The run configuration as rows a person reads (F3 full), above the raw files (folded). */
function RunTable({ table, compact }: { table: RunConfigTable; compact: boolean }) {
  const { hooks, mcp, lsp, docs } = table;
  return (
    <>
      {hooks.length > 0 && (
        <div className="mt-2">
          <div className="muted small">{t('훅 {0}개', hooks.length)}</div>
          <HookTable rows={compact ? hooks.slice(0, 10) : hooks} />
        </div>
      )}
      {mcp.length > 0 && (
        <div className="mt-2">
          <div className="muted small">{t('MCP 서버 {0}개', mcp.length)}</div>
          <McpTable rows={compact ? mcp.slice(0, 10) : mcp} />
        </div>
      )}
      {lsp.length > 0 && (
        <div className="mt-2">
          <div className="muted small">{t('LSP 서버 {0}개', lsp.length)}</div>
          <LspTable rows={lsp} />
        </div>
      )}
      {docs.commands + docs.agents + docs.scripts > 0 && (
        <p className="muted small">{t('명령 문서 {0}개, 에이전트 문서 {1}개, 훅이 실행하는 스크립트 {2}개도 같은 규칙으로 검사했습니다.', docs.commands, docs.agents, docs.scripts)}</p>
      )}
    </>
  );
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
    const { items, commit, table } = configOf(scan);
    const findings = configOf(scan).findings ?? [];
    const flagged = items.filter((it) => (it.flags ?? []).length > 0);
    return (
      <div className="install-scan">
        <div className="muted small">{t('설치하면 실행되는 것')}</div>
        {findings.length > 0 && (
          <>
            <p className={scanIsHigh(scan) ? 'warn-box' : 'note'}>{t('훅·MCP 서버·모니터 명령과 함께 들어오는 스크립트·명령 문서를 같은 규칙으로 검사했습니다. 위험 신호가 있는 것 {0}개:', findings.length)}</p>
            <ul className="scan-findings">
              {flagged.map((f, i) => (
                <li key={i}>
                  <span className="muted small">{RUN_KIND[f.kind] ?? f.kind}</span> <code>{f.source}</code> <RiskFlags flags={f.flags ?? []} />
                  {!compact && <FindingLines evidence={f.evidence} />}
                </li>
              ))}
            </ul>
          </>
        )}
        {table && <RunTable table={table} compact={compact} />}
        {items.length === 0 ? (
          <p className="muted small">{t('훅·MCP 서버·실행 파일이 없습니다.')}</p>
        ) : (
          !compact && (
            <details className="scan-config">
              <summary>{t('원문 보기 ({0}개)', items.length)}</summary>
              {items.map((it, i) => (
                <details key={i} className="scan-config">
                  <summary>
                    {RUN_KIND[it.kind] ?? it.kind} <code>{it.source}</code> <RiskFlags flags={it.flags ?? []} />
                  </summary>
                  <pre>
                    {it.text}
                    {it.truncated && t('\n… (앞부분만 보임)')}
                  </pre>
                </details>
              ))}
            </details>
          )
        )}
        <p className="muted small">{t('검사한 커밋 {0}의 내용입니다. 플러그인은 설치할 때 최신을 받아 달라질 수 있습니다.', commit.slice(0, 7))}</p>
      </div>
    );
  }
  const { checked, findings, skipped, unlisted } = scan.scan;
  const evidence = (scan.scan as FilesScan).evidence ?? [];
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
              {!compact && <FindingLines evidence={evidence.filter((e) => e.path === f.path)} />}
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

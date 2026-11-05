import { useState } from 'react';
import { RISK_FLAGS } from '../labels.ts';
import type { Evidence, FlagEvidence, PermissionKind, PermissionTableData, RiskEvidenceMap } from '../lib/security.ts';
import { t } from '../i18n.ts';

/** Signals whose places are in the plugin's run configuration (install tab), not in SKILL.md. */
const PLUGIN_FLAGS = new Set(['pluginHooks', 'pluginMcp', 'pluginBin', 'pluginMonitors', 'commandSource']);

/** "SKILL.md:12" with the line before and after it; a button when the place can be opened. */
export function EvidenceLine({ e, onOpen }: { e: Evidence; onOpen?: (e: Evidence) => void }) {
  const where = e.line != null ? `${e.path}:${e.line}` : e.path;
  return (
    <li className="my-1">
      {onOpen ? (
        <button type="button" className="linkish mono small" onClick={() => onOpen(e)} title={t('이 줄로 가서 강조합니다')}>
          {where}
        </button>
      ) : (
        <span className="mono small">{where}</span>
      )}
      {e.line != null && (
        <pre className="mt-0.5 overflow-x-auto rounded bg-muted px-2 py-1 text-xs leading-snug">
          {e.before != null && <span className="block text-muted-foreground">{e.before || ' '}</span>}
          <span className="block bg-destructive/10 font-semibold">{e.excerpt || ' '}</span>
          {e.after != null && <span className="block text-muted-foreground">{e.after || ' '}</span>}
        </pre>
      )}
    </li>
  );
}

/** One signal's places, folded: "근거 N곳 보기". */
function FlagPlaces({ flag, ev, onOpen }: { flag: string; ev: FlagEvidence | undefined; onOpen: (e: Evidence) => void }) {
  const [open, setOpen] = useState(false);
  if (!ev || ev.items.length === 0) {
    return PLUGIN_FLAGS.has(flag) ? <span className="muted small"> · {t('설치 탭의 실행 설정 표에서 확인하세요')}</span> : null;
  }
  const n = ev.items.length;
  return (
    <>
      {' '}
      <button type="button" className="linkish small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? t('근거 접기') : ev.more ? t('근거 {0}곳 이상 보기', n) : t('근거 {0}곳 보기', n)}
      </button>
      {open && (
        <ul className="list-none pl-0">
          {ev.items.map((e, i) => (
            <EvidenceLine key={i} e={e} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The risk section's list of signals with their meaning and where each was found (feature review F1). A SKILL.md
 * place opens the SKILL.md tab at that line; a file place opens the file.
 */
export function RiskExplainList({ flags, evidence, onOpen }: { flags: string[]; evidence: RiskEvidenceMap | undefined; onOpen: (e: Evidence) => void }) {
  return (
    <>
      {flags.map((f) => (
        <li key={f}>
          <b>{RISK_FLAGS[f]?.label ?? f}</b> — {RISK_FLAGS[f]?.meaning ?? ''}
          <FlagPlaces flag={f} ev={evidence?.[f]} onOpen={onOpen} />
        </li>
      ))}
    </>
  );
}

const KIND_LABEL: Record<PermissionKind, string> = {
  shell: t('셸'),
  read: t('파일 읽기'),
  write: t('파일 쓰기'),
  network: t('네트워크'),
  mcp: t('MCP'),
  autorun: t('자동 실행'),
};
const STATE_LABEL = { preapproved: t('사전 승인'), ask: t('물어봄'), none: t('없음') } as const;
const STATE_HINT = {
  preapproved: t('묻지 않고 됩니다: allowed-tools가 미리 허락했거나, 설치·호출만으로 실행됩니다.'),
  ask: t('스킬이 쓰는 흔적이 있습니다. 쓸 때 Claude Code가 먼저 허락을 묻습니다(Claude Code의 기본 규칙에 따라 묻지 않는 것도 있습니다).'),
  none: t('SKILL.md와 파일에서 흔적을 찾지 못했습니다. 그래도 필요하면 Claude Code가 묻고 쓸 수 있습니다.'),
} as const;

/**
 * What the skill may do by kind (feature review F1): shell, file read and write, network, MCP and what runs on its own,
 * each pre-approved / asks / none, with where that was seen. For a plugin it adds its other skills and parts.
 */
export function PermissionTable({ table, plugin, onOpen }: { table: PermissionTableData; plugin: boolean; onOpen: (e: Evidence) => void }) {
  const kinds = Object.keys(KIND_LABEL) as PermissionKind[];
  return (
    <div className="mt-3">
      <h3>{t('권한 요약')}</h3>
      {plugin && <p className="muted small">{t('플러그인 전체가 설치되므로 같은 플러그인의 다른 스킬과 훅·MCP 서버·LSP 서버까지 합쳤습니다.')}</p>}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1 pr-3 font-medium">{t('종류')}</th>
            <th className="py-1 pr-3 font-medium">{t('상태')}</th>
            <th className="py-1 font-medium">{t('근거')}</th>
          </tr>
        </thead>
        <tbody>
          {kinds.map((k) => {
            const cell = table[k];
            return (
              <tr key={k} className="border-t border-border align-top">
                <td className="py-1 pr-3">{KIND_LABEL[k]}</td>
                <td className="py-1 pr-3">
                  <span className={`badge ${cell.state === 'preapproved' ? 'risk-medium' : cell.state === 'ask' ? 'flag' : 'flag info'}`} title={STATE_HINT[cell.state]}>
                    {STATE_LABEL[cell.state]}
                  </span>
                </td>
                <td className="py-1">
                  {cell.evidence.length === 0 ? (
                    <span className="muted small">–</span>
                  ) : (
                    cell.evidence.map((e, i) => {
                      const where = e.line != null ? `${e.source}:${e.line}` : e.source;
                      const text = e.excerpt && e.excerpt !== e.source ? ` ${e.excerpt}` : '';
                      const openable = e.source === 'SKILL.md' && e.line != null;
                      return (
                        <span key={i} className="mr-2 inline-block">
                          {openable ? (
                            <button type="button" className="linkish mono small" onClick={() => onOpen({ path: e.source, line: e.line, excerpt: e.excerpt, before: null, after: null })}>
                              {where}
                            </button>
                          ) : (
                            <span className="mono small">{where}</span>
                          )}
                          <code className="small">{text}</code>
                        </span>
                      );
                    })
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {table.otherTools.length > 0 && <p className="muted small">{t('그 밖에 미리 허락한 도구: {0}', table.otherTools.join(', '))}</p>}
      <p className="muted small">{t('규칙으로 찾은 흔적입니다. 스킬이 실제로 하는 일을 모두 보여 주지는 않습니다.')}</p>
    </div>
  );
}

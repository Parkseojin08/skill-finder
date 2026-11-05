// The 설치됨 screen's "자동 실행·권한" tab (feature review F10): what the agents on this PC run without asking, what
// they approve ahead, and their commands and agents, read from their own config files. Shown only: nothing is fixed
// from here, a row's file path is there to copy.
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../api.ts';
import { t } from '../i18n.ts';
import {
  AGENT_KEYS,
  AGENT_NAME,
  compareMcp,
  MCP_FILE,
  mcpSnippet,
  presentAgents,
  sourceText,
  type AgentConfigResponse,
  type AgentKey,
  type FileState,
  type PermKind,
  type RunKind,
  type RunRow,
  type Source,
} from '../lib/agentConfigView.ts';
import { RiskFlags } from './Badges.tsx';
import { CopyButton } from './CopyButton.tsx';

const KIND: Record<RunKind, string> = {
  hook: t('훅'),
  mcp: t('MCP 서버'),
  monitor: t('모니터'),
  lsp: t('LSP 서버'),
  statusLine: t('상태 줄'),
  helper: t('도우미 명령'),
};
const PERM_KIND: Record<PermKind, string> = {
  allow: t('허용 규칙'),
  defaultMode: t('기본 권한 모드'),
  directory: t('추가 폴더'),
  approval: t('승인 정책'),
  sandbox: t('샌드박스'),
  network: t('네트워크 허용'),
  trust: t('신뢰'),
  autoAccept: t('자동 수락'),
  disableAllHooks: t('모든 훅 끔'),
};
const SCOPE: Record<string, string> = { user: t('개인'), project: t('프로젝트'), local: t('로컬') };
const REASON: Record<NonNullable<FileState['reason']>, string> = {
  tooLarge: t('너무 큼 (8MB 넘음)'),
  tooManyLines: t('줄이 너무 많음'),
  format: t('형식을 읽지 못함'),
  io: t('열지 못함'),
};
/** Events that run on every session or prompt, and those that sit in a tool's approval (feature review F3). */
const EVERY_TIME = new Set(['sessionstart', 'userpromptsubmit', 'beforeagent']);
const IN_APPROVAL = new Set(['pretooluse', 'permissionrequest', 'beforetool']);

function SourceCell({ source }: { source: Source }) {
  return (
    <>
      <div className="small">
        {source.scope === 'plugin' ? t('플러그인 {0}', (source.plugin ?? '').replace(/@.*$/, '')) : (SCOPE[source.scope] ?? source.scope)}
      </div>
      <div className="muted small mono break-all">{sourceText(source)}</div>
      <CopyButton text={source.file} label={t('경로 복사')} className="linkish small" />
    </>
  );
}

function RunMarks({ row }: { row: RunRow }) {
  const event = row.kind === 'hook' ? row.name.toLowerCase() : '';
  return (
    <div className="flex flex-wrap gap-1">
      <RiskFlags flags={row.flags} />
      {row.unpinned && (
        <span className="badge flag" title={t('실행할 때마다 그때의 최신 버전을 받아 실행합니다. 패키지·이미지가 바뀌면 다른 코드가 실행됩니다.')}>
          {t('버전 고정 안 됨 ({0})', row.unpinned)}
        </span>
      )}
      {row.host && (
        <span className="badge flag" title={t('대화 내용과 도구 입력이 이 서버로 갑니다.')}>
          {t('외부 서버로 보냄: {0}', row.host)}
        </span>
      )}
      {EVERY_TIME.has(event) && <span className="badge flag info">{t('매번 자동 실행')}</span>}
      {IN_APPROVAL.has(event) && <span className="badge flag info">{t('도구 승인에 끼어듦')}</span>}
      {row.state === 'off' && <span className="badge flag info">{t('꺼짐')}</span>}
      {row.state === 'ask' && (
        <span className="badge flag info" title={t('프로젝트 .mcp.json의 서버는 처음 쓸 때 Claude Code가 물어봅니다.')}>
          {t('아직 승인 안 됨')}
        </span>
      )}
    </div>
  );
}

export function AgentConfigTab({ projectPath }: { projectPath: string }) {
  const [cfg, setCfg] = useState<AgentConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [agent, setAgent] = useState<AgentKey | 'all'>('all');
  const seq = useRef(0);

  const load = () => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    apiGet<AgentConfigResponse>('/agent-config', { projectPath: projectPath || undefined })
      .then((d) => id === seq.current && setCfg(d))
      .catch((e) => id === seq.current && setError(String(e.message ?? e)))
      .finally(() => id === seq.current && setLoading(false));
  };
  useEffect(load, [projectPath]);

  if (error) return <p className="warn-box">{error}</p>;
  if (!cfg) return <p className="muted small">{loading ? t('불러오는 중…') : ''}</p>;

  const of = <T extends { source: Source }>(list: T[]) => (agent === 'all' ? list : list.filter((r) => r.source.agent === agent));
  const run = of(cfg.run);
  const perms = of(cfg.permissions);
  const comps = of(cfg.components);
  const unreadable = cfg.files.filter((f) => f.state === 'unreadable');
  const read = cfg.files.filter((f) => f.state === 'read');
  const agents = presentAgents(cfg);
  const compare = compareMcp(cfg, agents);
  const counts = new Map<AgentKey, number>();
  for (const r of [...cfg.run, ...cfg.permissions, ...cfg.components]) counts.set(r.source.agent, (counts.get(r.source.agent) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-6">
      <p className="muted small">
        {t('에이전트 설정 파일에 적힌 자동 실행(훅·MCP 서버·모니터)과 미리 승인한 권한입니다. 파일을 읽기만 하고 고치지 않으며, 서버를 띄우지도 않습니다. 고치려면 출처 파일을 직접 여세요.')}
      </p>
      <div className="examples">
        <span className="muted small">{t('에이전트:')}</span>
        {(['all', ...AGENT_KEYS] as const).map((a) => (
          <button key={a} type="button" className={`chip-btn${agent === a ? ' current' : ''}`} aria-pressed={agent === a} onClick={() => setAgent(a)} disabled={a !== 'all' && !counts.get(a)}>
            {a === 'all' ? t('전체') : AGENT_NAME[a]} <span className="muted small">{a === 'all' ? cfg.run.length + cfg.permissions.length + cfg.components.length : (counts.get(a) ?? 0)}</span>
          </button>
        ))}
        <button type="button" className="ghost" onClick={load} disabled={loading}>
          {loading ? t('불러오는 중…') : t('다시 읽기')}
        </button>
      </div>
      {unreadable.length > 0 && (
        <div className="warn-box">
          <p>{t('읽지 못한 설정 파일 {0}개: 형식이 비공개이거나 바뀌었을 수 있어 내용을 추측하지 않았습니다.', unreadable.length)}</p>
          <ul>
            {unreadable.map((f) => (
              <li key={f.path} className="small">
                {AGENT_NAME[f.agent]} · <span className="mono break-all">{f.path}</span> — {f.reason ? REASON[f.reason] : t('열지 못함')}
                {f.detail ? ` (${f.detail})` : ''} <CopyButton text={f.path} label={t('경로 복사')} className="linkish small" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {cfg.truncated && <p className="muted small">{t('항목이 너무 많아 묶음마다 앞의 1,000개만 보입니다.')}</p>}

      <section>
        <h2>{t('묻지 않고 실행 ({0})', run.length)}</h2>
        <p className="muted small">{t('훅·MCP 서버·모니터·상태 줄은 Claude Code(또는 그 에이전트)가 사용자에게 묻지 않고 실행합니다.')}</p>
        {run.length === 0 ? (
          <p className="muted small">{t('없습니다.')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('종류')}</th>
                <th>{t('이름')}</th>
                <th>{t('명령')}</th>
                <th>{t('표시')}</th>
                <th>{t('출처')}</th>
              </tr>
            </thead>
            <tbody>
              {run.map((r, i) => (
                <tr key={`${r.source.file}:${r.kind}:${r.name}:${i}`}>
                  <td className="small">
                    {KIND[r.kind]}
                    <div className="muted small">{AGENT_NAME[r.source.agent]}</div>
                  </td>
                  <td>
                    <b className="mono">{r.name}</b>
                    {r.matcher && <div className="muted small mono">{t('대상: {0}', r.matcher)}</div>}
                    {r.hookType && r.hookType !== 'command' && <div className="muted small">{t('방식: {0}', r.hookType)}</div>}
                  </td>
                  <td className="small">
                    {r.command ? <code className="mono break-all">{r.command}</code> : r.host ? <span className="mono">{r.host}</span> : <span className="muted">–</span>}
                    {r.envKeys.length > 0 && <div className="muted small mono break-all">{t('환경 변수: {0}', r.envKeys.join(', '))}</div>}
                    {r.headerKeys.length > 0 && <div className="muted small mono">{t('헤더: {0}', r.headerKeys.join(', '))}</div>}
                  </td>
                  <td>
                    <RunMarks row={r} />
                  </td>
                  <td>
                    <SourceCell source={r.source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>{t('사전 승인 권한 ({0})', perms.length)}</h2>
        <p className="muted small">{t('여기 적힌 도구는 사용할 때 묻지 않습니다. "넓음"은 Bash 전체·WebFetch·쓰기처럼 도구 하나를 통째로 허용한 규칙입니다.')}</p>
        {perms.length === 0 ? (
          <p className="muted small">{t('없습니다.')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('규칙')}</th>
                <th>{t('종류')}</th>
                <th>{t('표시')}</th>
                <th>{t('출처')}</th>
              </tr>
            </thead>
            <tbody>
              {perms.map((p, i) => (
                <tr key={`${p.source.file}:${p.kind}:${p.value}:${i}`}>
                  <td>
                    <code className="mono break-all">{p.value}</code>
                  </td>
                  <td className="small">
                    {PERM_KIND[p.kind]}
                    <div className="muted small">{AGENT_NAME[p.source.agent]}</div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {p.note === 'broad' && <span className="badge flag">{t('넓음')}</span>}
                      {p.note === 'sensitive' && <span className="badge flag">{t('민감한 경로')}</span>}
                      <RiskFlags flags={p.flags} />
                    </div>
                  </td>
                  <td>
                    <SourceCell source={p.source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>{t('스킬·명령·에이전트 ({0})', comps.length)}</h2>
        <p className="muted small">{t('사용자·프로젝트 폴더와 켜진 플러그인의 명령(commands)과 하위 에이전트(agents)입니다. 스킬은 "설치한 것" 탭에 있습니다.')}</p>
        {comps.length === 0 ? (
          <p className="muted small">{t('없습니다.')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('이름')}</th>
                <th>{t('종류')}</th>
                <th>{t('미리 승인한 도구')}</th>
                <th>{t('위험 신호')}</th>
                <th>{t('출처')}</th>
              </tr>
            </thead>
            <tbody>
              {comps.map((c) => (
                <tr key={c.path}>
                  <td>
                    <b className="mono">{c.kind === 'command' ? `/${c.name}` : c.name}</b>
                  </td>
                  <td className="small">{c.kind === 'command' ? t('명령') : t('에이전트')}</td>
                  <td className="small mono break-all">{c.allowedTools.length ? c.allowedTools.join(', ') : <span className="muted">–</span>}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <RiskFlags flags={c.flags} />
                    </div>
                  </td>
                  <td>
                    <SourceCell source={c.source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cfg.plugins.some((p) => !p.enabled) && (
          <p className="muted small">{t('꺼진 플러그인 {0}개의 구성요소는 읽지 않았습니다: {1}', cfg.plugins.filter((p) => !p.enabled).length, cfg.plugins.filter((p) => !p.enabled).map((p) => p.id).join(', '))}</p>
        )}
      </section>

      <section>
        <h2>{t('에이전트 비교 (MCP 서버)')}</h2>
        <p className="muted small">{t('설정 파일이 있는 에이전트끼리 MCP 서버를 이름으로 맞춰 봅니다. 없는 쪽에는 그 에이전트 형식으로 바꾼 조각을 복사할 수 있습니다. 환경 변수·헤더 값과 원격 주소의 경로는 앱이 읽지 않으므로 직접 채우세요.')}</p>
        {compare.length === 0 ? (
          <p className="muted small">{t('MCP 서버가 없습니다.')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('서버')}</th>
                {agents.map((a) => (
                  <th key={a}>{AGENT_NAME[a]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compare.map((row) => {
                const from = row.servers.claude ?? Object.values(row.servers)[0]!;
                return (
                  <tr key={row.name}>
                    <td>
                      <b className="mono">{row.name}</b>
                    </td>
                    {agents.map((a) => (
                      <td key={a} className="small">
                        {row.servers[a] ? (
                          <span className="state-on">{t('있음')}</span>
                        ) : (
                          <>
                            <span className="muted">{t('없음')}</span>{' '}
                            <CopyButton text={mcpSnippet(from, a)} label={t('{0} 형식 복사', AGENT_NAME[a])} className="linkish small" title={MCP_FILE[a]} />
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <details>
        <summary className="muted small">{t('읽은 설정 파일 {0}개 · 없는 파일 {1}개', read.length, cfg.files.filter((f) => f.state === 'missing').length)}</summary>
        <ul>
          {cfg.files.map((f, i) => (
            <li key={`${f.path}:${i}`} className="small">
              <span className={f.state === 'read' ? 'state-on' : 'muted'}>{f.state === 'read' ? t('읽음') : f.state === 'missing' ? t('없음') : t('읽지 못함')}</span> · {AGENT_NAME[f.agent]}
              {f.plugin ? ` · ${f.plugin}` : ''} · <span className="mono break-all">{f.path}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

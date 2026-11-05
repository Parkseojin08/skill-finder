import { ArrowsClockwiseIcon, CheckCircleIcon, CircleNotchIcon, WarningIcon, WifiSlashIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { refreshActivity, useActivity } from '../activity.ts';
import { formatAgo } from '../labels.ts';
import { serverText, t } from '../i18n.ts';
import {
  formatEvery,
  formatRelative,
  LIMIT_LABEL,
  reasonText,
  RUN_STATUS_LABEL,
  taskLabel,
  TRIGGER_LABEL,
  type AgeBuckets,
  type Limit,
  type Status,
} from '../status.ts';
import '../status.css';

const POLL_MS = 10_000;

/** "오늘 N · 일주일 N · 한 달 N · 그 이전 N · 없음 N" with the empty groups left out. */
function Ages({ a }: { a: AgeBuckets }) {
  if (a.total === 0) return <span className="muted">{t('없음')}</span>;
  const parts: Array<[string, number]> = [
    [t('하루 안 {0}', a.day), a.day],
    [t('일주일 안 {0}', a.week), a.week],
    [t('한 달 안 {0}', a.month), a.month],
    [t('그 이전 {0}', a.older), a.older],
    [t('안 함 {0}', a.never), a.never],
  ];
  return (
    <span>
      {parts
        .filter(([, n]) => n > 0)
        .map(([s]) => s)
        .join(' · ')}
    </span>
  );
}

function LimitBar({ l }: { l: Limit }) {
  const label = LIMIT_LABEL[l.resource] ?? l.resource;
  if (l.remaining == null) {
    return (
      <div className="limit-row">
        <span className="limit-name">{label}</span>
        <span className="muted small">{t('아직 모름')}</span>
      </div>
    );
  }
  const max = l.limit ?? Math.max(l.remaining, 1);
  const pct = Math.max(0, Math.min(100, Math.round((l.remaining / max) * 100)));
  const resetIso = l.reset ? new Date(l.reset * 1000).toISOString() : null;
  const resetPassed = !!resetIso && Date.parse(resetIso) < Date.now();
  return (
    <div className="limit-row">
      <span className="limit-name">{label}</span>
      <span className={`limit-bar ${pct < 10 ? 'low' : pct < 30 ? 'mid' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={l.remaining} aria-label={label}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="small mono">
        {l.limit != null ? `${l.remaining.toLocaleString()} / ${l.limit.toLocaleString()}` : l.remaining.toLocaleString()}
      </span>
      <span className="muted small">{resetIso && !resetPassed ? t('{0} 회복', formatRelative(resetIso)) : resetPassed ? t('회복됨') : ''}</span>
    </div>
  );
}

/**
 * The marketplace screen's "상태" (user decision 3): how fresh the index is, GitHub's quotas, the background tasks and
 * their recent runs, with "지금 실행".
 */
export function StatusPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const activity = useActivity();
  const runningCount = activity?.running.length ?? 0;

  const load = useCallback(
    () =>
      apiGet<Status>('/status')
        .then((s) => {
          setStatus(s);
          setError(null);
        })
        .catch((e) => setError(String((e as Error).message ?? e))),
    [],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  // a task starting or ending shows at once
  useEffect(() => {
    void load();
  }, [runningCount, load]);

  const runNow = async (kind: string) => {
    try {
      await apiSend('POST', `/tasks/${encodeURIComponent(kind)}/run`);
      setMsg({ ok: true, text: t('{0}을(를) 시작했습니다', taskLabel(kind)) });
      await refreshActivity();
      await load();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
  };

  if (!status) {
    return (
      <section id="status" className="status-panel">
        <h2>{t('상태')}</h2>
        {error ? <p className="warn-box">{error}</p> : <p className="muted">{t('불러오는 중…')}</p>}
      </section>
    );
  }

  const { freshness, sources, github, tasks, runs, network } = status;
  const good = freshness.level === 'good';
  const translateText = sources.translate
    .map((m) => `${m.lang} ${m.state === 'ready' ? t('준비됨') : m.state === 'downloading' ? t('받는 중') : m.state === 'error' ? t('오류') : t('없음')}`)
    .join(' · ');

  return (
    <section id="status" className="status-panel">
      <h2>{t('상태')}</h2>
      <div role="status">{msg && <p className={msg.ok ? 'ok-box' : 'warn-box'}>{msg.text}</p>}</div>

      <div className={`status-summary ${good ? 'good' : 'stale'}`}>
        {good ? <CheckCircleIcon size={22} weight="bold" aria-hidden /> : <WarningIcon size={22} weight="bold" aria-hidden />}
        <div>
          <b>{good ? t('색인 신선도: 좋음') : t('색인 신선도: 오래됨')}</b>
          {freshness.reasons.length > 0 && (
            <ul className="small">
              {freshness.reasons.map((r, i) => (
                <li key={i}>{reasonText(r)}</li>
              ))}
            </ul>
          )}
          {network.offline && (
            <p className="small status-offline">
              <WifiSlashIcon size={14} aria-hidden /> {t('오프라인 · 네트워크 작업은 연결되면 바로 다시 돕니다 ({0}부터)', formatAgo(network.since))}
            </p>
          )}
          {status.nextDue && (
            <p className="muted small">{t('다음 예정: {0} · {1}', taskLabel(status.nextDue.kind, status.nextDue.label), formatRelative(status.nextDue.at))}</p>
          )}
        </div>
      </div>

      <div className="status-grid">
        <div>
          <h3>{t('출처별 신선도')}</h3>
          <dl className="kv small">
            {sources.marketplaces
              .filter((m) => m.enabled)
              .map((m) => (
                <div key={m.name} className="kv-row">
                  <dt>{m.name}</dt>
                  <dd>
                    {m.syncedAt ? t('동기화 {0}', formatRelative(m.syncedAt)) : t('동기화 안 함')}
                    {m.commit && <span className="mono muted"> · {m.commit.slice(0, 7)}</span>}
                    {m.error && <span className="warn-text"> · {serverText(m.error)}</span>}
                  </dd>
                </div>
              ))}
            <div className="kv-row">
              <dt>{t('플러그인 색인')}</dt>
              <dd>
                <Ages a={sources.pluginIndex} />
              </dd>
            </div>
            <div className="kv-row">
              <dt>{t('별 정보')}</dt>
              <dd>{github.hasToken ? <Ages a={sources.stars} /> : <span className="muted">{t('토큰이 없어 갱신하지 않음')}</span>}</dd>
            </div>
            <div className="kv-row">
              <dt>{t('옛 위험 규칙')}</dt>
              <dd>{sources.oldRiskRules > 0 ? t('{0}행 (규칙 v{1} 전)', sources.oldRiskRules.toLocaleString(), sources.riskRulesVersion) : t('없음')}</dd>
            </div>
            <div className="kv-row">
              <dt>{t('미리 만든 색인')}</dt>
              <dd>{sources.seedCreatedAt ? sources.seedCreatedAt.slice(0, 10) : t('없음')}</dd>
            </div>
            <div className="kv-row">
              <dt>{t('인기 저장소')}</dt>
              <dd>{sources.popular.lastRunAt ? t('{0} · 스킬 {1}개', formatRelative(sources.popular.lastRunAt), sources.popular.skills.toLocaleString()) : t('아직 수집하지 않았습니다.')}</dd>
            </div>
            <div className="kv-row">
              <dt>{t('번역 모델')}</dt>
              <dd>{translateText}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h3>{t('GitHub 한도')}</h3>
          {!github.hasToken && <p className="muted small">{t('토큰이 없으면 시간당 60회입니다.')}</p>}
          {github.limits.map((l) => (
            <LimitBar key={l.resource} l={l} />
          ))}
          <p className="muted small">{t('앱이 GitHub를 부를 때 받은 남은 수입니다. 설정에서 토큰을 저장하면 다시 확인합니다.')}</p>
        </div>
      </div>

      <h3>{t('작업')}</h3>
      <table className="table status-tasks">
        <thead>
          <tr>
            <th>{t('작업')}</th>
            <th>{t('주기')}</th>
            <th>{t('마지막 성공')}</th>
            <th>{t('다음 예정')}</th>
            <th>
              <span className="sr-only">{t('지금 실행')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.kind}>
              <td>
                <b>{taskLabel(task.kind, task.label)}</b>
                {task.failCount > 0 && <div className="warn-text small">{t('{0}번 잇달아 실패', task.failCount)}</div>}
              </td>
              <td className="small">{task.manualOnly ? t('직접 실행만') : formatEvery(task.everyMs)}</td>
              <td className="small">{formatRelative(task.lastSuccessAt)}</td>
              <td className="small">
                {task.running ? (
                  <span className="status-running">
                    <CircleNotchIcon size={14} className="spin" aria-hidden /> {t('진행 중')}
                  </span>
                ) : task.network && network.offline ? (
                  t('연결되면')
                ) : task.manualOnly ? (
                  '–'
                ) : (
                  formatRelative(task.nextDueAt)
                )}
              </td>
              <td className="actions">
                {task.manual && (
                  <button type="button" className="ghost" disabled={task.running} onClick={() => void runNow(task.kind)}>
                    <ArrowsClockwiseIcon size={14} aria-hidden /> {t('지금 실행')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <details className="status-runs">
        <summary>{t('최근 실행 {0}건', runs.length)}</summary>
        <table className="table small">
          <thead>
            <tr>
              <th>{t('작업')}</th>
              <th>{t('시작')}</th>
              <th>{t('결과')}</th>
              <th>{t('내용')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{taskLabel(r.kind)}</td>
                <td>
                  {formatRelative(r.startedAt)} <span className="muted">· {TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
                </td>
                <td className={r.status === 'failed' ? 'warn-text' : r.status === 'ok' ? 'ok-text' : 'muted'}>{RUN_STATUS_LABEL[r.status] ?? r.status}</td>
                <td>
                  {r.counts && (
                    <span className="mono muted">
                      {Object.entries(r.counts)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ')}
                    </span>
                  )}
                  {/* a failure's error, or the short note a run that went well left (in the same column) */}
                  {r.error && <div className={r.status === 'failed' ? 'warn-text' : 'muted'}>{serverText(r.error)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

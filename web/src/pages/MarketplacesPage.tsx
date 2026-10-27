import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { formatAgo } from '../labels.ts';
import type { Job, MarketplaceInfo } from '../types.ts';

type Act = <T>(p: Promise<T>, okText: string, after?: (r: T) => void) => Promise<void>;

const JOB_STATUS: Record<Job['status'], string> = { running: '진행 중', paused: '일시정지', done: '완료', error: '오류', cancelled: '중단됨' };
const POPULAR_LABEL = 'popular-repos';
const jobLabel = (j: Job) => (j.label === POPULAR_LABEL ? '인기 저장소' : j.label === '*' ? '전체' : j.label);

type PopularStatus = { lastRunAt: string | null; repos: number; withSkills: number; skills: number };

/** GitHub repos with many stars that hold skills; their skills are indexed so the minimum-stars filter keeps results. */
function PopularReposSection({ job, act }: { job?: Job; act: Act }) {
  const [status, setStatus] = useState<PopularStatus | null>(null);
  useEffect(() => {
    apiGet<PopularStatus>('/popular-repos').then(setStatus).catch(() => {});
  }, [job?.status, job?.done]);
  return (
    <section>
      <h2>인기 저장소</h2>
      <p className="muted small">
        GitHub에서 스타가 많은(설정의 최소 스타 이상) 스킬 저장소를 찾아 스킬을 미리 모아 둡니다. 전체 동기화 뒤 하루에 한 번 자동으로 돌고, 같은 저장소는 일주일에
        한 번만 다시 확인합니다.
      </p>
      <div className="row">
        <span className="small">
          {status?.lastRunAt
            ? `저장소 ${status.repos}개 확인 · 스킬이 있는 저장소 ${status.withSkills}개 · 스킬 ${status.skills.toLocaleString()}개 · ${formatAgo(status.lastRunAt)}`
            : '아직 수집하지 않았습니다.'}
          {job && ` · 수집 중 ${job.done}/${job.total || '?'}`}
        </span>
        <span className="spacer" />
        <button type="button" disabled={!!job} onClick={() => act(apiSend('POST', '/popular-repos/collect', {}), '인기 저장소 수집을 시작했습니다')}>
          {job ? '수집 중…' : '지금 수집'}
        </button>
      </div>
    </section>
  );
}

export function MarketplacesPage() {
  const [list, setList] = useState<MarketplaceInfo[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newRepo, setNewRepo] = useState('');
  const [newMode, setNewMode] = useState<'eager' | 'lazy'>('lazy');

  const loadList = useCallback(() => apiGet<{ marketplaces: MarketplaceInfo[] }>('/marketplaces').then((r) => setList(r.marketplaces)), []);

  const refreshJobs = useCallback(async () => {
    const j = await apiGet<{ jobs: Job[] }>('/jobs').catch(() => ({ jobs: [] as Job[] }));
    setJobs(j.jobs);
    return j.jobs.some((x) => x.status === 'running' || x.status === 'paused');
  }, []);

  useEffect(() => {
    loadList().catch((e) => setMsg({ ok: false, text: String(e.message ?? e) }));
    let timer: ReturnType<typeof setTimeout>;
    let wasActive = false;
    const tick = async () => {
      const active = await refreshJobs();
      if (active || wasActive) loadList().catch(() => {});
      wasActive = active;
      timer = setTimeout(tick, active ? 1500 : 5000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [loadList, refreshJobs]);

  const act: Act = async (p, okText, after) => {
    try {
      const r = await p;
      after?.(r);
      setMsg({ ok: true, text: okText });
      refreshJobs();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
  };

  const jobFor = (kind: Job['kind'], label: string) => jobs.find((j) => j.kind === kind && j.label === label && (j.status === 'running' || j.status === 'paused'));

  return (
    <div className="page">
      <h1>마켓플레이스</h1>
      <p className="muted">스킬을 찾아올 플러그인 마켓플레이스를 관리합니다. 즉시 색인은 동기화할 때 스킬까지 모으고, 지연 색인은 목록만 받아 두었다가 검색에 걸리거나 "스킬 수집"을 누를 때 모읍니다.</p>
      {msg && <p className={msg.ok ? 'ok-box' : 'warn-box'}>{msg.text}</p>}

      <section>
        <h2>목록</h2>
        {!list && <p className="muted">불러오는 중…</p>}
        {list && (
          <table className="table">
            <thead>
              <tr>
                <th>사용</th>
                <th>이름 / 저장소</th>
                <th>색인 방식</th>
                <th>플러그인</th>
                <th>동기화</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <MarketplaceRow key={m.name} m={m} job={jobFor('collect', m.name) ?? jobFor('sync', m.name) ?? jobFor('sync', '*')} onChange={setList} act={act} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <PopularReposSection job={jobFor('collect', POPULAR_LABEL)} act={act} />

      <section>
        <h2>마켓플레이스 추가</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            act(apiSend<{ marketplaces: MarketplaceInfo[] }>('POST', '/marketplaces', { repo: newRepo, indexMode: newMode }), '마켓플레이스를 추가하고 동기화를 시작했습니다', (r) => {
              setNewRepo('');
              setList(r.marketplaces);
            });
          }}
        >
          <input value={newRepo} onChange={(e) => setNewRepo(e.target.value)} placeholder="owner/repo 또는 GitHub URL" spellCheck={false} />
          <select value={newMode} onChange={(e) => setNewMode(e.target.value as 'eager' | 'lazy')} aria-label="색인 방식">
            <option value="lazy">지연 색인</option>
            <option value="eager">즉시 색인</option>
          </select>
          <button type="submit" disabled={!newRepo.trim()}>
            추가
          </button>
        </form>
      </section>

      {jobs.length > 0 && (
        <section>
          <h2>최근 작업</h2>
          <ul className="jobs">
            {jobs.slice(0, 8).map((j) => (
              <li key={j.id}>
                <b>{j.kind === 'sync' ? '동기화' : '스킬 수집'}</b> {jobLabel(j)} · {JOB_STATUS[j.status]} · {j.done}/{j.total}
                {j.errors.length > 0 && (
                  <details>
                    <summary className="small">오류 {j.errors.length}건</summary>
                    <ul className="small">
                      {j.errors.slice(0, 20).map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {(j.skipped?.length ?? 0) > 0 && (
                  <details className="muted">
                    <summary className="small">설치 불가 {j.skipped!.length}개 · 마켓플레이스 항목이 가리키는 저장소·커밋·폴더가 없음</summary>
                    <ul className="small">
                      {j.skipped!.slice(0, 50).map((e, i) => (
                        <li key={i}>{e.replace(/: 설치 불가: |: /, ' — ')}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MarketplaceRow({ m, job, onChange, act }: { m: MarketplaceInfo; job?: Job; onChange: (r: MarketplaceInfo[]) => void; act: Act }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patch = (body: Partial<{ enabled: boolean; indexMode: string }>) =>
    act(apiSend<{ marketplaces: MarketplaceInfo[] }>('PATCH', `/marketplaces/${encodeURIComponent(m.name)}`, body), '변경했습니다', (r) => onChange(r.marketplaces));
  return (
    <tr>
      <td>
        <input type="checkbox" checked={m.enabled} onChange={(e) => patch({ enabled: e.target.checked })} aria-label={`${m.name} 사용`} />
      </td>
      <td>
        <b>{m.name}</b>
        <div className="muted small">{m.repo}</div>
        {m.error && <div className="warn-text small">{m.error}</div>}
      </td>
      <td>
        <select value={m.indexMode} onChange={(e) => patch({ indexMode: e.target.value })} aria-label="색인 방식">
          <option value="eager">즉시</option>
          <option value="lazy">지연</option>
        </select>
      </td>
      <td>
        {m.pluginCount ?? '–'}
        {m.pendingSkillIndex > 0 && <div className="muted small">스킬 미수집 {m.pendingSkillIndex}</div>}
      </td>
      <td className="small">{m.syncedAt ? formatAgo(m.syncedAt) : '안 함'}</td>
      <td className="actions">
        {job ? (
          <>
            <span className="small">
              {job.kind === 'sync' ? '동기화' : '수집'} {job.done}/{job.total} {job.status === 'paused' ? '(일시정지)' : ''}
            </span>
            {job.status === 'running' && (
              <button type="button" className="ghost" onClick={() => act(apiSend('POST', `/jobs/${job.id}/pause`), '일시정지했습니다')}>
                일시정지
              </button>
            )}
            {job.status === 'paused' && (
              <button type="button" className="ghost" onClick={() => act(apiSend('POST', `/jobs/${job.id}/resume`), '다시 시작했습니다')}>
                재개
              </button>
            )}
            <button type="button" className="ghost" onClick={() => act(apiSend('POST', `/jobs/${job.id}/cancel`), '중단했습니다')}>
              중단
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ghost" onClick={() => act(apiSend('POST', '/sync', { marketplace: m.name }), '동기화를 시작했습니다')}>
              동기화
            </button>
            {m.pendingSkillIndex > 0 && (
              <button type="button" className="ghost" onClick={() => act(apiSend('POST', '/collect', { marketplace: m.name }), '스킬 수집을 시작했습니다')}>
                스킬 수집
              </button>
            )}
            <button type="button" className="ghost danger" onClick={() => setConfirmDelete(true)}>
              삭제
            </button>
          </>
        )}
        {confirmDelete && (
          <ConfirmDialog
            title={`${m.name} 마켓플레이스 삭제`}
            confirmLabel="삭제"
            danger
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => {
              setConfirmDelete(false);
              act(apiSend<{ marketplaces: MarketplaceInfo[] }>('DELETE', `/marketplaces/${encodeURIComponent(m.name)}`), '삭제했습니다', (r) => onChange(r.marketplaces));
            }}
          >
            <p>목록에서 이 마켓플레이스와 색인된 스킬을 지웁니다.</p>
            <p className="muted small">이미 설치한 플러그인은 그대로 남습니다.</p>
          </ConfirmDialog>
        )}
      </td>
    </tr>
  );
}

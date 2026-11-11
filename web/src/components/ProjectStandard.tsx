// 설치됨 › 프로젝트 표준 (feature review F12): the chosen folder's skills-lock.json and .claude/settings.json set
// against what is installed for it. Shown first (decision 20); what is missing installs through the team preset's
// dialog — the same commands, file checks and risk ticks — never straight from this panel.
import { useEffect, useState } from 'react';
import { apiGet } from '../api.ts';
import { t } from '../i18n.ts';
import {
  failingCount,
  HASH_NOTE,
  KIND_LABEL,
  sortStandardItems,
  STATUS_HELP,
  STATUS_LABEL,
  type ProjectStandardResponse,
  type StandardItem,
  type StandardStatus,
} from '../lib/projects.ts';
import { CopyButton } from './CopyButton.tsx';
import { PresetInstallDialog, resolvePreset, type ResolvedPreset } from './TeamPreset.tsx';
import '../projects.css';

const TONE: Record<StandardStatus, 'ok' | 'warn' | 'danger' | 'muted'> = {
  ok: 'ok',
  missing: 'danger',
  differs: 'warn',
  extra: 'muted',
  disabled: 'warn',
  unregistered: 'danger',
};
const STATUSES: StandardStatus[] = ['missing', 'unregistered', 'differs', 'disabled', 'extra', 'ok'];
const FILE_STATE = { read: t('읽음'), missing: t('없음'), unreadable: t('읽지 못함') } as const;

function Status({ status }: { status: StandardStatus }) {
  return (
    <span className={`std-status ${TONE[status]}`} title={STATUS_HELP[status]}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function ItemDetail({ item }: { item: StandardItem }) {
  if (item.kind === 'marketplace') return <span className="muted small mono break-all">{item.marketplace ?? ''}</span>;
  if (item.kind === 'plugin') return <span className="muted small">{item.marketplace ? t('마켓 {0}', item.marketplace) : ''}</span>;
  return (
    <div className="small">
      {item.source && (
        <div className="muted mono break-all">
          {item.source}
          {item.ref ? `#${item.ref}` : ''}
          {item.skillPath ? ` · ${item.skillPath}` : ''}
        </div>
      )}
      {item.paths.map((p) => (
        <div key={p} className="muted mono break-all">
          {p}
        </div>
      ))}
      {item.agents.length > 0 && <div className="muted">{item.agents.map((a) => a.name).join(', ')}</div>}
      {item.notForClaude && <div className="muted">{t('Claude Code가 읽는 폴더에는 없습니다(다른 에이전트 폴더에만 있음).')}</div>}
      {item.hashNote && <div className="muted">{HASH_NOTE[item.hashNote]}</div>}
      {item.status === 'differs' && (
        <div className="muted">
          {t('원본 폴더에 metadata.json이나 __pycache__가 있으면 skills CLI가 복사 때 빼므로, 아무도 고치지 않아도 다르게 나올 수 있습니다.')}
        </div>
      )}
    </div>
  );
}

/** `projectPath`: the folder chosen on 설치됨 (an absolute path); `reloadKey` changes after an install or removal. */
export function ProjectStandard({ projectPath, reloadKey, onInstalled }: { projectPath: string; reloadKey?: unknown; onInstalled?: () => void }) {
  const [data, setData] = useState<ProjectStandardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showOk, setShowOk] = useState(false);
  const [installing, setInstalling] = useState<ResolvedPreset | null>(null);
  const [resolving, setResolving] = useState(false);
  const [again, setAgain] = useState(0);
  const path = projectPath.trim();

  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    apiGet<ProjectStandardResponse>('/projects/standard', { projectPath: path })
      .then((d) => live && setData(d))
      .catch((e: unknown) => {
        if (!live) return;
        setData(null);
        setError(String((e as Error).message ?? e));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, reloadKey, again]);

  if (!path) return null;

  const installMissing = async () => {
    if (!data) return;
    setResolving(true);
    setError(null);
    try {
      const resolved = await resolvePreset(data.missingPreset);
      if (!resolved.skills.length) throw new Error(t('빠진 것을 이 PC의 색인에서 찾지 못했습니다 ({0}개). 색인을 모은 뒤 다시 해 보세요.', resolved.missing.length));
      setInstalling(resolved);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setResolving(false);
    }
  };

  const items = data ? sortStandardItems(data.items) : [];
  const shown = showOk ? items : items.filter((i) => i.status !== 'ok');
  const bad = data ? failingCount(data.counts) : 0;
  const cmd = `npx @seojin08/skill-finder check "${path}"`;

  return (
    <section className="project-standard" aria-labelledby="project-standard-title" aria-busy={loading}>
      <div className="project-standard-head">
        <h2 id="project-standard-title">{t('프로젝트 표준')}</h2>
        <div className="examples">
          <button type="button" className="ghost small" onClick={() => setAgain((n) => n + 1)} disabled={loading}>
            {loading ? t('읽는 중…') : t('다시 대조')}
          </button>
          <CopyButton text={cmd} label={t('check 명령 복사')} className="ghost small" title={t('CI나 SessionStart 훅에서: 맞으면 0, 어긋나면 1로 끝납니다.')} />
        </div>
      </div>
      <p className="muted small">
        {t('이 폴더의 skills-lock.json(skills CLI가 쓰는 파일)과 .claude/settings.json의 enabledPlugins·extraKnownMarketplaces를 지금 설치된 것과 대조합니다. 읽기만 하고 아무것도 바꾸지 않습니다.')}
      </p>
      {error && (
        <p className="warn-box" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="muted small">
            {t('skills-lock.json: {0} · .claude/settings.json: {1}', FILE_STATE[data.files.lock], FILE_STATE[data.files.settings])}
          </p>
          {!data.hasStandard ? (
            <p className="muted small">
              {t('이 폴더에는 아직 표준이 없습니다. 아래 "팀 프리셋"의 "skills-lock.json·settings.json 조각"을 저장소에 넣으면 팀원이 같은 구성을 맞출 수 있습니다.')}
            </p>
          ) : (
            <>
              <div className="standard-counts" role="status">
                {bad === 0 && data.ok ? (
                  <span className="std-status ok">{t('표준과 맞습니다')}</span>
                ) : (
                  <span className="std-status warn">{t('어긋난 것 {0}개', bad)}</span>
                )}
                {STATUSES.filter((s) => data.counts[s] > 0).map((s) => (
                  <span key={s} className={`std-status ${TONE[s]}`} title={STATUS_HELP[s]}>
                    {STATUS_LABEL[s]} {data.counts[s]}
                  </span>
                ))}
              </div>
              {data.missingPreset.length > 0 && (
                <div className="examples">
                  <button type="button" onClick={() => void installMissing()} disabled={resolving}>
                    {resolving ? t('찾는 중…') : t('빠진 것 설치 ({0}개)', data.missingPreset.length)}
                  </button>
                  <span className="muted small">{t('팀 프리셋과 같은 설치 확인 창이 열립니다. 항목마다 위험 신호를 보고 고릅니다.')}</span>
                </div>
              )}
              {items.length > 0 && (
                <>
                  <label className="muted small">
                    <input type="checkbox" checked={showOk} onChange={(e) => setShowOk(e.target.checked)} /> {t('맞는 것도 보기 ({0}개)', data.counts.ok)}
                  </label>
                  {shown.length > 0 && (
                    <div className="projects-table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>{t('상태')}</th>
                            <th>{t('종류')}</th>
                            <th>{t('이름')}</th>
                            <th>{t('출처·위치')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.map((i) => (
                            <tr key={`${i.kind}:${i.name}:${i.status}`}>
                              <td>
                                <Status status={i.status} />
                              </td>
                              <td className="small">{KIND_LABEL[i.kind]}</td>
                              <td className="mono small break-all">{i.name}</td>
                              <td>
                                <ItemDetail item={i} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      {installing && (
        <PresetInstallDialog
          name={path.split(/[\\/]/).filter(Boolean).pop() ?? path}
          resolved={installing}
          projectPath={path}
          title={t('프로젝트 표준: 빠진 것 설치')}
          extraNote={
            data?.refNote && (
              <p className="warn-box small">
                {t('앱은 이 PC의 색인이 위험 검사를 한 커밋으로 설치합니다. skills-lock.json이 만들어진 때와 다른 커밋일 수 있어, 설치 뒤 "내용 다름"으로 보일 수 있습니다.')}
              </p>
            )
          }
          onClose={() => {
            setInstalling(null);
            setAgain((n) => n + 1);
            onInstalled?.();
          }}
        />
      )}
    </section>
  );
}

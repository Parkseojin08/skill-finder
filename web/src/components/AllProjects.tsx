// 설치됨 › 모든 프로젝트 (feature review F13): every folder the app installed into or Claude Code lists, a line each —
// what loads there, its standard (F12), changed copies (F6) and skill use (F11). A row opens that folder on 설치됨.
import { useEffect, useState } from 'react';
import { apiGet } from '../api.ts';
import { t } from '../i18n.ts';
import { sortProjects, standardSummary, type ProjectSort, type ProjectsResponse, type ProjectSummary } from '../lib/projects.ts';
import '../projects.css';

const SORTS: Array<[ProjectSort, string]> = [
  ['standard', t('표준이 어긋난 순')],
  ['tokens', t('매 턴 토큰 많은 순')],
  ['changed', t('변경 많은 순')],
  ['unused', t('30일 미사용 많은 순')],
  ['lastUsed', t('최근 사용 순')],
  ['name', t('이름순')],
];

const FROM: Record<ProjectSummary['from'][number], string> = { install: t('앱으로 설치함'), claude: t('Claude Code 기록') };

const pair = (own: number, all: number) => (own === all ? String(all) : t('{0} (모두 {1})', own, all));

export function AllProjects({ onPickProject }: { onPickProject: (path: string) => void }) {
  const [data, setData] = useState<ProjectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<ProjectSort>('standard');
  const [fresh, setFresh] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    apiGet<ProjectsResponse>('/projects', { fresh: fresh ? '1' : undefined })
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(String((e as Error).message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [fresh]);

  const rows = data ? sortProjects(data.projects, sort) : [];

  return (
    <section className="all-projects" aria-labelledby="all-projects-title" aria-busy={loading}>
      <div className="project-standard-head">
        <h2 id="all-projects-title">{t('모든 프로젝트')}</h2>
        <div className="examples">
          <label className="muted small">
            {t('정렬')}{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value as ProjectSort)}>
              {SORTS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ghost small" onClick={() => setFresh((n) => n + 1)} disabled={loading}>
            {loading ? t('읽는 중…') : t('새로 읽기')}
          </button>
        </div>
      </div>
      <p className="muted small">
        {t('이 앱으로 설치한 폴더와 Claude Code가 기억하는 폴더(~/.claude.json)만 봅니다. 디스크를 뒤지지 않고, 없어진 폴더는 뺍니다. 줄을 누르면 그 폴더를 엽니다.')}
      </p>
      {error && (
        <p className="warn-box" role="alert">
          {error}
        </p>
      )}
      {data && !data.usageOn && <p className="muted small">{t('사용량 꺼짐: 설정에서 "대화 기록에서 스킬 사용 횟수 읽기"를 켜면 30일 미사용·마지막 사용이 채워집니다.')}</p>}
      {data && data.truncated && <p className="muted small">{t('프로젝트가 많아 최근 {0}곳만 보여 줍니다.', data.projects.length)}</p>}
      {data && rows.length === 0 && <p className="muted small">{t('아는 프로젝트 폴더가 없습니다.')}</p>}
      {rows.length > 0 && (
        <div className="projects-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('프로젝트')}</th>
                <th className="num" title={t('프로젝트 폴더의 스킬 (모두: 개인·플러그인 포함, Claude Code가 읽는 것)')}>
                  {t('스킬')}
                </th>
                <th className="num" title={t('이 프로젝트에 설치한 플러그인 (모두: 여기서 켜진 것)')}>
                  {t('플러그인')}
                </th>
                <th className="num" title={t('이 프로젝트의 MCP 서버 (모두: 여기서 실행되는 Claude Code MCP 서버)')}>
                  MCP
                </th>
                <th className="num" title={t('개인 스킬과 합친, 매 요청에 들어가는 스킬 이름·설명 (추정)')}>
                  {t('매 턴 토큰')}
                </th>
                <th>{t('표준')}</th>
                <th className="num" title={t('원본에 새 버전이 있거나 여기서 고친 프로젝트 스킬')}>
                  {t('변경')}
                </th>
                <th className="num" title={t('이 프로젝트의 스킬 중 이 폴더에서 30일 동안 쓰지 않은 것')}>
                  {t('30일 미사용')}
                </th>
                <th>{t('마지막 사용')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const std = standardSummary(p.standard);
                return (
                  // the name is the button (keyboard and screen readers); a click anywhere on the row does the same.
                  // The row itself has no label: one on the <tr> replaced what its cells say (review 2026-11-10).
                  <tr key={p.path} className="pickable" onClick={() => onPickProject(p.path)}>
                    <td>
                      <div>
                        <button
                          type="button"
                          className="linkish"
                          title={t('{0} 열기', p.name)}
                          onClick={(e) => {
                            e.stopPropagation();
                            onPickProject(p.path);
                          }}
                        >
                          {p.name}
                        </button>
                      </div>
                      <div className="muted small mono break-all">{p.path}</div>
                      <div className="muted small">{p.from.map((f) => FROM[f]).join(' · ')}</div>
                      {p.errors.length > 0 && <div className="muted small">{t('일부를 읽지 못함')}</div>}
                    </td>
                    <td className="num">{pair(p.skills.project, p.skills.loaded)}</td>
                    <td className="num">{pair(p.plugins.project, p.plugins.enabled)}</td>
                    <td className="num">{pair(p.mcp.project, p.mcp.total)}</td>
                    <td className="num">{p.perTurnTokens.toLocaleString()}</td>
                    <td>
                      <span className={`std-status ${std.tone}`}>{std.text}</span>
                    </td>
                    <td className="num">{p.changed || '-'}</td>
                    <td className="num">{p.usage ? p.usage.unused30d : '-'}</td>
                    <td className="small">{p.usage ? (p.usage.lastUsed ?? t('기록 없음')) : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

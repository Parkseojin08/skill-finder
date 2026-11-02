import { useState } from 'react';
import { apiGet } from '../api.ts';
import { formatAgo } from '../labels.ts';

type Entry = { id: number; at: string; method: string; scope: string; projectPath: string | null; target: string | null; ok: boolean; output: string };

const WHAT: Record<string, string> = {
  plugin: '설치 · 플러그인',
  'skills-cli': '설치 · skills CLI',
  'uninstall-plugin': '삭제 · 플러그인',
  'uninstall-skill': '삭제 · 스킬',
};
const SCOPE: Record<string, string> = { user: '개인', project: '프로젝트', local: '로컬' };

/**
 * What the app ran, newest first (review 2026-11-02): each install and removal with its result and output, to see
 * why one failed without the console. Read when opened.
 */
export function InstallHistory() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <details
      className="install-history"
      onToggle={(e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open) return;
        setError(null);
        apiGet<{ entries: Entry[] }>('/install/log')
          .then((r) => setEntries(r.entries))
          .catch((err) => setError(String((err as Error).message ?? err)));
      }}
    >
      <summary>
        <h2>설치 기록</h2> <span className="muted small">앱이 실행한 설치·삭제 최근 50건</span>
      </summary>
      {error && <p className="warn-box">{error}</p>}
      {!entries && !error && <p className="muted small">불러오는 중…</p>}
      {entries?.length === 0 && <p className="muted small">아직 앱으로 설치하거나 삭제한 것이 없습니다.</p>}
      {entries && entries.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>언제</th>
              <th>대상</th>
              <th>무엇</th>
              <th>범위</th>
              <th>결과</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="small" title={e.at}>
                  {formatAgo(e.at)}
                </td>
                <td className="mono small">{e.target ?? '–'}</td>
                <td className="small">{WHAT[e.method] ?? e.method}</td>
                <td className="small">
                  {SCOPE[e.scope] ?? e.scope}
                  {e.projectPath && <div className="muted small">{e.projectPath}</div>}
                </td>
                <td className="small">
                  <span className={e.ok ? 'state-on' : 'warn-text'}>{e.ok ? '성공' : '실패'}</span>
                  {e.output && (
                    <details>
                      <summary className="muted small">출력</summary>
                      <pre className="history-output">{e.output}</pre>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

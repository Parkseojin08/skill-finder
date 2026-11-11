// Copies kept before a delete or overwrite (feature review F14, decision 15): for undo only. The delete dialog's note
// (whether a copy will be kept), the sentence added to a removal's message, and the 변경·기록 tab's list of what was
// recently deleted or replaced with its 되돌리기, and the plugins removed with their reinstall command.
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { t } from '../i18n.ts';
import { formatAgo, formatBytes } from '../labels.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { CopyButton } from './CopyButton.tsx';
import './usage.css';

/** What the server says of the copy it made (or did not) before removing or replacing a skill folder. */
export type QuarantineOutcome = { kept: true; id: number; bytes: number; files: number; skippedLinks: number } | { kept: false; reason: 'tooBig' | 'link' | 'missing' | 'failed'; bytes?: number };

type FolderSize = { exists: boolean; link: boolean; bytes: number; files: number; over: boolean; limit: number };

/** The sentence a removal's message gets about its copy. */
export function keptText(q: QuarantineOutcome | undefined | null): string {
  if (!q) return '';
  if (q.kept) return t(' 지운 폴더의 복사본을 30일 보관합니다(변경·기록 탭에서 되돌리기).');
  if (q.reason === 'tooBig') return t(' 폴더가 20MB를 넘어 복사본은 보관하지 않았습니다.');
  return '';
}

/**
 * The delete dialog's note for a skill folder: a copy is kept for 30 days, or not (over 20MB, or a link whose target
 * stays). Asked of the server with the same names /uninstall takes.
 */
export function RemoveKeepNote({ scope, projectPath, agent, folder }: { scope: string; projectPath?: string; agent?: string; folder: string }) {
  // undefined: still asking; null: the server could not say. "A copy is kept" is promised only once it is known
  // (before, the promise showed while the answer was on its way and when it failed; review 2026-11-10)
  const [size, setSize] = useState<FolderSize | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setSize(undefined);
    apiGet<FolderSize>('/quarantine/size', { scope, projectPath, agent, folder })
      .then((s) => live && setSize(s))
      .catch(() => live && setSize(null));
    return () => {
      live = false;
    };
  }, [scope, projectPath, agent, folder]);
  if (size === undefined) return <p className="muted small">{t('복사본을 보관할 수 있는지 확인하는 중…')}</p>;
  if (size === null) return <p className="warn-text small">{t('복사본을 보관할 수 있는지 확인하지 못했습니다. 보관되지 않으면 지운 뒤 되돌릴 수 없습니다.')}</p>;
  if (size.link) return <p className="muted small">{t('링크로 연결된 폴더라 링크만 지웁니다. 가리키는 폴더는 그대로 남습니다.')}</p>;
  if (size.over) return <p className="warn-text small">{t('폴더가 20MB를 넘어 복사본을 보관하지 않습니다. 지우면 되돌릴 수 없습니다.')}</p>;
  return <p className="muted small">{t('지우기 전에 복사본을 30일 보관합니다. 실수로 지웠으면 변경·기록 탭에서 되돌릴 수 있습니다.')}</p>;
}

/**
 * The install dialog's note for a same-name folder the install replaces: its copy is kept for 30 days, or not (over
 * 20MB). `path`: the folder as the preview names it; nothing is shown when the server cannot say (not an install place).
 */
export function OverwriteKeepNote({ scope, projectPath, path }: { scope: string; projectPath?: string; path: string }) {
  const [size, setSize] = useState<FolderSize | null>(null);
  useEffect(() => {
    let live = true;
    setSize(null);
    apiGet<FolderSize>('/quarantine/size', { scope, projectPath, path })
      .then((s) => live && setSize(s))
      .catch(() => live && setSize(null));
    return () => {
      live = false;
    };
  }, [scope, projectPath, path]);
  if (!size?.exists || size.link) return null;
  if (size.over) return <p className="warn-text small">{t('폴더가 20MB를 넘어 복사본을 보관하지 않습니다. 덮어쓰면 되돌릴 수 없습니다.')}</p>;
  return <p className="muted small">{t('덮어쓰기 전에 복사본을 30일 보관합니다. 변경·기록 탭에서 되돌릴 수 있습니다.')}</p>;
}

type Entry = {
  id: number;
  at: string;
  reason: 'delete' | 'overwrite';
  name: string;
  scope: string | null;
  projectPath: string | null;
  originalPath: string;
  bytes: number;
  files: number;
  restoredAt: string | null;
  available: boolean;
};
type RemovedPlugin = { id: number; at: string; pluginId: string; scope: string; projectPath: string | null; command: string };
type ListResponse = { entries: Entry[]; plugins: RemovedPlugin[]; limits: { maxBytes: number; keepDays: number; maxEntries: number } };

const REASON: Record<Entry['reason'], string> = { delete: t('삭제 전'), overwrite: t('덮어쓰기 전') };
const SCOPE: Record<string, string> = { user: t('개인'), project: t('프로젝트'), local: t('로컬') };

/**
 * "최근 지운·바꾼 것": the kept copies, newest first, each with 되돌리기 (asks first); removed plugins below.
 * `onRestored`: a folder is back in place (the 설치됨 list is read again, or it would still lack the skill).
 */
export function QuarantineList({ onRestored }: { onRestored?: () => void }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState<Entry | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    apiGet<ListResponse>('/quarantine')
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, []);
  useEffect(load, [load]);

  const restore = async (e: Entry) => {
    setConfirming(null);
    setBusy(e.id);
    setMsg(null);
    try {
      const r = await apiSend<{ ok: boolean; path: string }>('POST', `/quarantine/${e.id}/restore`);
      setMsg({ ok: true, text: t('{0}을(를) {1}에 되돌렸습니다. 새 Claude Code 세션부터 쓰입니다.', e.name, r.path) });
      onRestored?.();
    } catch (err) {
      setMsg({ ok: false, text: String((err as Error).message ?? err) });
    } finally {
      setBusy(null);
      load();
    }
  };

  if (error) return <p className="warn-box">{error}</p>;
  if (!data) return null;
  return (
    <section className="quarantine-list" aria-label={t('최근 지운·바꾼 것')}>
      <h3>{t('최근 지운·바꾼 것')}</h3>
      <p className="muted small">
        {t('앱에서 스킬을 지우거나 덮어쓰기 전에 그 폴더의 복사본을 {0}일 동안, 최근 {1}개까지 보관합니다({2}가 넘는 폴더는 보관하지 않음). 실수로 지웠거나 고친 내용을 잃었을 때 되돌리는 용도입니다.', data.limits.keepDays, data.limits.maxEntries, formatBytes(data.limits.maxBytes))}
      </p>
      <div role="status">{msg && <p className={msg.ok ? 'ok-box' : 'warn-box'}>{msg.text}</p>}</div>
      {data.entries.length === 0 ? (
        <p className="muted small">{t('보관한 복사본이 없습니다.')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('언제')}</th>
              <th>{t('스킬')}</th>
              <th>{t('원래 위치')}</th>
              <th>
                <span className="sr-only">{t('작업')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e) => (
              <tr key={e.id}>
                <td className="small" title={e.at}>
                  {formatAgo(e.at)}
                </td>
                <td>
                  <b className="mono">{e.name}</b>
                  <div className="muted small">
                    {REASON[e.reason] ?? e.reason} · {SCOPE[e.scope ?? ''] ?? e.scope ?? '–'} · {t('파일 {0}개', e.files)} · {formatBytes(e.bytes)}
                  </div>
                </td>
                <td className="mono small">{e.originalPath}</td>
                <td className="actions">
                  {e.restoredAt ? (
                    <span className="muted small" title={e.restoredAt}>
                      {t('되돌림 · {0}', formatAgo(e.restoredAt))}
                    </span>
                  ) : e.available ? (
                    <button type="button" className="ghost" disabled={busy !== null} aria-busy={busy === e.id} onClick={() => setConfirming(e)}>
                      {busy === e.id ? t('되돌리는 중…') : t('되돌리기')}
                    </button>
                  ) : (
                    <span className="muted small">{t('복사본 없음')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.plugins.length > 0 && (
        <>
          <h3>{t('최근 지운 플러그인')}</h3>
          <p className="muted small">{t('플러그인은 Claude Code가 관리해서 복사본을 보관하지 않습니다. 다시 쓰려면 아래 명령으로 다시 설치하세요(프로젝트·로컬 범위는 그 프로젝트 폴더에서).')}</p>
          <table className="table">
            <tbody>
              {data.plugins.map((p) => (
                <tr key={p.id}>
                  <td className="small" title={p.at}>
                    {formatAgo(p.at)}
                  </td>
                  <td>
                    <b className="mono">{p.pluginId}</b>
                    {p.projectPath && <div className="muted small mono">{p.projectPath}</div>}
                  </td>
                  <td>
                    <span className="quarantine-cmd">
                      <code className="mono small">{p.command}</code>
                      <CopyButton text={p.command} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {confirming && (
        <ConfirmDialog title={t('{0} 되돌리기', confirming.name)} confirmLabel={t('되돌리기')} onConfirm={() => void restore(confirming)} onCancel={() => setConfirming(null)}>
          <p>{t('보관한 복사본을 원래 위치 {0}에 다시 놓습니다.', confirming.originalPath)}</p>
          <p className="muted small">{t('그 자리에 이미 폴더가 있으면 덮어쓰지 않고 멈춥니다. skills-lock.json은 바뀌지 않습니다.')}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

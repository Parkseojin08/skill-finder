import { useState } from 'react';
import { apiGet } from '../api.ts';
import { t } from '../i18n.ts';
import '../status.css';

type LogEntry = { at: string; level: string; text: string };
type Level = 'warn' | 'error' | 'info';

/**
 * "로그 보기" in the settings' 문제 알리기 (feature review F22): the server's recent log entries, already masked (no
 * token, home folder as ~), shown on this screen only.
 */
export function LogViewer() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [level, setLevel] = useState<Level>('warn');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (lv: Level) => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiGet<{ entries: LogEntry[] }>('/logs', { level: lv, lines: '200' });
      setEntries(r.entries);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="log-viewer">
      <div className="row">
        <button type="button" className="ghost" disabled={busy} onClick={() => void load(level)}>
          {entries ? t('로그 새로 읽기') : t('로그 보기')}
        </button>
        <select
          value={level}
          aria-label={t('로그 수준')}
          onChange={(e) => {
            const lv = e.target.value as Level;
            setLevel(lv);
            if (entries) void load(lv);
          }}
        >
          <option value="warn">{t('경고와 오류')}</option>
          <option value="error">{t('오류만')}</option>
          <option value="info">{t('모두')}</option>
        </select>
      </div>
      {error && <p className="warn-box">{error}</p>}
      {entries &&
        (entries.length === 0 ? (
          <p className="muted small">{t('남은 로그가 없습니다.')}</p>
        ) : (
          <pre className="log-view mono" tabIndex={0} aria-label={t('최근 로그')}>
            {entries
              .slice()
              .reverse()
              .map((e, i) => (
                <span key={i} className={`log-${e.level}`}>
                  {e.at.replace('T', ' ').slice(0, 19)} {e.level} {e.text}
                  {'\n'}
                </span>
              ))}
          </pre>
        ))}
    </div>
  );
}

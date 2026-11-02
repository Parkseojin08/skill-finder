import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { t } from '../i18n.ts';

/**
 * Copies the server's diagnostics (versions, counts, recent log; no token, searches or home folder name) to the
 * clipboard, to paste into a bug report (project review F2). Shown in a box when the clipboard is not available.
 */
export function DiagnosticsButton() {
  const [state, setState] = useState<'idle' | 'busy' | 'copied'>('idle');
  const [fallback, setFallback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copy = async () => {
    setState('busy');
    setError(null);
    try {
      const { text } = await apiGet<{ text: string }>('/diagnostics');
      try {
        await navigator.clipboard.writeText(text);
        setFallback(null);
        setState('copied');
        setTimeout(() => setState('idle'), 2000);
      } catch {
        setFallback(text);
        setState('idle');
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setState('idle');
    }
  };
  return (
    <div className="diagnostics">
      <button type="button" className="ghost" onClick={() => void copy()} disabled={state === 'busy'}>
        {state === 'copied' ? t('복사됨') : state === 'busy' ? t('모으는 중…') : t('진단 정보 복사')}
      </button>
      {error && <p className="warn-box">{error}</p>}
      {fallback && (
        <textarea className="diagnostics-text mono" readOnly value={fallback} rows={10} aria-label={t('진단 정보')} onFocus={(e) => e.currentTarget.select()} />
      )}
    </div>
  );
}

type State = { error: Error | null };

/** A screen that fails to draw shows this page with a way back, instead of a blank window (project review F2). */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[화면 오류]', error, info.componentStack);
    // into the server's log file, for the diagnostics; a failure here changes nothing
    apiSend('POST', '/client-error', { message: String(error.message ?? error).slice(0, 2000), stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 8000) }).catch(() => {});
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page crash-page">
        <h1>{t('화면을 그리다 오류가 났습니다')}</h1>
        <p className="muted">{t('다시 시도해도 같으면 진단 정보를 복사해 문제를 알려 주세요. 색인과 설치된 스킬에는 영향이 없습니다.')}</p>
        <pre className="crash-detail">{String(this.state.error.message ?? this.state.error)}</pre>
        <div className="row">
          <button type="button" className="primary" onClick={() => this.setState({ error: null })}>
            {t('다시 시도')}
          </button>
          <button type="button" className="ghost" onClick={() => window.location.reload()}>
            {t('새로 고침')}
          </button>
        </div>
        <DiagnosticsButton />
      </div>
    );
  }
}

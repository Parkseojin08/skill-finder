import { forwardRef, useImperativeHandle, useState } from 'react';
import { apiSend } from '../api.ts';
import { serverText, t } from '../i18n.ts';
import '../status.css';

export type TokenCheckResult = {
  state: 'valid' | 'invalid' | 'unknown' | 'none';
  kind: 'classic' | 'fine-grained' | 'other' | null;
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  scopes: string[] | null;
  broad: boolean;
  error: string | null;
};

export type TokenCheckHandle = { check(): Promise<void> };

/**
 * Whether the saved GitHub token works (feature review F22): GitHub's /rate_limit, which uses none of the quota,
 * says "유효 · 시간당 5,000 · 남음 N"; a classic token with scopes gets a warning that public read access is enough.
 * The token itself never comes back from the server.
 */
export const TokenCheck = forwardRef<TokenCheckHandle, { hasToken: boolean }>(function TokenCheck({ hasToken }, ref) {
  const [result, setResult] = useState<TokenCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await apiSend<TokenCheckResult>('POST', '/github-token/check'));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  useImperativeHandle(ref, () => ({ check }));

  return (
    <div className="token-check">
      {hasToken && (
        <button type="button" className="ghost" disabled={busy} onClick={() => void check()}>
          {busy ? t('확인 중…') : t('연결 확인')}
        </button>
      )}
      <div role="status">
        {error && <p className="warn-box">{error}</p>}
        {result?.state === 'valid' && (
          <p className="ok-box">
            {result.limit != null
              ? t('유효 · 시간당 {0} · 남음 {1}', result.limit.toLocaleString(), (result.remaining ?? 0).toLocaleString())
              : t('유효')}
            {result.kind === 'fine-grained' ? ` · ${t('fine-grained 토큰')}` : result.kind === 'classic' ? ` · ${t('classic 토큰')}` : ''}
          </p>
        )}
        {result?.state === 'valid' && result.broad && (
          <p className="warn-box">
            {t('이 토큰에는 {0} 권한이 있습니다. Skill Finder는 공개 저장소 읽기만 필요하니, 권한을 주지 않은 fine-grained 토큰을 쓰세요.', (result.scopes ?? []).join(', '))}
          </p>
        )}
        {result?.state === 'invalid' && <p className="warn-box">{t('GitHub가 이 토큰을 받지 않았습니다. 만료되었거나 잘못 붙여 넣었는지 확인하세요.')}</p>}
        {result?.state === 'unknown' && (
          <p className="warn-box">{t('GitHub에 연결하지 못해 확인하지 못했습니다. ({0})', result.error ? serverText(result.error) : '')}</p>
        )}
      </div>
    </div>
  );
});

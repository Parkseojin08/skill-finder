import { useState } from 'react';
import { enableTranslation, useTranslateStatus } from '../translate.ts';
import { Icon } from './Icon.tsx';
import { t } from '../i18n.ts';

function formatProgress(p: number | null): string {
  if (p == null) return '';
  return ` ${Math.round(p * 100)}%`;
}

const UNSUPPORTED = t('이 브라우저에서는 번역을 쓸 수 없어 설명이 영어로 나옵니다. Chrome·Edge·Firefox 최신판에서 열면 번역됩니다.');
const megabytes = (bytes: number | null) => (bytes ? Math.round(bytes / 1048576) : '?');

/**
 * Whether descriptions can be shown in Korean, with the one-time model download.
 * `compact` renders a small chip for toolbars; otherwise a full-width notice.
 */
/** "번역 안 됨" closed once: from then on only the small icon (review 2026-11-02: a yellow strip on every screen). */
const CLOSED_KEY = 'skill-finder.translation-notice-closed';
const readClosed = () => {
  try {
    return localStorage.getItem(CLOSED_KEY) === '1';
  } catch {
    return false;
  }
};

export function TranslationNotice({ compact: compactProp = false }: { compact?: boolean }) {
  const s = useTranslateStatus();
  const [closed, setClosed] = useState(readClosed);
  const bergamot = s.engine === 'bergamot';
  // the Mozilla model's offer can be closed too: Firefox users would otherwise see it on every screen
  const compact = compactProp || (closed && (s.state === 'unsupported' || (s.state === 'needs-download' && bergamot)));
  const close = (
    <button
      type="button"
      className="linkish"
      onClick={() => {
        try {
          localStorage.setItem(CLOSED_KEY, '1');
        } catch {
          // private window: closed for this page only
        }
        setClosed(true);
      }}
    >
      {t('닫기')}
    </button>
  );
  // an English screen shows the descriptions as they are: nothing to say
  if (s.state === 'off') return null;
  if (s.state === 'ready' || s.state === 'checking') {
    return compact && s.state === 'ready' ? (
      // nothing to do here, so only an icon in the toolbar (UI debate 2-4)
      <span className="status-chip ok" title={bergamot ? t('설명은 이 PC 안에서 Mozilla 번역 모델(Firefox와 같은 것)로 번역해 보여 줍니다') : t('설명은 브라우저 내장 번역기로 한국어로 보여 줍니다')}>
        <Icon name="check" size={13} />
        <span className="sr-only">{t('한국어 번역 켜짐')}</span>
      </span>
    ) : null;
  }
  if (s.state === 'needs-download') {
    const why = bergamot
      ? t('설명을 번역하려면 Mozilla 번역 모델(Firefox와 같은 것, 약 {0}MB)을 한 번 내려받아야 합니다. 번역은 이 PC 안에서만 합니다.', megabytes(s.size))
      : t('설명을 한국어로 보려면 브라우저 내장 번역 모델을 한 번 내려받아야 합니다.');
    return compact ? (
      <button type="button" className="status-chip action" onClick={() => void enableTranslation()} title={bergamot ? why : t('브라우저 내장 번역 모델을 한 번 내려받습니다')}>
        <Icon name="download" size={13} />{t(' 한국어 번역 켜기')}
      </button>
    ) : (
      <div className="info-box notice-row">
        <span>
          {why}
          {/* the last download's failure, from the server, so a reload does not hide why it is asked again */}
          {s.error && <span className="small muted"> {t('지난번 받기 실패: {0}', s.error)}</span>}
        </span>
        <button type="button" className="primary" onClick={() => void enableTranslation()}>
          {t('한국어 번역 켜기')}
        </button>
        {bergamot && close}
      </div>
    );
  }
  if (s.state === 'downloading' || s.state === 'loading') {
    const text = s.state === 'loading' ? t('번역 모델 여는 중') : t('번역 모델 받는 중{0}', formatProgress(s.progress));
    return compact ? <span className="status-chip">{text}</span> : <div className="info-box">{text}…</div>;
  }
  if (s.state === 'error') {
    // the download or the engine can fail for a moment (network): try again from here
    return compact ? (
      <button type="button" className="status-chip warn" title={s.error ?? ''} onClick={() => void enableTranslation()}>
        {t('번역 오류 · 다시 시도')}
      </button>
    ) : (
      <div className="warn-strip">
        {t('번역을 시작하지 못해 설명을 영어로 보여 줍니다 ({0})', s.error)}{' '}
        <button type="button" className="linkish" onClick={() => void enableTranslation()}>
          {t('다시 시도')}
        </button>
      </div>
    );
  }
  return compact ? (
    <span className="status-chip" title={UNSUPPORTED}>
      <Icon name="info" size={13} />
      <span className="sr-only">{t('번역을 쓸 수 없어 설명이 영어로 나옵니다')}</span>
    </span>
  ) : (
    <div className="warn-strip">
      {UNSUPPORTED} {close}
    </div>
  );
}

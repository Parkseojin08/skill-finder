import { enableTranslation, useTranslateStatus } from '../translate.ts';
import { Icon } from './Icon.tsx';

function formatProgress(p: number | null): string {
  if (p == null) return '';
  return ` ${Math.round(p * 100)}%`;
}

const UNSUPPORTED = '이 브라우저에서는 내장 번역 기능을 쓸 수 없어 설명이 영어로 나옵니다. Chrome(138 이상)에서 열면 한국어로 번역됩니다.';

/**
 * Whether descriptions can be shown in Korean, with the one-time model download.
 * `compact` renders a small chip for toolbars; otherwise a full-width notice.
 */
export function TranslationNotice({ compact = false }: { compact?: boolean }) {
  const s = useTranslateStatus();
  if (s.state === 'ready' || s.state === 'checking') {
    return compact && s.state === 'ready' ? (
      // nothing to do here, so only an icon in the toolbar (UI debate 2-4)
      <span className="status-chip ok" title="설명은 브라우저 내장 번역기로 한국어로 보여 줍니다">
        <Icon name="check" size={13} />
        <span className="sr-only">한국어 번역 켜짐</span>
      </span>
    ) : null;
  }
  if (s.state === 'needs-download') {
    return compact ? (
      <button type="button" className="status-chip action" onClick={() => void enableTranslation()} title="브라우저 내장 번역 모델을 한 번 내려받습니다">
        <Icon name="download" size={13} /> 한국어 번역 켜기
      </button>
    ) : (
      <div className="info-box notice-row">
        <span>설명을 한국어로 보려면 브라우저 내장 번역 모델을 한 번 내려받아야 합니다.</span>
        <button type="button" className="primary" onClick={() => void enableTranslation()}>
          한국어 번역 켜기
        </button>
      </div>
    );
  }
  if (s.state === 'downloading') {
    const text = `번역 모델 받는 중${formatProgress(s.progress)}`;
    return compact ? <span className="status-chip">{text}</span> : <div className="info-box">{text}…</div>;
  }
  if (s.state === 'error') {
    return compact ? (
      <span className="status-chip warn" title={s.error ?? ''}>
        번역 오류
      </span>
    ) : (
      <div className="warn-strip">번역을 시작하지 못해 설명을 영어로 보여 줍니다 ({s.error})</div>
    );
  }
  return compact ? (
    <span className="status-chip" title={UNSUPPORTED}>
      <Icon name="info" size={13} />
      <span className="sr-only">번역은 Chrome 전용이라 설명이 영어로 나옵니다</span>
    </span>
  ) : (
    <div className="warn-strip">{UNSUPPORTED}</div>
  );
}

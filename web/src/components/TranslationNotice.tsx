import { enableTranslation, useTranslateStatus } from '../translate.ts';

function formatProgress(p: number | null): string {
  if (p == null) return '';
  return ` ${Math.round(p * 100)}%`;
}

/** Explains whether descriptions can be shown in Korean and offers the one-time model download. */
export function TranslationNotice() {
  const s = useTranslateStatus();
  if (s.state === 'ready' || s.state === 'checking') return null;
  if (s.state === 'needs-download') {
    return (
      <div className="info-box notice-row">
        <span>설명을 한국어로 보려면 브라우저 내장 번역 모델을 한 번 내려받아야 합니다.</span>
        <button type="button" className="primary" onClick={() => void enableTranslation()}>
          한국어 번역 켜기
        </button>
      </div>
    );
  }
  if (s.state === 'downloading') return <div className="info-box">번역 모델을 내려받는 중…{formatProgress(s.progress)}</div>;
  if (s.state === 'error') return <div className="warn-strip">번역을 시작하지 못해 설명을 영어로 보여 줍니다 ({s.error})</div>;
  return (
    <div className="warn-strip">
      이 브라우저에서는 내장 번역 기능을 쓸 수 없어 설명이 영어로 나옵니다. Chrome(138 이상)에서 <code>http://127.0.0.1:4317</code>을 열면 한국어로 번역됩니다.
    </div>
  );
}

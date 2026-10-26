import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiSend } from '../api.ts';
import { Icon } from './Icon.tsx';

/** Path text field plus a button that opens the OS folder dialog (via the local server). */
export function FolderInput({
  value,
  onChange,
  placeholder,
  disabled,
  label,
}: {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keyboard focus must not wander to the page behind the overlay either.
  useEffect(() => {
    const main = document.querySelector('.app');
    if (!picking || !main) return;
    main.setAttribute('inert', '');
    return () => main.removeAttribute('inert');
  }, [picking]);

  const pick = async () => {
    setPicking(true);
    setError(null);
    try {
      const r = await apiSend<{ path: string | null }>('POST', '/pick-folder', { initial: value || undefined });
      if (r.path) onChange(r.path);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="folder-input">
      <div className="folder-row">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? '예: C:\\work\\my-app 또는 /home/me/my-app'}
          spellCheck={false}
          disabled={disabled}
          aria-label={label ?? '프로젝트 경로'}
        />
        <button type="button" onClick={pick} disabled={disabled || picking}>
          <Icon name="folder" size={16} />
          {picking ? '선택 창 열림…' : '폴더 선택'}
        </button>
      </div>
      {error && <p className="warn-text small">{error}</p>}
      {picking &&
        createPortal(
        // Blocks the page until the OS dialog returns (choose or cancel), like a native modal.
        <div className="picker-overlay" role="alertdialog" aria-modal="true" aria-live="assertive" aria-label="폴더 선택 중">
          <div className="picker-card">
            <Icon name="folder" size={28} />
            <h2>폴더 선택 창에서 폴더를 고르세요</h2>
            <p className="muted">"프로젝트 폴더 선택" 창에서 폴더를 고른 뒤 <b>폴더 선택</b>을, 그만두려면 <b>취소</b>를 누르세요. 창을 닫기 전까지 이 화면은 잠깁니다.</p>
            <p className="muted small">창이 보이지 않으면 작업 표시줄에서 "프로젝트 폴더 선택"을 눌러 주세요.</p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

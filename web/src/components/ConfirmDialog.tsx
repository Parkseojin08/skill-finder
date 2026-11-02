import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '../i18n.ts';

/** In-page modal confirmation (replaces window.confirm, which blocks the whole browser tab). */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = t('확인'),
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    // the control that opened it gets the focus back when it goes (it is removed, not closed, so the browser
    // would leave the focus on the page; review 2026-11-02)
    const opener = document.activeElement as HTMLElement | null;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (opener?.isConnected) setTimeout(() => opener.focus(), 0);
    };
  }, []);
  return (
    <dialog ref={ref} className="confirm" onCancel={onCancel} aria-labelledby="confirm-dialog-title">
      <h3 id="confirm-dialog-title">{title}</h3>
      <div className="confirm-body">{children}</div>
      <div className="dialog-actions">
        <button type="button" className="ghost" onClick={onCancel} autoFocus>
          {t('취소')}
        </button>
        <button type="button" className={danger ? 'primary danger-solid' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

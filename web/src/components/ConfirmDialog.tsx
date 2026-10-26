import { useEffect, useRef, type ReactNode } from 'react';

/** In-page modal confirmation (replaces window.confirm, which blocks the whole browser tab). */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = '확인',
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
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="confirm" onCancel={onCancel} aria-labelledby="confirm-dialog-title">
      <h3 id="confirm-dialog-title">{title}</h3>
      <div className="confirm-body">{children}</div>
      <div className="dialog-actions">
        <button type="button" className="ghost" onClick={onCancel} autoFocus>
          취소
        </button>
        <button type="button" className={danger ? 'primary danger-solid' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

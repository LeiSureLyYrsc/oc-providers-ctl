import type { ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import { Icon } from './Icon';

interface DialogProps {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  wide?: boolean;
}

export function Dialog({ open, title, subtitle, children, actions, onClose, wide }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const previous = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previous.current = document.activeElement;
    const first = panelRef.current?.querySelector<HTMLElement>(
      '[data-autofocus], input, select, textarea, button',
    );
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        ),
      );
      if (focusables.length === 0) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const target = previous.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        style={wide ? { width: 'min(820px, calc(100vw - 48px))' } : undefined}
      >
        <div className="dialog-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  extraAction?: ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onClose,
  onConfirm,
  extraAction,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      actions={
        <>
          {extraAction}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger-filled' : 'btn btn-filled'}
            onClick={onConfirm}
            disabled={busy}
            data-autofocus
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 15, lineHeight: 1.65 }}>{body}</div>
    </Dialog>
  );
}

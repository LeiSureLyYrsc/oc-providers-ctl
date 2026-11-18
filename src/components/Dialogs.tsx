import type { ReactNode } from 'react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  eyebrow?: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  disabled?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  children: ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  eyebrow = 'CONFIRM / 确认',
  confirmLabel,
  tone = 'primary',
  busy,
  disabled,
  onClose,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={eyebrow}
      title={title}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy || disabled}
            data-autofocus
          >
            {busy ? '正在处理…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{children}</div>
    </Modal>
  );
}

interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: ['Alt', '1'], action: '总览' },
  { keys: ['Alt', '2'], action: '提供方' },
  { keys: ['Alt', '3'], action: '模型' },
  { keys: ['Alt', '4'], action: '配置源' },
  { keys: ['Alt', '5'], action: '检查' },
  { keys: ['/'], action: '聚焦当前筛选框' },
  { keys: ['j', 'k'], action: '在表格中移动选择' },
  { keys: ['↑', '↓'], action: '在表格中移动选择' },
  { keys: ['Esc'], action: '关闭弹窗或清除提示' },
];

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="KEYBOARD / 键盘"
      title="键盘与焦点"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="shortcut-grid">
        {SHORTCUTS.map((shortcut) => (
          <div className="shortcut-row" key={shortcut.action}>
            <div className="shortcut-keys">
              {shortcut.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </div>
            <span>{shortcut.action}</span>
          </div>
        ))}
      </div>
      <p className="muted small">
        所有可操作控件都有可见焦点环。表格支持键盘移动，页面切换后焦点会回到视图标题或筛选框。
      </p>
    </Modal>
  );
}

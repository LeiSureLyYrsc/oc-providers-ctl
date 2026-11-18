import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface MenuItem {
  key: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
  separatorBefore?: boolean;
}

interface MenuButtonProps {
  label: string;
  items: MenuItem[];
}

/** Icon button with a small MD3-style menu. Closes on select, Escape, or outside click. */
export function MenuButton({ label, items }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="btn-icon btn-icon-outlined"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label={label}>
          {items.map((item) => (
            <div key={item.key}>
              {item.separatorBefore ? <div className="menu-sep" /> : null}
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                style={item.danger ? { color: 'var(--error)' } : undefined}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span>{item.label}</span>
                {item.hint ? <span className="menu-hint">{item.hint}</span> : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

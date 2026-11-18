import { useEffect, useState } from 'react';
import type { ProviderEntry, ProviderInventory } from '../ipc';
import { toSafeMessage } from '../ipc';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

interface InventoryDialogProps {
  open: boolean;
  provider: ProviderEntry;
  remaining: number;
  onClose: () => void;
  onFetch: () => Promise<ProviderInventory>;
  onAdd: (ids: string[]) => void;
}

export function InventoryDialog({ open, provider, remaining, onClose, onFetch, onAdd }: InventoryDialogProps) {
  const [inventory, setInventory] = useState<ProviderInventory | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = new Set(provider.models.map((entry) => entry.id));

  useEffect(() => {
    if (!open) return;
    setInventory(null);
    setSelected(new Set());
    setError(null);
    void fetchList();
    // Opening the dialog is the explicit fetch action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider.id]);

  async function fetchList(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setInventory(await onFetch());
    } catch (failure) {
      setInventory(null);
      setError(toSafeMessage(failure));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const ids = inventory?.modelIds ?? [];
  const fresh = ids.filter((id) => !existing.has(id));

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < remaining) {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <Dialog
      open
      title="从供应商获取模型"
      subtitle={`${provider.id} · 只会添加选中且不存在的模型`}
      onClose={onClose}
      wide
      actions={
        <>
          <button type="button" className="btn" onClick={() => void fetchList()} disabled={loading}>
            <Icon name="refresh" size={18} />
            重新获取
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-filled"
            onClick={() => onAdd(Array.from(selected))}
            disabled={selected.size === 0}
          >
            添加 {selected.size > 0 ? selected.size : ''} 个
          </button>
        </>
      }
    >
      {error ? <div className="dialog-error">{error}</div> : null}
      {loading && !inventory ? (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          正在获取…
        </div>
      ) : inventory ? (
        <>
          {remaining <= 0 ? (
            <div className="dialog-note">本次已改太多项，请先保存再继续添加。</div>
          ) : null}
          {ids.length === 0 ? (
            <p className="list-empty">这个供应商没有返回可用模型。</p>
          ) : fresh.length === 0 ? (
            <p className="list-empty">返回的模型都已经存在了。</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
              {ids.map((id) => {
                const already = existing.has(id);
                return (
                  <li
                    key={id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      minHeight: 44,
                      padding: '6px 0',
                      borderBottom: '1px solid var(--outline-variant)',
                      opacity: already ? 0.55 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={already || selected.has(id)}
                      disabled={already || (!selected.has(id) && selected.size >= remaining)}
                      onChange={() => toggle(id)}
                      aria-label={id}
                    />
                    <span className="mono" style={{ fontSize: 15 }}>
                      {id}
                    </span>
                    {already ? (
                      <span className="chip" data-tone="muted" style={{ marginLeft: 'auto' }}>
                        已存在
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="inline-note">
            <Icon name="warning" size={18} />
            新增的模型只包含模型 ID，之后可以再补充名称和长度。
          </p>
        </>
      ) : null}
    </Dialog>
  );
}

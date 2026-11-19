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

/**
 * Plain-HTTP is allowed, not gated: the request already happened by the time a
 * warning exists. The transport case has its own localized notice above the
 * list, so it is filtered out here to avoid saying it twice.
 */
export function inventoryWarningText(warning: string): string | null {
  if (warning.includes('plain HTTP')) return null;
  return warning;
}

export function inventoryWarningList(warnings: string[]): string[] {
  return warnings
    .map(inventoryWarningText)
    .filter((warning): warning is string => Boolean(warning));
}

/** Only show a safe origin, never query strings, paths or embedded credentials. */
export function safeOrigin(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function isPlainHttp(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).protocol === 'http:';
  } catch {
    return false;
  }
}

export function InventoryDialog({ open, provider, remaining, onClose, onFetch, onAdd }: InventoryDialogProps) {
  const [inventory, setInventory] = useState<ProviderInventory | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = new Set(provider.models.map((entry) => entry.id));
  const origin = safeOrigin(provider.baseUrl);

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
  const warnings = inventory?.warnings ?? [];
  const plainHttp = isPlainHttp(provider.baseUrl) || warnings.some((entry) => entry.includes('plain HTTP'));
  const otherWarnings = inventoryWarningList(warnings);

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
      subtitle={`${provider.id}${origin ? ` · ${origin}` : ''} · 只会添加选中且不存在的模型`}
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
          {plainHttp ? (
            <div className="dialog-note" role="status">
              <strong>这次请求使用明文 HTTP。</strong>{' '}
              请求内容没有经过传输加密，可能在网络上被观察或修改；如果供应商配置里带凭据，也会一并暴露。建议把基础地址改成 HTTPS。
            </div>
          ) : null}
          {otherWarnings.length > 0 ? (
            <ul className="dialog-warnings">
              {otherWarnings.map((warning, index) => (
                <li key={`${index}-${warning.slice(0, 24)}`}>{warning}</li>
              ))}
            </ul>
          ) : null}
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
            新增的模型只写入模型 ID；长度和思考能力可在模型详情里用「查询模型资料」补齐。
          </p>
        </>
      ) : null}
    </Dialog>
  );
}

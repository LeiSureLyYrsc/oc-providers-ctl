import { useEffect, useState } from 'react';
import type { ProviderEntry, ProviderInventory } from '../ipc';
import type { ConcreteDialect } from '../lib/paths';
import { formatTimestamp } from '../lib/format';
import { Modal } from './Modal';
import { Badge } from './Badge';
import { Icon } from './Icon';

interface InventoryDialogProps {
  open: boolean;
  provider: ProviderEntry;
  dialect: ConcreteDialect;
  demo: boolean;
  remaining: number;
  onClose: () => void;
  onFetch: () => Promise<ProviderInventory>;
  onAdd: (modelIds: string[]) => void;
}

export function InventoryDialog({
  open,
  provider,
  dialect,
  demo,
  remaining,
  onClose,
  onFetch,
  onAdd,
}: InventoryDialogProps) {
  const [inventory, setInventory] = useState<ProviderInventory | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  const existing = new Set(provider.models.map((model) => model.id));

  const fetchList = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await onFetch();
      setInventory(result);
      setSelected(new Set());
    } catch (failure) {
      setInventory(null);
      setError(failure instanceof Error ? failure.message : '抓取失败。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setInventory(null);
    setSelected(new Set());
    setError(null);
    setAttempted(false);
    void fetchList();
    // Opening the dialog is the explicit action that triggers one fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider.id]);

  if (!open) return null;

  const candidates = inventory?.modelIds ?? [];

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= remaining) return current;
        next.add(id);
      }
      return next;
    });
  };

  const submit = () => {
    setAttempted(true);
    if (selected.size === 0) return;
    onAdd(Array.from(selected));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="INVENTORY / 手动清单"
      title={`抓取 ${provider.id} 的模型标识`}
      width="wide"
      footer={
        <>
          <span className="muted small">
            将暂存 {selected.size} / {Math.max(0, remaining)} 个新模型草稿（只含对象键
            {dialect === 'v2' ? '，不写 modelID / 请求 ID' : ''}）
          </span>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={loading || selected.size === 0}
          >
            添加所选
          </button>
        </>
      }
    >
      <p className="dialog-intro">
        只使用 Rust 侧已有的显式凭据引用读取模型清单，不发起推理请求，也不探测未知协议。新增模型只写对象键，不臆造上下文、输出或请求 ID。
      </p>
      {remaining <= 0 ? (
        <div className="dialog-error">
          当前文件的草稿已达单批上限。请先预演并应用，或撤销部分草稿后再抓取。
        </div>
      ) : null}
      <div className="inventory-toolbar">
        <button type="button" className="btn" onClick={() => void fetchList()} disabled={loading}>
          <Icon name="refresh" size={14} />
          {loading ? '抓取中…' : '重新抓取'}
        </button>
        {inventory ? (
          <span className="muted small mono">
            {candidates.length} 个标识 · {formatTimestamp(inventory.fetchedAt)}
          </span>
        ) : null}
        {demo ? <Badge tone="info">演示清单</Badge> : null}
      </div>

      {error ? (
        <div className="dialog-error">{error}</div>
      ) : loading && !inventory ? (
        <div className="dialog-empty">正在从提供方读取模型清单…</div>
      ) : inventory ? (
        <>
          {inventory.warnings.length > 0 ? (
            <ul className="inline-warnings">
              {inventory.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {candidates.length === 0 ? (
            <div className="dialog-empty">提供方返回了空清单。</div>
          ) : (
            <ul className="inventory-list" aria-label="提供方模型清单">
              {candidates.map((id) => {
                const already = existing.has(id);
                return (
                  <li key={id} className={already ? 'inventory-row is-existing' : 'inventory-row'}>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={selected.has(id)}
                        disabled={already || (!selected.has(id) && selected.size >= remaining)}
                        onChange={() => toggle(id)}
                      />
                      <span className="mono">{id}</span>
                    </label>
                    {already ? (
                      <Badge tone="muted">已存在</Badge>
                    ) : (
                      <span className="muted tiny">将新建 · {dialect.toUpperCase()}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {attempted && selected.size === 0 ? (
            <p className="field-error">请至少选择一个新标识。</p>
          ) : null}
          <p className="muted small">
            只会新增条目。已有模型不会被整体替换；单文件每批最多 64 处编辑，超出时不会再接受选择。
            这是手动动作，不代表目录缓存已刷新。
          </p>
        </>
      ) : (
        <div className="dialog-empty">尚未抓取。</div>
      )}
    </Modal>
  );
}

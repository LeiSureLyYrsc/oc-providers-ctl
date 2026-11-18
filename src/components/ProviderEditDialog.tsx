import { useEffect, useState } from 'react';
import type { ProviderEntry } from '../ipc';
import { Dialog } from './Dialog';

interface ProviderEditDialogProps {
  open: boolean;
  provider: ProviderEntry;
  onClose: () => void;
  onSave: (input: { name: string; baseUrl: string }) => void;
}

export function ProviderEditDialog({ open, provider, onClose, onSave }: ProviderEditDialogProps) {
  const [name, setName] = useState(provider.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');

  useEffect(() => {
    if (!open) return;
    setName(provider.name ?? '');
    setBaseUrl(provider.baseUrl ?? '');
  }, [open, provider.id, provider.name, provider.baseUrl]);

  if (!open) return null;

  return (
    <Dialog
      open
      title="编辑供应商"
      subtitle={provider.id}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-filled"
            onClick={() => onSave({ name: name.trim(), baseUrl: baseUrl.trim() })}
          >
            保存修改
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">显示名称</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="留空则不显示名称"
          data-autofocus
        />
      </label>
      <label className="field">
        <span className="field-label">基础地址</span>
        <input
          className="input mono"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://…"
          spellCheck={false}
        />
        <span className="field-hint">留空会移除这一项；内置供应商可能使用默认地址。</span>
      </label>
    </Dialog>
  );
}

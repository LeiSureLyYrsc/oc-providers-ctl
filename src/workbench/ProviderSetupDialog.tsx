import type { ConcreteDialect } from '../lib/paths';
import type { ProviderDraftInput } from '../lib/paths';
import { useEffect, useState } from 'react';
import { validateProviderId } from '../lib/paths';
import type { SourceDocument } from '../ipc';
import { Dialog } from '../components/Dialog';

interface ProviderSetupDialogProps {
  open: boolean;
  source: SourceDocument | null;
  onClose: () => void;
  onCreate: (dialect: ConcreteDialect, input: ProviderDraftInput) => void;
}

export function ProviderSetupDialog({ open, source, onClose, onCreate }: ProviderSetupDialogProps) {
  const defaultDialect: ConcreteDialect =
    source?.dialect === 'v2' ? 'v2' : source?.dialect === 'v1' ? 'v1' : 'v1';
  const [dialect, setDialect] = useState<ConcreteDialect>(defaultDialect);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [packageName, setPackageName] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDialect(defaultDialect);
    setId('');
    setName('');
    setBaseUrl('');
    setPackageName('');
    setTouched(false);
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || !source) return null;

  const needsChoice = source.dialect !== 'v1' && source.dialect !== 'v2';
  const idIssue = validateProviderId(id);
  const duplicate = source.providers.some((provider) => provider.id === id);
  const valid = Boolean(id) && idIssue === null && !duplicate;

  return (
    <Dialog
      open
      title="添加供应商"
      subtitle="只需要填标识，其他可以稍后补充。"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-filled"
            onClick={() => {
              setTouched(true);
              if (!valid) return;
              onCreate(dialect, { id, name, baseUrl, packageName });
            }}
          >
            添加
          </button>
        </>
      }
    >
      {needsChoice ? (
        <div className="field">
          <span className="field-label">写入哪个配置段</span>
          <div className="segmented" role="group" aria-label="写入哪个配置段">
            <button
              type="button"
              aria-pressed={dialect === 'v1'}
              onClick={() => setDialect('v1')}
            >
              provider
            </button>
            <button
              type="button"
              aria-pressed={dialect === 'v2'}
              onClick={() => setDialect('v2')}
            >
              providers
            </button>
          </div>
          <span className="field-hint">
            这个文件同时有两种写法，需要明确新增到哪一段。
          </span>
        </div>
      ) : null}

      <label className="field">
        <span className="field-label">标识</span>
        <input
          className="input mono"
          value={id}
          onChange={(event) => setId(event.target.value.trim().toLowerCase())}
          placeholder="例如 zhipu"
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
        {touched && idIssue ? <span className="field-error">{idIssue}</span> : null}
        {touched && duplicate ? <span className="field-error">已经有同名供应商了。</span> : null}
        {!idIssue ? (
          <span className="field-hint">小写字母、数字、点和短横线。</span>
        ) : null}
      </label>

      <label className="field">
        <span className="field-label">显示名称（可选）</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如 智谱"
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field-label">基础地址（可选）</span>
        <input
          className="input mono"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://…"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span className="field-label">包名（可选）</span>
        <input
          className="input mono"
          value={packageName}
          onChange={(event) => setPackageName(event.target.value)}
          placeholder="留空则不写入"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
    </Dialog>
  );
}

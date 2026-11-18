import { useEffect, useState } from 'react';
import type { SourceDocument } from '../ipc';
import type { ConcreteDialect, ProviderDraftInput } from '../lib/paths';
import { buildProviderCreateValue, providerMapKey, validateProviderId } from '../lib/paths';
import { Modal } from './Modal';
import { DialectBadge } from './Badge';
import { formatPath } from '../lib/paths';

interface ProviderDialogProps {
  open: boolean;
  source: SourceDocument | null;
  onClose: () => void;
  onCreate: (dialect: ConcreteDialect, input: ProviderDraftInput, mapKey: string) => void;
  demo: boolean;
}

function defaultTarget(source: SourceDocument | null): ConcreteDialect | null {
  if (!source?.writable) return null;
  if (source.dialect === 'v1') return 'v1';
  if (source.dialect === 'v2') return 'v2';
  return null;
}

export function ProviderDialog({ open, source, onClose, onCreate, demo }: ProviderDialogProps) {
  const [target, setTarget] = useState<ConcreteDialect | null>(defaultTarget(source));
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [packageName, setPackageName] = useState('');
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTarget(defaultTarget(source));
    setId('');
    setName('');
    setBaseUrl('');
    setPackageName('');
    setAttempted(false);
  }, [open, source?.path, source?.dialect, source?.writable]);

  if (!source) return null;
  const requiresChoice = source.dialect === 'ambiguous' || source.dialect === 'mixed';
  const idIssue = validateProviderId(id);
  const duplicate = source.providers.some((provider) => provider.id === id);
  const canSubmit: boolean =
    source.writable &&
    Boolean(target) &&
    idIssue === null &&
    !duplicate &&
    !(requiresChoice && target === null);

  const submit = () => {
    setAttempted(true);
    if (!target || !canSubmit) return;
    onCreate(target, { id, name, baseUrl, packageName }, providerMapKey(target));
  };
  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="NEW PROVIDER / 新建提供方"
      title="新增一个提供方条目"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} data-autofocus>
            暂存新建草稿
          </button>
        </>
      }
    >
      <p className="dialog-intro">
        只新增映射中的新键；已有提供方不会被整体替换。凭据字段不在本版本中创建或编辑。
      </p>
      <div className="form-grid">
        <div className="form-field form-span">
          <span className="field-label">目标方言 / MAP</span>
          {requiresChoice ? (
            <div className="segmented" role="radiogroup" aria-label="目标提供方映射">
              <button
                type="button"
                className={target === 'v1' ? 'is-active' : ''}
                onClick={() => setTarget('v1')}
                role="radio"
                aria-checked={target === 'v1'}
              >
                <span className="mono">provider</span>
                <span className="muted small">V1 对象映射</span>
              </button>
              <button
                type="button"
                className={target === 'v2' ? 'is-active' : ''}
                onClick={() => setTarget('v2')}
                role="radio"
                aria-checked={target === 'v2'}
              >
                <span className="mono">providers</span>
                <span className="muted small">V2 提供方集合</span>
              </button>
            </div>
          ) : (
            <div className="readonly-line">
              <DialectBadge dialect={target ?? 'invalid'} />
              <span className="mono">{target ? providerMapKey(target) : '不可写'}</span>
              <span className="muted small">目标由顶层结构确定</span>
            </div>
          )}
          {requiresChoice ? (
            <span className="field-hint">
              该文件顶层为 {source.dialect === 'mixed' ? 'V1 / V2 并存' : '方言待定'}，必须明确写入哪个映射。
            </span>
          ) : null}
        </div>

        <label className="form-field">
          <span className="field-label">标识 / ID</span>
          <input
            className="mono"
            value={id}
            onChange={(event) => setId(event.target.value.trim().toLowerCase())}
            placeholder="例如 zhipu"
            autoComplete="off"
            spellCheck={false}
          />
          {attempted && idIssue ? <span className="field-error">{idIssue}</span> : null}
          {attempted && duplicate ? <span className="field-error">当前配置源已存在该标识。</span> : null}
        </label>

        <label className="form-field">
          <span className="field-label">显示名 / NAME</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="可选"
            autoComplete="off"
          />
        </label>

        <label className="form-field form-span">
          <span className="field-label">基础地址 / BASE URL</span>
          <input
            className="mono"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="可选，例如 https://api.example.com/v1"
            autoComplete="off"
            spellCheck={false}
          />
          {baseUrl && !/^https?:\/\//.test(baseUrl) ? (
            <span className="field-warn">地址不像 HTTP(S) URL；仍会按原样写入，请自行确认。</span>
          ) : null}
        </label>

        <label className="form-field form-span">
          <span className="field-label">包 / {target === 'v2' ? 'PACKAGE' : 'NPM'}</span>
          <input
            className="mono"
            value={packageName}
            onChange={(event) => setPackageName(event.target.value)}
            placeholder="可选，不猜测默认包"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            创建时只写入你填写的字段；未填写则不写包名。后续编辑不会整体替换该条目。
          </span>
        </label>
      </div>

      {target ? (
        <div className="target-preview">
          <span className="eyebrow">TARGET PATH / 写入位置</span>
          <code>{formatPath([providerMapKey(target), id || '<新标识>'], target)}</code>
          <div className="target-note">
            条目值将是
            <code>
              {JSON.stringify(
                buildProviderCreateValue(target, { id, name, baseUrl, packageName }),
              )}
            </code>
            ，字段以草稿形式暂存，预演后才可能写盘。
          </div>
        </div>
      ) : null}
      {demo ? <p className="demo-note">演示模式：只会暂存草稿，不会写入磁盘。</p> : null}
    </Modal>
  );
}

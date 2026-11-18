import { useEffect, useState } from 'react';
import type { ProviderEntry, SourceDocument } from '../ipc';
import type { ModelDraftInput } from '../lib/paths';
import {
  buildModelCreateValue,
  formatPath,
  isConcreteDialect,
  modelRoot,
  validateModelId,
} from '../lib/paths';
import { Modal } from './Modal';
import { DialectBadge } from './Badge';

interface ModelDialogProps {
  open: boolean;
  source: SourceDocument;
  provider: ProviderEntry;
  onClose: () => void;
  onCreate: (input: ModelDraftInput) => void;
  demo: boolean;
}

function parseTokens(input: string): number | null | 'invalid' {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return 'invalid';
  return value;
}

export function ModelDialog({ open, source, provider, onClose, onCreate, demo }: ModelDialogProps) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [context, setContext] = useState('');
  const [inputLimit, setInputLimit] = useState('');
  const [output, setOutput] = useState('');
  const [reasoning, setReasoning] = useState<'' | 'true' | 'false'>('');
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setId('');
    setName('');
    setContext('');
    setInputLimit('');
    setOutput('');
    setReasoning('');
    setAttempted(false);
  }, [open, provider.id, source.path]);

  if (!open) return null;
  const dialect = provider.dialect;
  const concrete = isConcreteDialect(dialect) ? dialect : null;
  if (!concrete) {
    return (
      <Modal open={open} onClose={onClose} eyebrow="NEW MODEL / 新建模型" title="无法新建模型">
        <div className="dialog-error">该提供方嵌套结构无效，只有字段只读视图，不能新增模型。</div>
      </Modal>
    );
  }
  const modelIdIssue = validateModelId(id);
  const duplicate = provider.models.some((model) => model.id === id);
  const parsedContext = parseTokens(context);
  const parsedInput = parseTokens(inputLimit);
  const parsedOutput = parseTokens(output);
  const numberIssue =
    parsedContext === 'invalid'
      ? '上下文窗口必须是非负整数。'
      : parsedInput === 'invalid'
        ? '输入上限必须是非负整数。'
        : parsedOutput === 'invalid'
          ? '输出上限必须是非负整数。'
          : null;
  const canSubmit = Boolean(id) && modelIdIssue === null && !duplicate && numberIssue === null;
  const root = modelRoot(concrete, { providerId: provider.id, modelId: id });
  const draft: ModelDraftInput = {
    id,
    name,
    context: parsedContext === 'invalid' ? null : parsedContext,
    input: parsedInput === 'invalid' ? null : parsedInput,
    output: parsedOutput === 'invalid' ? null : parsedOutput,
    reasoning: reasoning === '' ? null : reasoning === 'true',
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="NEW MODEL / 新建模型"
      title={`在 ${provider.id} 下新增模型`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setAttempted(true);
              if (canSubmit) onCreate(draft);
            }}
            data-autofocus
          >
            暂存新建草稿
          </button>
        </>
      }
    >
      <p className="dialog-intro">
        新建模型只写你在这里填写的字段。元数据稍后可在详情中用目录建议补充；请求 ID 与变体不会被自动填写。
      </p>
      <div className="new-model-meta">
        <DialectBadge dialect={dialect} />
        <span className="mono">{source.path}</span>
      </div>
      <div className="form-grid">
        <label className="form-field">
          <span className="field-label">模型标识 / ID</span>
          <input
            className="mono"
            value={id}
            onChange={(event) => setId(event.target.value.trim())}
            placeholder="例如 kimi-k2-0905-preview"
            autoComplete="off"
            spellCheck={false}
          />
          {attempted && modelIdIssue ? <span className="field-error">{modelIdIssue}</span> : null}
          {attempted && duplicate ? <span className="field-error">该提供方下已存在这个模型标识。</span> : null}
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
        <label className="form-field">
          <span className="field-label">上下文窗口 / CONTEXT</span>
          <input
            className="mono"
            inputMode="numeric"
            value={context}
            onChange={(event) => setContext(event.target.value)}
            placeholder="可选"
          />
        </label>
        <label className="form-field">
          <span className="field-label">输入上限 / LIMIT.INPUT</span>
          <input
            className="mono"
            inputMode="numeric"
            value={inputLimit}
            onChange={(event) => setInputLimit(event.target.value)}
            placeholder="可选"
          />
        </label>
        <label className="form-field">
          <span className="field-label">输出上限 / LIMIT.OUTPUT</span>
          <input
            className="mono"
            inputMode="numeric"
            value={output}
            onChange={(event) => setOutput(event.target.value)}
            placeholder="可选"
          />
        </label>
        <label className="form-field">
          <span className="field-label">推理标记 / REASONING</span>
          <select
            value={reasoning}
            onChange={(event) => setReasoning(event.target.value as '' | 'true' | 'false')}
          >
            <option value="">未设置</option>
            <option value="true">支持（true）</option>
            <option value="false">不支持（false）</option>
          </select>
          <span className="field-hint">
            {concrete === 'v1'
              ? 'V1 写入布尔 reasoning。'
              : 'V2 写入 capabilities.reasoning 归一化对象 { supported }。'}
          </span>
        </label>
      </div>
      {attempted && numberIssue ? <p className="field-error">{numberIssue}</p> : null}

      <div className="target-preview">
        <span className="eyebrow">TARGET PATH / 写入位置</span>
        <code>{formatPath(root, concrete)}</code>
        <div className="target-note">
          新条目值将是 <code>{JSON.stringify(buildModelCreateValue(concrete, draft))}</code>
        </div>
      </div>
      {demo ? <p className="demo-note">演示模式：只会暂存草稿，不会写入磁盘。</p> : null}
    </Modal>
  );
}

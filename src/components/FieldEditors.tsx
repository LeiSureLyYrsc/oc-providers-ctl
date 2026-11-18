import { useMemo, useState } from 'react';
import type { Batch } from '../lib/store';
import { draftForPath } from '../lib/store';
import type { ConcreteDialect } from '../lib/paths';
import { formatTokens } from '../lib/format';
import { parseAdvancedJson } from '../lib/validate';
import { describeReasoning } from '../lib/reasoning';
import { ProvenanceTag, Badge } from './Badge';
import { Icon } from './Icon';

export type StageFn = (
  path: string[],
  op: 'set' | 'remove',
  value: unknown,
  label: string,
) => void;

interface FieldEditorProps {
  label: string;
  hint?: string;
  path: string[];
  dialect: ConcreteDialect;
  current: string | number | null;
  kind: 'text' | 'tokens';
  readLabel: string;
  batch: Batch | null;
  onStage: StageFn;
}

export function FieldEditor({
  label,
  hint,
  path,
  dialect,
  current,
  kind,
  readLabel,
  batch,
  onStage,
}: FieldEditorProps) {
  const initial = current === null ? '' : String(current);
  const [text, setText] = useState(initial);
  const draft = draftForPath(batch, path);
  const trimmed = text.trim();
  const parseError =
    kind === 'tokens'
      ? !trimmed
        ? '请输入非负整数；清除请用下方按钮。'
        : !/^\d+$/.test(trimmed)
          ? '请输入非负整数。'
          : null
      : !trimmed
        ? '值不能为空；若只是清除，请使用下方按钮。'
        : null;
  const draftText = draft
    ? draft.op === 'remove'
      ? '将清除'
      : String(draft.value ?? '')
    : null;

  const stage = () => {
    if (parseError) return;
    if (kind === 'tokens') {
      onStage(path, 'set', Number(trimmed), label);
    } else {
      onStage(path, 'set', trimmed, label);
    }
  };

  return (
    <div className="field-editor" data-path={path.join('.')} data-dialect={dialect}>
      <div className="field-top">
        <span className="field-label">{label}</span>
        <span className="field-path mono">{readLabel}</span>
      </div>
      <div className="field-read">
        <ProvenanceTag origin="read" />
        <span className="mono field-read-value">
          {current === null
            ? '未设置'
            : typeof current === 'number'
              ? formatTokens(current)
              : current}
        </span>
      </div>
      {draftText !== null ? (
        <div className="field-draft">
          <ProvenanceTag origin={draft?.origin ?? 'manual'} />
          <span className="mono">{draftText}</span>
        </div>
      ) : null}
      <div className="field-input-row">
        <input
          className={kind === 'tokens' ? 'mono' : ''}
          value={text}
          inputMode={kind === 'tokens' ? 'numeric' : undefined}
          onChange={(event) => setText(event.target.value)}
          placeholder={kind === 'tokens' ? '留空并使用下方清除' : '输入新值'}
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              stage();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-small"
          onClick={stage}
          disabled={Boolean(parseError) || draftText === trimmed}
        >
          设为草稿
        </button>
        {current !== null ? (
          <button
            type="button"
            className="btn btn-small btn-ghost btn-clear"
            onClick={() => onStage(path, 'remove', undefined, label)}
            title="清除这个叶子字段（草稿）"
          >
            清除
          </button>
        ) : null}
      </div>
      {parseError && trimmed ? <span className="field-error">{parseError}</span> : null}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

interface AdvancedJsonEditorProps {
  label: string;
  field: 'reasoning' | 'variants';
  dialect: ConcreteDialect;
  path: string[];
  current: unknown;
  batch: Batch | null;
  onStage: StageFn;
  disabled?: boolean;
}

export function AdvancedJsonEditor({
  label,
  field,
  dialect,
  path,
  current,
  batch,
  onStage,
  disabled,
}: AdvancedJsonEditorProps) {
  const currentText = current === null ? '' : JSON.stringify(current, null, field === 'variants' ? 2 : 0);
  const [text, setText] = useState(currentText);
  const draft = draftForPath(batch, path);
  const parsed = useMemo(() => parseAdvancedJson(field, dialect, text), [field, dialect, text]);
  const hasText = text.trim().length > 0;
  const placeholder =
    field === 'reasoning'
      ? dialect === 'v1'
        ? 'true'
        : '{"supported": true}'
      : dialect === 'v1'
        ? '{ "high": { "reasoning": true } }'
        : '[ { "id": "thinking" } ]';
  const hint =
    field === 'reasoning'
      ? dialect === 'v1'
        ? 'V1 只接受布尔值。'
        : 'V2 只接受归一化对象 { supported, toggle?, effort?, budget? }；不写裸布尔。'
      : dialect === 'v1'
        ? 'V1 的 variants 是对象：变体名 → 配置。'
        : 'V2 的 variants 是数组。';
  const currentSummary = field === 'reasoning' ? describeReasoning(current) : current === null ? '未设置' : '已有值';

  return (
    <div className="advanced-field">
      <div className="field-top">
        <span className="field-label">{label}</span>
        <span className="field-path mono">整体替换 leaf</span>
      </div>
      <div className="field-read">
        <ProvenanceTag origin="read" />
        <span className="mono field-read-value">{currentSummary}</span>
        {draft ? (
          <span className="draft-inline">
            <ProvenanceTag origin={draft.origin} />
            草稿已暂存
          </span>
        ) : null}
      </div>
      <textarea
        className="json-editor mono"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={`${label} JSON`}
        rows={field === 'variants' ? 6 : 3}
        disabled={disabled}
      />
      <div className={`json-status ${hasText ? (parsed.ok ? 'is-ok' : 'is-error') : ''}`}>
        <span>{hasText ? parsed.summary : '尚未输入 JSON'}</span>
        <span className="muted tiny mono">{hint}</span>
      </div>
      {hasText && parsed.issues.length > 0 ? (
        <ul className="validation-list">
          {parsed.issues.map((issue, index) => (
            <li key={`${issue.level}-${index}`} className={issue.level === 'error' ? 'is-error' : 'is-warning'}>
              {issue.level === 'error' ? <Icon name="warning" size={12} /> : <Icon name="info" size={12} />}
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="advanced-actions">
        <button
          type="button"
          className="btn btn-small"
          disabled={!parsed.ok || !hasText || disabled}
          onClick={() => {
            if (!parsed.ok) return;
            onStage(path, 'set', parsed.value, label);
          }}
        >
          设为草稿
        </button>
        {current !== null ? (
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => onStage(path, 'remove', undefined, label)}
            disabled={disabled}
          >
            清除字段
          </button>
        ) : null}
        <span className="tray-spacer" />
        {draft ? <Badge tone="draft">已暂存</Badge> : null}
      </div>
      <p className="field-hint">
        写入时会整体替换该字段。请保留你需要的子字段；目录建议不会自动改写变体。
      </p>
    </div>
  );
}

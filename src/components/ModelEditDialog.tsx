import { useEffect, useState } from 'react';
import type { ModelEntry, ProviderEntry } from '../ipc';
import type { ConcreteDialect, ModelDraftInput } from '../lib/paths';
import { validateModelId } from '../lib/paths';
import { reasoningSupported } from '../lib/reasoning';
import { parseAdvancedJson } from '../lib/validate';
import { Dialog } from './Dialog';

interface ModelEditDialogProps {
  open: boolean;
  provider: ProviderEntry;
  model: ModelEntry | null;
  onClose: () => void;
  /** Existing model: leaves are written individually; reasoning is the full new value. */
  onSave: (input: ModelDraftInput, reasoning: unknown, variants: unknown) => void;
  /** New model: reasoning is already dialect-correct (V1 bool / V2 normalized object). */
  onCreate: (input: ModelDraftInput, reasoning: unknown, variants: unknown) => void;
}

type ReasoningChoice = 'keep' | 'yes' | 'no' | 'clear';

function parseTokens(value: string): number | null | 'invalid' {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

function effortOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const effort = (value as { effort?: unknown }).effort;
  return Array.isArray(effort) && effort.every((entry) => typeof entry === 'string')
    ? (effort as string[]).join(', ')
    : '';
}

function initialChoice(value: unknown, creating: boolean): ReasoningChoice {
  if (creating || value === null || value === undefined) return 'keep';
  const supported = reasoningSupported(value);
  if (supported === true) return 'yes';
  if (supported === false) return 'no';
  return 'keep';
}

/** V2 keeps every field of the existing object except those the controls own. */
function mergeV2Reasoning(
  current: unknown,
  supported: boolean,
  effortText: string,
): Record<string, unknown> {
  const base =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  const value: Record<string, unknown> = { ...base, supported };
  if (!supported) {
    delete value.effort;
    delete value.toggle;
    delete value.budget;
    return value;
  }
  const list = effortText
    .split(/[,，\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (list.length > 0) value.effort = list;
  else if (Object.prototype.hasOwnProperty.call(value, 'effort')) delete value.effort;
  return value;
}

export function ModelEditDialog({
  open,
  provider,
  model,
  onClose,
  onSave,
  onCreate,
}: ModelEditDialogProps) {
  const dialect: ConcreteDialect | null =
    provider.dialect === 'v1' || provider.dialect === 'v2' ? provider.dialect : null;
  const creating = !model;

  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [context, setContext] = useState('');
  const [inputLimit, setInputLimit] = useState('');
  const [output, setOutput] = useState('');
  const [choice, setChoice] = useState<ReasoningChoice>('keep');
  const [effort, setEffort] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [reasoningJson, setReasoningJson] = useState('');
  const [variantsJson, setVariantsJson] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setAdvanced(false);
    setId(model?.id ?? '');
    setName(model?.name ?? '');
    setContext(model?.context == null ? '' : String(model.context));
    setInputLimit(model?.input == null ? '' : String(model.input));
    setOutput(model?.output == null ? '' : String(model.output));
    setChoice(initialChoice(model?.reasoning, creating));
    setEffort(effortOf(model?.reasoning));
    setReasoningJson(
      model?.reasoning == null ? '' : JSON.stringify(model.reasoning, null, 2),
    );
    setVariantsJson(model?.variants == null ? '' : JSON.stringify(model.variants, null, 2));
  }, [open, model, creating]);

  if (!open || !dialect) return null;

  const contextValue = parseTokens(context);
  const inputValue = parseTokens(inputLimit);
  const outputValue = parseTokens(output);
  const idIssue = creating ? validateModelId(id) : null;
  const duplicate = creating && provider.models.some((entry) => entry.id === id);
  const numberIssue =
    contextValue === 'invalid'
      ? '上下文长度需要是数字。'
      : inputValue === 'invalid'
        ? '输入上限需要是数字。'
        : outputValue === 'invalid'
          ? '输出上限需要是数字。'
          : null;

  const reasoningResult =
    advanced && reasoningJson.trim() ? parseAdvancedJson('reasoning', dialect, reasoningJson) : null;
  const variantsResult =
    advanced && variantsJson.trim() ? parseAdvancedJson('variants', dialect, variantsJson) : null;

  const originalReasoning = creating ? null : (model as ModelEntry).reasoning;

  function buildReasoning(): unknown {
    if (advanced) {
      if (!reasoningJson.trim()) return null;
      return reasoningResult?.value ?? originalReasoning;
    }
    if (choice === 'keep') return originalReasoning;
    if (choice === 'clear') return null;
    const supported = choice === 'yes';
    if (dialect === 'v1') return supported;
    return mergeV2Reasoning(originalReasoning, supported, effort);
  }

  const nextReasoning = buildReasoning();
  const reasoningChanged =
    JSON.stringify(nextReasoning) !== JSON.stringify(originalReasoning) ||
    (creating && nextReasoning !== null);

  function submit(): void {
    setTouched(true);
    if (creating && (!id || idIssue || duplicate)) return;
    if (numberIssue) return;
    if (advanced && reasoningResult && !reasoningResult.ok) return;
    if (advanced && variantsResult && !variantsResult.ok) return;

    const variants = advanced
      ? variantsJson.trim()
        ? (variantsResult?.value ?? null)
        : null
      : creating
        ? null
        : (model as ModelEntry).variants;

    const input: ModelDraftInput = {
      id: creating ? id : (model as ModelEntry).id,
      name,
      context: contextValue === 'invalid' ? null : contextValue,
      input: inputValue === 'invalid' ? null : inputValue,
      output: outputValue === 'invalid' ? null : outputValue,
      // Only carries the V1 boolean; V2 objects are passed through `reasoning`.
      reasoning: typeof nextReasoning === 'boolean' ? nextReasoning : null,
    };

    if (creating) {
      onCreate(
        { ...input, variants: variants === null ? undefined : variants },
        reasoningChanged ? nextReasoning : null,
        variants,
      );
      return;
    }

    onSave(input, reasoningChanged ? nextReasoning : originalReasoning, variants);
  }

  return (
    <Dialog
      open
      title={creating ? '添加模型' : '编辑模型'}
      subtitle={creating ? provider.id : `${provider.id} · ${model?.id}`}
      onClose={onClose}
      wide
      actions={
        <>
          <button type="button" className="btn" onClick={() => setAdvanced((value) => !value)}>
            {advanced ? '收起高级' : '高级选项'}
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-filled" onClick={submit}>
            {creating ? '添加' : '保存修改'}
          </button>
        </>
      }
    >
      {creating ? (
        <label className="field">
          <span className="field-label">模型 ID</span>
          <input
            className="input mono"
            value={id}
            onChange={(event) => setId(event.target.value.trim())}
            placeholder="例如 glm-4.6"
            autoComplete="off"
            spellCheck={false}
            data-autofocus
          />
          {touched && idIssue ? <span className="field-error">{idIssue}</span> : null}
          {touched && duplicate ? (
            <span className="field-error">这个供应商下已经有该模型。</span>
          ) : null}
        </label>
      ) : null}

      <label className="field">
        <span className="field-label">显示名称（可选）</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如 GLM-4.6"
          autoComplete="off"
        />
      </label>

      <div className="field-grid" style={{ marginTop: 14 }}>
        <label className="field" style={{ marginTop: 0 }}>
          <span className="field-label">上下文长度</span>
          <input
            className="input mono"
            inputMode="numeric"
            value={context}
            onChange={(event) => setContext(event.target.value)}
            placeholder="例如 200000"
          />
        </label>
        <label className="field" style={{ marginTop: 0 }}>
          <span className="field-label">输入上限（可选）</span>
          <input
            className="input mono"
            inputMode="numeric"
            value={inputLimit}
            onChange={(event) => setInputLimit(event.target.value)}
            placeholder="留空则不写入"
          />
        </label>
        <label className="field" style={{ marginTop: 0 }}>
          <span className="field-label">输出上限</span>
          <input
            className="input mono"
            inputMode="numeric"
            value={output}
            onChange={(event) => setOutput(event.target.value)}
            placeholder="例如 131072"
          />
        </label>
      </div>
      {touched && numberIssue ? <p className="field-error">{numberIssue}</p> : null}

      {!advanced ? (
        <div className="field">
          <span className="field-label">推理</span>
          <div className="segmented" role="group" aria-label="推理">
            <button type="button" aria-pressed={choice === 'keep'} onClick={() => setChoice('keep')}>
              {creating ? '不设置' : '保持不变'}
            </button>
            <button type="button" aria-pressed={choice === 'yes'} onClick={() => setChoice('yes')}>
              支持
            </button>
            <button type="button" aria-pressed={choice === 'no'} onClick={() => setChoice('no')}>
              不支持
            </button>
            {!creating ? (
              <button type="button" aria-pressed={choice === 'clear'} onClick={() => setChoice('clear')}>
                不写入
              </button>
            ) : null}
          </div>
          {choice === 'yes' && dialect === 'v2' ? (
            <input
              className="input mono"
              value={effort}
              onChange={(event) => setEffort(event.target.value)}
              placeholder="可选：档位，用逗号分隔，例如 low, high"
              spellCheck={false}
              aria-label="推理档位"
            />
          ) : null}
          <span className="field-hint">
            {dialect === 'v1'
              ? '旧版配置只记录是否支持。'
              : choice === 'keep'
                ? '保持原样不会改动已有设置；其他选项只改支持状态和档位。'
                : '只改支持状态和档位，其它已有设置保持不动。'}
          </span>
        </div>
      ) : (
        <>
          <div className="field">
            <span className="field-label">推理设置（JSON）</span>
            <textarea
              className="textarea"
              value={reasoningJson}
              onChange={(event) => setReasoningJson(event.target.value)}
              placeholder={dialect === 'v1' ? 'true' : '{ "supported": true }'}
              spellCheck={false}
              rows={4}
              aria-label="推理设置 JSON"
            />
            {reasoningJson.trim() ? (
              reasoningResult?.ok ? (
                <span className="field-hint">格式正确。</span>
              ) : (
                <span className="field-error">{reasoningResult?.issues[0]?.message}</span>
              )
            ) : (
              <span className="field-hint">留空则不写入推理设置。</span>
            )}
          </div>
          <div className="field">
            <span className="field-label">模型变体（JSON）</span>
            <textarea
              className="textarea"
              value={variantsJson}
              onChange={(event) => setVariantsJson(event.target.value)}
              placeholder={dialect === 'v1' ? '{ "high": { "reasoning": true } }' : '[ { "id": "fast" } ]'}
              spellCheck={false}
              rows={6}
              aria-label="模型变体 JSON"
            />
            {variantsJson.trim() ? (
              variantsResult?.ok ? (
                <span className="field-hint">格式正确。</span>
              ) : (
                <span className="field-error">{variantsResult?.issues[0]?.message}</span>
              )
            ) : (
              <span className="field-hint">留空则不写入变体。</span>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

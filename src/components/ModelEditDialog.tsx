import { useEffect, useState } from 'react';
import type { CatalogResult, ModelCandidate, ModelEntry, ProviderEntry } from '../ipc';
import type { AdoptionSelection } from '../lib/adoption';
import type { ConcreteDialect, ModelDraftInput } from '../lib/paths';
import { validateModelId } from '../lib/paths';
import {
  buildV2Reasoning,
  budgetClearsStored,
  budgetEdited,
  draftFromReasoning,
  draftIssue,
  parseEffortText,
  type ReasoningDraft,
  type ToggleChoice,
} from '../lib/reasoningDraft';
import { describeReasoningDetail } from '../lib/reasoning';
import { parseAdvancedJson } from '../lib/validate';
import { parseTokenInput, tokenInputValue } from '../lib/tokens';
import { formatTokens } from '../lib/format';
import { CandidatePicker } from './CandidatePicker';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

interface ModelEditDialogProps {
  open: boolean;
  provider: ProviderEntry;
  model: ModelEntry | null;
  catalog: CatalogResult | null;
  catalogLoading: boolean;
  onRefreshCatalog: () => Promise<CatalogResult | null>;
  onSearch: (query: string) => Promise<ModelCandidate[]>;
  onClose: () => void;
  /** Existing model: leaves are written individually; reasoning is the full new value. */
  onSave: (input: ModelDraftInput, reasoning: unknown, variants: unknown) => void;
  /** New model: reasoning is already dialect-correct (V1 bool / V2 normalized object). */
  onCreate: (input: ModelDraftInput, reasoning: unknown, variants: unknown) => void;
}

/** `unset` keeps whatever the config already has; `clear` deletes the key. */
type AbilityChoice = 'unset' | 'supported' | 'unsupported' | 'clear';

const TOGGLE_OPTIONS: Array<{ value: ToggleChoice; label: string }> = [
  { value: 'unset', label: '不写入' },
  { value: 'allowed', label: '允许关闭思考' },
  { value: 'denied', label: '不允许关闭' },
];

function initialAbility(value: unknown, creating: boolean): AbilityChoice {
  if (creating) return 'unset';
  if (value === null || value === undefined) return 'unset';
  const draft = draftFromReasoning(value);
  if (!draft) return 'unset';
  return draft.supported ? 'supported' : 'unsupported';
}

function reasoningSourceLabel(value: unknown): string {
  if (value === null || value === undefined) return '未设置';
  if (typeof value === 'boolean') return value ? '旧版：支持' : '旧版：不支持';
  return '自定义结构';
}

export function ModelEditDialog({
  open,
  provider,
  model,
  catalog,
  catalogLoading,
  onRefreshCatalog,
  onSearch,
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
  const [ability, setAbility] = useState<AbilityChoice>('unset');
  const [toggle, setToggle] = useState<ToggleChoice>('unset');
  const [effortText, setEffortText] = useState('');
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const [budgetExtra, setBudgetExtra] = useState<Record<string, unknown>>({});
  const [stored, setStored] = useState<ReasoningDraft['stored']>({
    effort: [],
    hasEffort: false,
    hasBudget: false,
  });
  const [advanced, setAdvanced] = useState(false);
  const [reasoningJson, setReasoningJson] = useState('');
  const [variantsJson, setVariantsJson] = useState('');
  const [jsonDirty, setJsonDirty] = useState(false);
  const [variantsDirty, setVariantsDirty] = useState(false);
  const [rawReasoning, setRawReasoning] = useState('');
  const [touched, setTouched] = useState(false);
  const [picking, setPicking] = useState(false);
  const [fillNote, setFillNote] = useState<string | null>(null);

  function applyDraft(draft: ReasoningDraft | null): void {
    if (!draft) {
      setToggle('unset');
      setEffortText('');
      setBudgetMin('');
      setBudgetMax('');
      setExtra({});
      setBudgetExtra({});
      setStored({ effort: [], hasEffort: false, hasBudget: false });
      return;
    }
    setToggle(draft.toggle);
    setEffortText(draft.effortText);
    setBudgetMin(draft.budgetMin);
    setBudgetMax(draft.budgetMax);
    setExtra(draft.extra);
    setBudgetExtra(draft.budgetExtra);
    setStored(draft.stored);
  }

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setAdvanced(false);
    setJsonDirty(false);
    setVariantsDirty(false);
    setPicking(false);
    setFillNote(null);
    setId(model?.id ?? '');
    setName(model?.name ?? '');
    setContext(tokenInputValue(model?.context));
    setInputLimit(tokenInputValue(model?.input));
    setOutput(tokenInputValue(model?.output));
    setAbility(initialAbility(model?.reasoning, creating));
    applyDraft(draftFromReasoning(model?.reasoning));
    const raw = model?.reasoning == null ? '' : JSON.stringify(model.reasoning, null, 2);
    setRawReasoning(raw);
    setReasoningJson(raw);
    setVariantsJson(model?.variants == null ? '' : JSON.stringify(model.variants, null, 2));
  }, [open, model, creating]);

  if (!open || !dialect) return null;

  const contextValue = parseTokenInput(context);
  const inputValue = parseTokenInput(inputLimit);
  const outputValue = parseTokenInput(output);

  const idIssue = creating ? validateModelId(id) : null;
  const duplicate = creating && provider.models.some((entry) => entry.id === id);
  const numberIssue =
    contextValue === 'invalid'
      ? '上下文长度需要是非负整数 token，例如 262144。'
      : inputValue === 'invalid'
        ? '输入上限需要是非负整数 token，例如 180000。'
        : outputValue === 'invalid'
          ? '输出上限需要是非负整数 token，例如 8192。'
          : null;

  const currentDraft: ReasoningDraft = {
    supported: ability !== 'unsupported',
    toggle,
    effortText,
    budgetMin,
    budgetMax,
    extra,
    budgetExtra,
    stored,
  };
  const budgetIssue = draftIssue(currentDraft);
  const effortList = parseEffortText(effortText);
  const hasBudgetInput = Boolean(budgetMin.trim() || budgetMax.trim());
  const storedLevels =
    stored.hasEffort && stored.effort.length > 0 ? stored.effort : [];
  const storedBudget = stored.hasBudget ? stored.budget : undefined;
  // Both are written when levels and bounds coexist, but OpenCode ignores the
  // budget once effort levels are set, so say that instead of "upper bound".
  const effortAndBudget =
    ability === 'supported' &&
    dialect === 'v2' &&
    effortList.length > 0 &&
    (hasBudgetInput || storedBudget !== undefined);

  const reasoningResult =
    advanced && reasoningJson.trim() ? parseAdvancedJson('reasoning', dialect, reasoningJson) : null;
  const variantsResult =
    advanced && variantsJson.trim() ? parseAdvancedJson('variants', dialect, variantsJson) : null;

  const originalReasoning = creating ? null : (model as ModelEntry).reasoning;
  const unrepresentable =
    !advanced &&
    !creating &&
    originalReasoning !== null &&
    draftFromReasoning(originalReasoning) === null;

  function buildReasoning(): unknown {
    if (advanced) {
      if (!reasoningJson.trim()) return null;
      return reasoningResult?.value ?? originalReasoning;
    }
    if (ability === 'unset') return originalReasoning;
    if (ability === 'clear') return null;
    if (dialect === 'v1') return ability === 'supported';
    if (ability === 'unsupported') return { supported: false };
    return buildV2Reasoning(currentDraft);
  }

  const nextReasoning = buildReasoning();
  const reasoningChanged =
    JSON.stringify(nextReasoning) !== JSON.stringify(originalReasoning) ||
    (creating && nextReasoning !== null);

  function openAdvanced(): void {
    // Basic -> JSON carries unsaved form edits over instead of resetting them.
    if (dialect === 'v1') {
      if (ability === 'clear') setReasoningJson('');
      else if (ability === 'unset') setReasoningJson(rawReasoning);
      else setReasoningJson(String(ability === 'supported'));
    } else {
      const value =
        ability === 'unset'
          ? originalReasoning
          : ability === 'clear'
            ? null
            : ability === 'unsupported'
              ? { supported: false }
              : buildV2Reasoning(currentDraft);
      setReasoningJson(value === null ? '' : JSON.stringify(value, null, 2));
    }
    // The initial open already seeded variantsJson from the stored model, so an
    // empty textarea means the user cleared it; reopening must not restore it.
    setJsonDirty(true);
    setAdvanced(true);
  }

  /**
   * Returns true when the JSON view could be folded back into the basic form.
   * Reasoning and variants are validated together so an invalid variant block
   * can never be dismissed and silently replaced by the stored value.
   */
  function closeAdvanced(): boolean {
    const trimmed = reasoningJson.trim();
    // Validate both blocks before mutating anything, so a bad variant cannot
    // be dropped after the reasoning draft was already applied.
    if (trimmed) {
      const parsed = parseAdvancedJson('reasoning', dialect as ConcreteDialect, trimmed);
      if (!parsed.ok) return false;
      if (!draftFromReasoning(parsed.value)) return false;
    }
    const variantsTrimmed = variantsJson.trim();
    const variantsParsed = variantsTrimmed
      ? parseAdvancedJson('variants', dialect as ConcreteDialect, variantsTrimmed)
      : null;
    if (variantsParsed && !variantsParsed.ok) return false;

    if (!trimmed) {
      setAbility('clear');
      applyDraft(null);
    } else {
      const value = parseAdvancedJson('reasoning', dialect as ConcreteDialect, trimmed).value;
      const draft = draftFromReasoning(value)!;
      setAbility(draft.supported ? 'supported' : 'unsupported');
      applyDraft(draft);
      setRawReasoning(JSON.stringify(value, null, 2));
      setReasoningJson(JSON.stringify(value, null, 2));
    }
    if (variantsParsed?.ok) {
      setVariantsJson(JSON.stringify(variantsParsed.value, null, 2));
      setVariantsDirty(true);
    }
    setAdvanced(false);
    setJsonDirty(false);
    return true;
  }
  function submit(): void {
    setTouched(true);
    if (creating && (!id || idIssue || duplicate)) return;
    if (numberIssue) return;
    if (!advanced && ability === 'supported' && dialect === 'v2' && budgetIssue) return;
    if (advanced && reasoningResult && !reasoningResult.ok) return;
    if (advanced && variantsResult && !variantsResult.ok) return;

    // Variants edited in the JSON view survive collapsing back to the basic form.
    const variantsParsed = variantsJson.trim()
      ? parseAdvancedJson('variants', dialect as ConcreteDialect, variantsJson)
      : null;
    if (variantsDirty && variantsParsed && !variantsParsed.ok) {
      if (!advanced) setAdvanced(true);
      return;
    }
    let variants: unknown;
    if (variantsDirty) {
      variants = variantsParsed?.ok ? variantsParsed.value : null;
    } else if (advanced) {
      variants = variantsParsed?.ok ? variantsParsed.value : null;
    } else {
      variants = creating ? null : (model as ModelEntry).variants;
    }

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

  function adopt(candidate: ModelCandidate, selection: AdoptionSelection): void {
    const notes: string[] = [];
    if (selection.name && candidate.name.trim()) {
      setName(candidate.name.trim());
      notes.push('名称');
    }
    if (selection.context && candidate.context !== null) {
      setContext(String(candidate.context));
      notes.push('上下文');
    }
    if (selection.input && candidate.input !== null) {
      setInputLimit(String(candidate.input));
      notes.push('输入上限');
    }
    if (selection.output && candidate.output !== null) {
      setOutput(String(candidate.output));
      notes.push('输出上限');
    }
    if (selection.reasoning && candidate.reasoning !== null) {
      const draft = draftFromReasoning(candidate.reasoning);
      setAbility(draft ? (draft.supported ? 'supported' : 'unsupported') : 'unset');
      applyDraft(draft);
      setRawReasoning(JSON.stringify(candidate.reasoning, null, 2));
      setReasoningJson(JSON.stringify(candidate.reasoning, null, 2));
      setJsonDirty(true);
      notes.push('思考能力');
    }
    const detail = describeReasoningDetail(candidate.reasoning);
    setFillNote(
      notes.length > 0
        ? `已填入：${notes.join('、')}。目录显示支持=${detail.supported}，档位=${detail.effort}，预算=${detail.budget}。仍可按需修改。`
        : '这条候选没有可填入的字段。',
    );
    // Return to whichever view the user came from, with its draft state intact.
    setPicking(false);
  }

  /** Entering the picker must not discard unsaved advanced-view content. */
  function startPicking(): void {
    if (advanced && !closeAdvanced()) return;
    setPicking(true);
  }

  const formSummary = describeReasoningDetail(buildReasoning());

  return (
    <Dialog
      open
      title={picking ? '查询模型资料' : creating ? '添加模型' : '编辑模型'}
      subtitle={
        picking
          ? `${provider.id} · 只会回填表单，保存后才会进入待保存`
          : creating
            ? provider.id
            : `${provider.id} · ${model?.id}`
      }
      onClose={picking ? () => setPicking(false) : onClose}
      wide
      actions={
        picking ? (
          <>
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => setPicking(false)}>
              返回编辑
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (advanced) closeAdvanced();
                else openAdvanced();
              }}
            >
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
        )
      }
    >
      {picking ? (
        <CandidatePicker
          providerId={provider.id}
          dialect={dialect}
          baseline={{
            name: name.trim() ? name.trim() : null,
            context: contextValue === 'invalid' ? null : contextValue,
            input: inputValue === 'invalid' ? null : inputValue,
            output: outputValue === 'invalid' ? null : outputValue,
            // Compare against what the form currently shows, not the stored model.
            reasoning: ability === 'unset' ? originalReasoning : nextReasoning,
          }}
          initialQuery={creating ? id.trim() : model?.requestId || model?.id || ''}
          catalog={catalog}
          catalogLoading={catalogLoading}
          onRefreshCatalog={onRefreshCatalog}
          onSearch={onSearch}
          onAdopt={adopt}
        />
      ) : (
        <>
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
                aria-label="模型 ID"
                data-autofocus
              />
              <span className="field-hint">模型 ID 是配置里的键；请求 ID 不会被修改。</span>
              {touched && idIssue ? <span className="field-error">{idIssue}</span> : null}
              {touched && duplicate ? (
                <span className="field-error">这个供应商下已经有该模型。</span>
              ) : null}
            </label>
          ) : null}

          <div className="field">
            <div className="field-label-row">
              <span className="field-label">显示名称（可选）</span>
              <button type="button" className="text-btn" onClick={startPicking}>
                查询模型资料
              </button>
            </div>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 GLM-4.6"
              autoComplete="off"
              aria-label="显示名称（可选）"
            />
          </div>

          {fillNote ? (
            <div className="dialog-note" role="status">
              {fillNote}
            </div>
          ) : null}

          <div className="field-grid" style={{ marginTop: 14 }}>
            <label className="field" style={{ marginTop: 0 }}>
              <span className="field-label">上下文长度（token）</span>
              <input
                className="input mono"
                inputMode="numeric"
                value={context}
                onChange={(event) => setContext(event.target.value)}
                placeholder="例如 262144"
                aria-label="上下文长度"
              />
              <span className="field-hint">
                {contextValue === null
                  ? '留空则不写入这一项。'
                  : contextValue === 'invalid'
                    ? '只接受整数 token。'
                    : `= ${formatTokens(contextValue)} token`}
              </span>
            </label>
            <label className="field" style={{ marginTop: 0 }}>
              <span className="field-label">输入上限（token，可选）</span>
              <input
                className="input mono"
                inputMode="numeric"
                value={inputLimit}
                onChange={(event) => setInputLimit(event.target.value)}
                placeholder="留空则不写入"
                aria-label="输入上限（可选）"
              />
              <span className="field-hint">
                {inputValue === null
                  ? '留空则不写入这一项。'
                  : inputValue === 'invalid'
                    ? '只接受整数 token。'
                    : `= ${formatTokens(inputValue)} token`}
              </span>
            </label>
            <label className="field" style={{ marginTop: 0 }}>
              <span className="field-label">输出上限（token）</span>
              <input
                className="input mono"
                inputMode="numeric"
                value={output}
                onChange={(event) => setOutput(event.target.value)}
                placeholder="例如 8192"
                aria-label="输出上限"
              />
              <span className="field-hint">
                {outputValue === null
                  ? '留空则不写入这一项。'
                  : outputValue === 'invalid'
                    ? '只接受整数 token。'
                    : `= ${formatTokens(outputValue)} token`}
              </span>
            </label>
          </div>
          {touched && numberIssue ? <p className="field-error">{numberIssue}</p> : null}

          {!advanced ? (
            <>
              <div className="field">
                <span className="field-label">思考能力</span>
                <div className="segmented" role="group" aria-label="思考能力">
                  <button
                    type="button"
                    aria-pressed={ability === 'unset'}
                    onClick={() => setAbility('unset')}
                  >
                    {creating ? '不设置' : '保持不变'}
                  </button>
                  <button
                    type="button"
                    aria-pressed={ability === 'supported'}
                    onClick={() => setAbility('supported')}
                  >
                    支持
                  </button>
                  <button
                    type="button"
                    aria-pressed={ability === 'unsupported'}
                    onClick={() => setAbility('unsupported')}
                  >
                    不支持
                  </button>
                </div>
                <span className="field-hint">
                  {dialect === 'v1'
                    ? '旧版配置只记录是否支持；档位和预算需要 V2 才能保存。'
                    : ability === 'unset'
                      ? creating
                        ? '未设置时不写入思考能力。'
                        : '保持不变：不会改动配置里原有的思考设置。'
                      : '这是模型声明的能力，不是默认请求强度。'}
                </span>
              </div>

              {!creating && ability !== 'clear' ? (
                <div className="field-actions">
                  <button type="button" className="text-btn" onClick={() => setAbility('clear')}>
                    从配置中移除思考设置
                  </button>
                </div>
              ) : null}

              {ability === 'clear' ? (
                <p className="inline-note">
                  <Icon name="warning" size={18} />
                  保存后会删除这项思考设置，包括自定义内容。
                </p>
              ) : null}

              {dialect === 'v2' && ability === 'supported' ? (
                <>
                  <div className="field">
                    <span className="field-label">允许关闭思考</span>
                    <div className="segmented" role="group" aria-label="允许关闭思考">
                      {TOGGLE_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={toggle === option.value}
                          onClick={() => setToggle(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <span className="field-hint">
                      {toggle === 'unset'
                        ? '未设置：保存后会删除 toggle，表示配置没有声明能否关闭思考。'
                        : toggle === 'allowed'
                          ? '允许关闭思考：可以关掉思考后再请求。'
                          : '不允许关闭思考：模型总是会思考。'}
                    </span>
                  </div>

                  <div className="field">
                    <span className="field-label">可选档位</span>
                    <input
                      className="input mono"
                      value={effortText}
                      onChange={(event) => setEffortText(event.target.value)}
                      placeholder="可选：用逗号分隔，例如 low, high"
                      spellCheck={false}
                      aria-label="推理档位"
                    />
                    <span className="field-hint">
                      {effortList.length > 0
                        ? `保存为 ${effortList.join(' / ')}。只写明确填写的档位。`
                        : storedLevels.length > 0
                          ? `清空后保存会移除原档位 ${storedLevels.join(' / ')}。`
                          : '目录只声明支持时不会自动生成档位。'}
                    </span>
                  </div>

                  <div className="field">
                    <span className="field-label">预算范围（token）</span>
                    <div className="field-grid">
                      <input
                        className="input mono"
                        inputMode="numeric"
                        value={budgetMin}
                        onChange={(event) => setBudgetMin(event.target.value)}
                        placeholder="下限，例如 0"
                        aria-label="预算下限"
                      />
                      <input
                        className="input mono"
                        inputMode="numeric"
                        value={budgetMax}
                        onChange={(event) => setBudgetMax(event.target.value)}
                        placeholder="上限，例如 8192"
                        aria-label="预算上限"
                      />
                    </div>
                    <span className="field-hint">
                      {budgetIssue
                        ? budgetIssue
                        : budgetClearsStored(currentDraft)
                          ? '两个输入框都为空：保存后会移除原有的 min / max，其他预算字段保留。'
                          : storedBudget && !budgetEdited(currentDraft)
                            ? '当前是配置里的预算；清空任一项即可移除该边界。'
                            : '留空则不写入预算。'}
                    </span>
                    {budgetIssue && (touched || hasBudgetInput) ? (
                      <span className="field-error">{budgetIssue}</span>
                    ) : null}
                  </div>

                  {effortAndBudget ? (
                    <p className="inline-note">
                      <Icon name="warning" size={18} />
                      OpenCode 设置了档位时会忽略预算；已有的预算仍然保留，不会被自动清除。
                    </p>
                  ) : null}
                </>
              ) : null}

              {dialect === 'v2' && ability === 'unsupported' ? (
                <p className="inline-note">
                  <Icon name="warning" size={18} />
                  选择不支持时只写入 supported: false，已有的档位和预算会被移除。
                </p>
              ) : null}

              {unrepresentable ? (
                <div className="dialog-note">
                  <span>
                    这条配置的思考设置不是标准结构（{reasoningSourceLabel(originalReasoning)}）。
                    {ability === 'unset'
                      ? '保持「未设置」会原样保留；改用支持或不支持会覆盖它。'
                      : '基础选项会覆盖它；要原样保留请选「未设置」或改用「高级选项」。'}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="field">
                <span className="field-label">思考设置（JSON）</span>
                <textarea
                  className="textarea"
                  value={reasoningJson}
                  onChange={(event) => {
                    setReasoningJson(event.target.value);
                    setJsonDirty(true);
                  }}
                  placeholder={dialect === 'v1' ? 'true' : '{ "supported": true }'}
                  spellCheck={false}
                  rows={6}
                  aria-label="思考设置 JSON"
                />
                {reasoningJson.trim() ? (
                  reasoningResult?.ok ? (
                    <span className="field-hint">
                      格式正确。
                      {jsonDirty ? '收起高级时，这些改动会带回基础选项。' : ''}
                    </span>
                  ) : (
                    <span className="field-error">{reasoningResult?.issues[0]?.message}</span>
                  )
                ) : (
                  <span className="field-hint">留空则不写入思考设置。</span>
                )}
                <span className="field-hint">
                  {reasoningJson === rawReasoning ? '与当前配置相同。' : '和当前配置不同，保存时才会写入。'}
                </span>
              </div>
              <div className="field">
                <span className="field-label">模型变体（JSON）</span>
                <textarea
                  className="textarea"
                  value={variantsJson}
                  onChange={(event) => {
                    setVariantsJson(event.target.value);
                    setVariantsDirty(true);
                  }}
                  placeholder={
                    dialect === 'v1' ? '{ "high": { "reasoning": true } }' : '[ { "id": "fast" } ]'
                  }
                  spellCheck={false}
                  rows={6}
                  aria-label="模型变体 JSON"
                />
                {variantsJson.trim() ? (
                  variantsResult?.ok ? (
                    <span className="field-hint">
                      格式正确。
                      {variantsDirty && !advanced ? '收起高级后仍会写入这份变体。' : ''}
                    </span>
                  ) : (
                    <span className="field-error">{variantsResult?.issues[0]?.message}</span>
                  )
                ) : (
                  <span className="field-hint">留空则不写入变体。</span>
                )}
              </div>
            </>
          )}

          {!advanced && dialect === 'v2' ? (
            <p className="field-hint" aria-live="polite">
              当前表单：支持={formSummary.supported} · 可关闭思考={formSummary.toggle} · 档位=
              {formSummary.effort} · 预算={formSummary.budget}
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

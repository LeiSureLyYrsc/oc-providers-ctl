import type { ModelCandidate, ModelEntry, ProviderEntry } from '../ipc';
import type { ConcreteDialect } from './paths';
import { locateModel, modelLeafPath } from './paths';
import { describeReasoningDetail, parseReasoningMetadata, reasoningAdoptionValue } from './reasoning';

/**
 * The values a candidate is compared against. Callers pass either the stored
 * model or the unsaved form state, so the same comparison drives both panes.
 */
export interface AdoptionBaseline {
  name: string | null;
  context: number | null;
  input: number | null;
  output: number | null;
  reasoning: unknown;
}

export function baselineOf(model: ModelEntry): AdoptionBaseline {
  return {
    name: model.name,
    context: model.context,
    input: model.input,
    output: model.output,
    reasoning: model.reasoning,
  };
}

export interface AdoptionEdit {
  path: string[];
  value: unknown;
  label: string;
}

export interface AdoptionSelection {
  name: boolean;
  context: boolean;
  input: boolean;
  output: boolean;
  reasoning: boolean;
}

export type CandidateFieldKey = 'name' | 'context' | 'input' | 'output' | 'reasoning';

export type CandidateFieldStatus = 'available' | 'same' | 'unavailable';

export interface CandidateFieldRow {
  key: CandidateFieldKey;
  label: string;
  current: string;
  proposed: string;
  status: CandidateFieldStatus;
  /** Explicit "the model has no value here" marker; never inferred from text. */
  currentEmpty: boolean;
  proposedEmpty: boolean;
  /** Only fields the model is missing start selected; overwrites are opt-in. */
  checkedByDefault: boolean;
  note?: string;
}

function tokenText(value: number | null): string {
  return value === null ? '未填' : `${new Intl.NumberFormat('en-US').format(value)} token`;
}

/** Deep equality on JSON-ish values, so unknown keys cannot hide a difference. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left as Record<string, unknown>).sort();
    const rightKeys = Object.keys(right as Record<string, unknown>).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
    return leftKeys.every((key) =>
      deepEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

function textValue(value: string | null): string {
  return value && value.trim() ? value : '未填';
}

/**
 * Field-by-field comparison of a catalog candidate against the stored model.
 * The picker renders this and the same rows decide what "默认只填空" means.
 *
 * Reasoning is compared by the value that would actually be written for the
 * target dialect (V1: the boolean only), not by its display text — otherwise
 * unknown keys or V1 level differences would look identical.
 */
export function describeCandidateFields(
  dialect: ConcreteDialect,
  baseline: AdoptionBaseline,
  candidate: ModelCandidate,
): CandidateFieldRow[] {
  const rows: CandidateFieldRow[] = [];

  const name = candidate.name.trim();
  rows.push({
    key: 'name',
    label: '显示名称',
    current: textValue(baseline.name),
    currentEmpty: !baseline.name,
    proposed: name ? name : '目录未提供',
    proposedEmpty: !name,
    status: !name ? 'unavailable' : baseline.name === candidate.name ? 'same' : 'available',
    checkedByDefault: !baseline.name && Boolean(name),
  });

  const tokens: Array<[Exclude<CandidateFieldKey, 'name' | 'reasoning'>, number | null, number | null]> = [
    ['context', candidate.context, baseline.context],
    ['input', candidate.input, baseline.input],
    ['output', candidate.output, baseline.output],
  ];
  tokens.forEach(([key, next, current]) => {
    rows.push({
      key,
      label: key === 'context' ? '上下文' : key === 'input' ? '输入上限' : '输出上限',
      current: tokenText(current),
      currentEmpty: current === null,
      proposed: tokenText(next),
      proposedEmpty: next === null,
      status: next === null ? 'unavailable' : next === current ? 'same' : 'available',
      checkedByDefault: next !== null && current === null,
    });
  });

  const adopted = candidate.reasoning === null ? null : reasoningAdoptionValue(dialect, candidate.reasoning);
  // Compare the value that would actually be written. V2 keeps the whole
  // stored object so unknown keys cannot masquerade as "相同".
  const currentReasoning =
    dialect === 'v1'
      ? reasoningAdoptionValue('v1', baseline.reasoning)
      : typeof baseline.reasoning === 'boolean'
        ? { supported: baseline.reasoning }
        : (baseline.reasoning ?? null);
  const sameReasoning = adopted !== null && deepEqual(currentReasoning, adopted);
  const v1CurrentSupported = dialect === 'v1' ? currentReasoning : null;
  const currentText =
    baseline.reasoning === null || baseline.reasoning === undefined
      ? '未设置'
      : typeof baseline.reasoning === 'boolean'
        ? baseline.reasoning
          ? '支持'
          : '不支持'
        : dialect === 'v1'
          ? typeof v1CurrentSupported !== 'boolean'
            ? '结构未知'
            : v1CurrentSupported
              ? '支持（其它字段旧版不适用）'
              : '不支持（其它字段旧版不适用）'
          : describeCandidateReasoning(baseline.reasoning);
  const proposedText =
    adopted === null
      ? '目录未提供'
      : dialect === 'v1'
        ? adopted
          ? '支持（旧版只写布尔）'
          : '不支持（旧版只写布尔）'
        : describeCandidateReasoning(candidate.reasoning);

  rows.push({
    key: 'reasoning',
    label: '思考能力',
    current: currentText,
    currentEmpty: baseline.reasoning === null || baseline.reasoning === undefined,
    proposed: proposedText,
    proposedEmpty: adopted === null,
    status: adopted === null ? 'unavailable' : sameReasoning ? 'same' : 'available',
    checkedByDefault: adopted !== null && (baseline.reasoning === null || baseline.reasoning === undefined),
    note:
      dialect === 'v1'
        ? '旧版配置只写入是否支持；候选的档位和预算不会写进 V1。'
        : parseReasoningMetadata(candidate.reasoning)?.supported &&
            !parseReasoningMetadata(candidate.reasoning)?.effort
          ? '目录只声明支持，没有档位信息。'
          : undefined,
  });

  return rows;
}

function describeCandidateReasoning(value: unknown): string {
  const normalized = parseReasoningMetadata(value);
  if (!normalized) return '结构未知';
  const parts = [normalized.supported ? '支持' : '不支持'];
  if (normalized.toggle !== undefined) parts.push(normalized.toggle ? '可关闭' : '不可关闭');
  if (normalized.effort && normalized.effort.length > 0) parts.push(`档位 ${normalized.effort.join('/')}`);
  // Reuse the shared range formatter so a missing bound is never shown as 0.
  if (normalized.budget && (normalized.budget.min !== undefined || normalized.budget.max !== undefined)) {
    parts.push(`预算 ${describeReasoningDetail(value).budget}`);
  }
  return parts.join(' · ');
}

export function defaultAdoptionSelection(rows: CandidateFieldRow[]): AdoptionSelection {
  return {
    name: rows.some((row) => row.key === 'name' && row.checkedByDefault),
    context: rows.some((row) => row.key === 'context' && row.checkedByDefault),
    input: rows.some((row) => row.key === 'input' && row.checkedByDefault),
    output: rows.some((row) => row.key === 'output' && row.checkedByDefault),
    reasoning: rows.some((row) => row.key === 'reasoning' && row.checkedByDefault),
  };
}

/**
 * Build the leaf-only edits used when a user adopts a catalog candidate.
 * Only the selected fields are emitted; values equal to the stored ones are
 * skipped, unknown candidate values are never written, and request ids
 * (`requestId` / V2 `modelID`) plus variants are never touched.
 */
export function candidateAdoptionEdits(
  dialect: ConcreteDialect,
  provider: ProviderEntry,
  model: ModelEntry,
  candidate: ModelCandidate,
  selection: AdoptionSelection,
  baseline: AdoptionBaseline = baselineOf(model),
): AdoptionEdit[] {
  const locator = locateModel(provider, model);
  const edits: AdoptionEdit[] = [];

  const nextName = candidate.name.trim();
  // An explicit checkbox may overwrite a different existing name; identical values are skipped.
  if (selection.name && nextName && nextName !== baseline.name) {
    edits.push({
      path: modelLeafPath(dialect, locator, 'name'),
      value: nextName,
      label: '显示名（建议）',
    });
  }

  const tokens: Array<['context' | 'input' | 'output', number | null, number | null, string]> = [
    ['context', candidate.context, baseline.context, '上下文窗口（建议）'],
    ['input', candidate.input, baseline.input, '输入上限（建议）'],
    ['output', candidate.output, baseline.output, '输出上限（建议）'],
  ];
  tokens.forEach(([leaf, next, current, label]) => {
    if (!selection[leaf] || next === null || next === current) return;
    edits.push({ path: modelLeafPath(dialect, locator, leaf), value: next, label });
  });

  if (selection.reasoning && candidate.reasoning !== null) {
    const adopted = reasoningAdoptionValue(dialect, candidate.reasoning);
    const current =
      dialect === 'v1'
        ? reasoningAdoptionValue('v1', baseline.reasoning)
        : typeof baseline.reasoning === 'boolean'
          ? { supported: baseline.reasoning }
          : (baseline.reasoning ?? null);
    if (adopted !== null && !deepEqual(current, adopted)) {
      edits.push({
        path: modelLeafPath(dialect, locator, 'reasoning'),
        value: adopted,
        label: dialect === 'v1' ? '推理开关（建议）' : '思考能力（建议）',
      });
    }
  }

  return edits;
}

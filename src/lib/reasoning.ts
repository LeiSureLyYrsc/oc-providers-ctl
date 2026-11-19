import type { ConcreteDialect } from './paths';

/** Catalog normalizes reasoning to this shape; older bool values remain supported. */
export interface NormalizedReasoning {
  supported: boolean;
  toggle?: boolean;
  effort?: string[];
  budget?: { min?: number; max?: number };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseReasoningMetadata(value: unknown): NormalizedReasoning | null {
  if (typeof value === 'boolean') return { supported: value };
  if (!isPlainObject(value) || typeof value.supported !== 'boolean') return null;
  const result: NormalizedReasoning = { supported: value.supported };
  if (typeof value.toggle === 'boolean') result.toggle = value.toggle;
  if (Array.isArray(value.effort) && value.effort.every((entry) => typeof entry === 'string')) {
    result.effort = value.effort as string[];
  }
  if (isPlainObject(value.budget)) {
    const budget: { min?: number; max?: number } = {};
    if (typeof value.budget.min === 'number') budget.min = value.budget.min;
    if (typeof value.budget.max === 'number') budget.max = value.budget.max;
    if (Object.keys(budget).length > 0) result.budget = budget;
  }
  return result;
}

export function reasoningSupported(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const normalized = parseReasoningMetadata(value);
  return normalized ? normalized.supported : null;
}

export function describeReasoning(value: unknown): string {
  if (value === null || value === undefined) return '未设置';
  if (typeof value === 'boolean') return value ? '支持（布尔）' : '不支持（布尔）';
  const normalized = parseReasoningMetadata(value);
  if (!normalized) return '结构未知';
  const parts = [normalized.supported ? '支持' : '不支持'];
  if (normalized.toggle !== undefined) {
    parts.push(normalized.toggle ? '允许关闭思考' : '不允许关闭思考');
  }
  if (normalized.effort && normalized.effort.length > 0) {
    parts.push(`档位 ${normalized.effort.join('/')}`);
  }
  if (normalized.budget && (normalized.budget.min !== undefined || normalized.budget.max !== undefined)) {
    parts.push(`预算 ${normalized.budget.min ?? '?'}–${normalized.budget.max ?? '?'}`);
  }
  return parts.join(' · ');
}

export interface ReasoningDetail {
  /** `支持` / `不支持` / `未设置` / `结构未知` */
  supported: string;
  toggle: string;
  effort: string;
  budget: string;
}

function tokenRange(budget: { min?: number; max?: number }): string {
  const format = (value: number) => new Intl.NumberFormat('en-US').format(value);
  if (budget.min !== undefined && budget.max !== undefined) {
    return `${format(budget.min)} – ${format(budget.max)} token`;
  }
  if (budget.max !== undefined) return `最多 ${format(budget.max)} token`;
  if (budget.min !== undefined) return `至少 ${format(budget.min)} token`;
  return '未设置';
}

/**
 * Split display used by the read-only panes so capability, switch, levels and
 * budget never collapse into a single "reasoning level" label.
 */
export function describeReasoningDetail(value: unknown): ReasoningDetail {
  if (value === null || value === undefined) {
    return { supported: '未设置', toggle: '未设置', effort: '未设置', budget: '未设置' };
  }
  const normalized = parseReasoningMetadata(value);
  if (!normalized) {
    return { supported: '结构未知', toggle: '未设置', effort: '未设置', budget: '未设置' };
  }
  return {
    supported: normalized.supported ? '支持' : '不支持',
    toggle:
      normalized.toggle === undefined
        ? '未设置'
        : normalized.toggle
          ? '允许关闭思考'
          : '不允许关闭思考',
    effort:
      normalized.effort && normalized.effort.length > 0
        ? normalized.effort.join(' / ')
        : '未设置',
    budget: normalized.budget ? tokenRange(normalized.budget) : '未设置',
  };
}

/**
 * Candidate metadata adoption must respect the target model dialect.
 * V1 only receives the supported boolean; V2 may receive the normalized object.
 * Variants are never created from catalog metadata.
 */
export function reasoningAdoptionValue(
  dialect: ConcreteDialect,
  value: unknown,
): boolean | NormalizedReasoning | null {
  const normalized = parseReasoningMetadata(value);
  if (!normalized) return null;
  if (dialect === 'v1') return normalized.supported;
  return normalized;
}

export const REASONING_OBJECT_KEYS = new Set(['supported', 'toggle', 'effort', 'budget']);
export const REASONING_BUDGET_KEYS = new Set(['min', 'max']);

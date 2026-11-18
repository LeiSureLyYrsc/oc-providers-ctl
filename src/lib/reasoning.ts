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
  if (normalized.toggle !== undefined) parts.push(normalized.toggle ? '可切换' : '不可切换');
  if (normalized.effort && normalized.effort.length > 0) {
    parts.push(`档位 ${normalized.effort.join('/')}`);
  }
  if (normalized.budget && (normalized.budget.min !== undefined || normalized.budget.max !== undefined)) {
    parts.push(`预算 ${normalized.budget.min ?? '?'}–${normalized.budget.max ?? '?'}`);
  }
  return parts.join(' · ');
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

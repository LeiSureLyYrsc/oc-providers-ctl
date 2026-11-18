import type { ConcreteDialect } from './paths';
import { REASONING_BUDGET_KEYS, REASONING_OBJECT_KEYS } from './reasoning';

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface AdvancedParseResult {
  ok: boolean;
  value?: unknown;
  issues: ValidationIssue[];
  summary: string;
}

const KNOWN_VARIANT_KEYS = new Set([
  'id',
  'name',
  'description',
  'reasoning',
  'limit',
  'options',
  'settings',
  'capabilities',
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'tools',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : '无法解析';
  const position = /position\s+(\d+)/i.exec(message);
  if (position) {
    return `JSON 无法解析（字符位置 ${position[1]}）。请检查引号、逗号与括号。`;
  }
  return 'JSON 无法解析。请检查引号、逗号与括号。';
}

function collectUnknownKeys(
  value: unknown,
  prefix: string,
  depth: number,
  issues: ValidationIssue[],
): void {
  if (depth > 2 || !isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (!KNOWN_VARIANT_KEYS.has(key)) {
      issues.push({
        level: 'warning',
        message: `未识别字段 ${prefix ? `${prefix}.` : ''}${key}（将原样写入，请确认来源）。`,
      });
    }
    if (isPlainObject(entry)) collectUnknownKeys(entry, `${prefix}${key}.`, depth + 1, issues);
  }
}

export function validateReasoningValue(
  dialect: ConcreteDialect,
  value: unknown,
): ValidationIssue[] {
  if (dialect === 'v1') {
    return typeof value === 'boolean'
      ? []
      : [{ level: 'error', message: 'V1 的 reasoning 必须是布尔值。' }];
  }
  if (typeof value === 'boolean') {
    return [
      {
        level: 'error',
        message:
          'V2 的 capabilities.reasoning 必须是归一化对象 { supported, toggle?, effort?, budget? }，不能是裸布尔值。',
      },
    ];
  }
  if (!isPlainObject(value)) {
    return [
      {
        level: 'error',
        message: 'V2 的 capabilities.reasoning 应为归一化对象 { supported, toggle?, effort?, budget? }。',
      },
    ];
  }
  const issues: ValidationIssue[] = [];
  if (typeof value.supported !== 'boolean') {
    issues.push({ level: 'error', message: '归一化对象必须包含布尔字段 supported。' });
  }
  if (value.toggle !== undefined && typeof value.toggle !== 'boolean') {
    issues.push({ level: 'error', message: 'toggle 必须是布尔值。' });
  }
  if (
    value.effort !== undefined &&
    (!Array.isArray(value.effort) || value.effort.some((entry) => typeof entry !== 'string'))
  ) {
    issues.push({ level: 'error', message: 'effort 必须是字符串数组。' });
  }
  if (value.budget !== undefined) {
    if (!isPlainObject(value.budget)) {
      issues.push({ level: 'error', message: 'budget 必须是对象。' });
    } else {
      const { min, max } = value.budget;
      if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) {
        issues.push({ level: 'error', message: 'budget.min 必须是数字。' });
      }
      if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) {
        issues.push({ level: 'error', message: 'budget.max 必须是数字。' });
      }
      if (typeof min === 'number' && typeof max === 'number' && min > max) {
        issues.push({ level: 'warning', message: 'budget.min 大于 budget.max，请确认来源。' });
      }
      Object.keys(value.budget).forEach((key) => {
        if (!REASONING_BUDGET_KEYS.has(key)) {
          issues.push({ level: 'warning', message: `未识别字段 budget.${key}（将原样写入）。` });
        }
      });
    }
  }
  Object.keys(value).forEach((key) => {
    if (!REASONING_OBJECT_KEYS.has(key)) {
      issues.push({ level: 'warning', message: `未识别字段 ${key}（将原样写入，请确认来源）。` });
    }
  });
  return issues;
}

export function validateVariantsValue(
  dialect: ConcreteDialect,
  value: unknown,
): ValidationIssue[] {
  if (value === null) {
    return [{ level: 'warning', message: '值将是 null；如需移除该字段，请使用「清除」草稿。' }];
  }
  const issues: ValidationIssue[] = [];
  if (dialect === 'v1') {
    if (!isPlainObject(value)) {
      return [{ level: 'error', message: 'V1 的 variants 必须是对象：变体名 → 变体配置。' }];
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!isPlainObject(entry)) {
        issues.push({
          level: 'warning',
          message: `变体 ${key} 的值不是对象；仍会原样写入，请确认结构。`,
        });
        continue;
      }
      collectUnknownKeys(entry, key, 0, issues);
    }
  } else {
    if (!Array.isArray(value)) {
      return [{ level: 'error', message: 'V2 的 variants 必须是数组。' }];
    }
    value.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        issues.push({
          level: 'warning',
          message: `第 ${index + 1} 项不是对象；仍会原样写入，请确认结构。`,
        });
        return;
      }
      if (typeof entry.id !== 'string' || !entry.id.trim()) {
        issues.push({
          level: 'warning',
          message: `第 ${index + 1} 项缺少字符串 id；请确认 OpenCode 是否接受。`,
        });
      }
      collectUnknownKeys(entry, `[${index}]`, 0, issues);
    });
  }
  return issues;
}

export function parseAdvancedJson(
  field: 'reasoning' | 'variants',
  dialect: ConcreteDialect,
  text: string,
): AdvancedParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      ok: false,
      issues: [{ level: 'error', message: '内容为空。如要移除字段，请使用「清除」操作。' }],
      summary: '内容为空',
    };
  }
  if (trimmed.length > 24000) {
    return {
      ok: false,
      issues: [{ level: 'error', message: 'JSON 内容过长（超过 24,000 字符）。' }],
      summary: '内容过长',
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      issues: [{ level: 'error', message: parseErrorDetail(error) }],
      summary: 'JSON 语法错误',
    };
  }
  const issues = field === 'reasoning' ? validateReasoningValue(dialect, value) : validateVariantsValue(dialect, value);
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.length - errors;
  const summary =
    errors > 0
      ? `${errors} 个结构错误`
      : warnings > 0
        ? `结构可写入 · ${warnings} 条提示`
        : '结构检查通过';
  return { ok: errors === 0, value, issues, summary };
}

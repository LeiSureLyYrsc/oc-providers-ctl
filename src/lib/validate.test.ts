import { describe, expect, it } from 'vitest';
import { parseAdvancedJson, validateReasoningValue, validateVariantsValue } from './validate';

describe('advanced reasoning validation', () => {
  it('requires a normalized object for V2 and rejects bare booleans', () => {
    expect(validateReasoningValue('v2', true)[0]).toMatchObject({
      level: 'error',
      message: expect.stringContaining('归一化对象'),
    });
    expect(validateReasoningValue('v2', { supported: true })).toHaveLength(0);
  });

  it('checks effort and budget shapes and warns on unknown keys', () => {
    const issues = validateReasoningValue('v2', {
      supported: true,
      toggle: 'yes',
      effort: ['low', 3],
      budget: { min: 5, max: 2, currency: 'USD' },
      extra: true,
    });
    expect(issues.some((issue) => issue.level === 'error' && issue.message.includes('toggle'))).toBe(
      true,
    );
    expect(issues.some((issue) => issue.message.includes('effort'))).toBe(true);
    expect(issues.some((issue) => issue.level === 'warning' && issue.message.includes('min'))).toBe(
      true,
    );
    expect(issues.some((issue) => issue.level === 'warning' && issue.message.includes('extra'))).toBe(
      true,
    );
    expect(
      issues.some((issue) => issue.level === 'warning' && issue.message.includes('budget.currency')),
    ).toBe(true);
  });

  it('keeps V1 reasoning boolean-only', () => {
    expect(validateReasoningValue('v1', true)).toHaveLength(0);
    expect(validateReasoningValue('v1', { supported: true })[0]?.level).toBe('error');
  });
});

describe('advanced variants validation', () => {
  it('enforces V1 object maps and V2 arrays', () => {
    expect(validateVariantsValue('v1', [{ id: 'fast' }])[0]?.level).toBe('error');
    expect(validateVariantsValue('v2', { fast: { id: 'fast' } })[0]?.level).toBe('error');
    expect(validateVariantsValue('v1', { fast: { reasoning: true } })).toHaveLength(0);
    expect(validateVariantsValue('v2', [{ id: 'fast' }])).toHaveLength(0);
  });

  it('warns about non-object entries and unknown variant keys', () => {
    const issues = validateVariantsValue('v2', [
      { id: 'fast', mystery: true },
      'not-an-object',
      { name: 'missing id' },
    ]);
    expect(issues.some((issue) => issue.message.includes('mystery'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('不是对象'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('缺少字符串 id'))).toBe(true);
  });
});

describe('JSON parsing', () => {
  it('reports syntax errors without leaking content', () => {
    const result = parseAdvancedJson('variants', 'v2', '[{"id":');
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('JSON 语法错误');
    expect(result.issues[0].level).toBe('error');
  });

  it('summarizes warnings without blocking staging', () => {
    const result = parseAdvancedJson(
      'variants',
      'v2',
      JSON.stringify([{ id: 'fast', mystery: 1 }]),
    );
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([{ id: 'fast', mystery: 1 }]);
    expect(result.summary).toContain('提示');
    expect(result.issues[0].level).toBe('warning');
  });

  it('rejects empty input and invalid V2 reasoning objects', () => {
    expect(parseAdvancedJson('reasoning', 'v2', '  ').ok).toBe(false);
    expect(parseAdvancedJson('reasoning', 'v2', 'true').ok).toBe(false);
    expect(parseAdvancedJson('reasoning', 'v2', '{"supported":true}').ok).toBe(true);
  });
});

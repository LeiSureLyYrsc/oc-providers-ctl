import { describe, expect, it } from 'vitest';
import { maskSecretsInDiff, variantSummary } from './format';
import {
  describeReasoning,
  describeReasoningDetail,
  reasoningAdoptionValue,
  reasoningSupported,
} from './reasoning';

describe('reasoning display', () => {
  it('shows effort and budget from normalized V2 metadata', () => {
    expect(
      describeReasoning({
        supported: true,
        toggle: true,
        effort: ['low', 'high'],
        budget: { min: 0, max: 16384 },
      }),
    ).toBe('支持 · 允许关闭思考 · 档位 low/high · 预算 0–16384');
  });

  it('splits capability, toggle, levels and budget for the read-only pane', () => {
    expect(
      describeReasoningDetail({
        supported: true,
        toggle: true,
        effort: ['low', 'high'],
        budget: { min: 0, max: 16384 },
      }),
    ).toEqual({
      supported: '支持',
      toggle: '允许关闭思考',
      effort: 'low / high',
      budget: '0 – 16,384 token',
    });
  });

  it('does not turn a declared capability into a level', () => {
    expect(describeReasoningDetail({ supported: true })).toEqual({
      supported: '支持',
      toggle: '未设置',
      effort: '未设置',
      budget: '未设置',
    });
    expect(describeReasoningDetail(true).effort).toBe('未设置');
    expect(describeReasoningDetail(null).supported).toBe('未设置');
    expect(describeReasoningDetail({ toggle: true }).supported).toBe('结构未知');
  });

  it('keeps bool fallback for display only', () => {
    expect(describeReasoning(true)).toBe('支持（布尔）');
    expect(reasoningSupported(false)).toBe(false);
    expect(reasoningSupported({ supported: true })).toBe(true);
  });

  it('maps V1 adoption to a boolean and V2 to a normalized object', () => {
    expect(reasoningAdoptionValue('v1', { supported: true, effort: ['high'] })).toBe(true);
    expect(reasoningAdoptionValue('v2', true)).toEqual({ supported: true });
    expect(reasoningAdoptionValue('v2', { supported: false, mystery: 1 })).toEqual({
      supported: false,
    });
  });
});

describe('diff masking', () => {
  it('masks credential-bearing values and bearer tokens', () => {
    const diff = [
      '+   "apiKey": "sk-secretvalue123456"',
      '- Authorization: Bearer abcdef123456',
      '+   "name": "GLM-4.6"',
    ].join('\n');
    const masked = maskSecretsInDiff(diff);
    expect(masked).not.toContain('sk-secretvalue123456');
    expect(masked).not.toContain('Bearer abcdef123456');
    expect(masked).toContain('[已隐藏]');
    expect(masked).toContain('GLM-4.6');
  });
});

describe('variant summary', () => {
  it('distinguishes V1 object maps from V2 arrays', () => {
    expect(variantSummary({ a: {}, b: {} }, 'v1')).toBe('2 个变体');
    expect(variantSummary([{}, {}], 'v2')).toBe('2 项');
    expect(variantSummary({}, 'v1')).toBe('空对象');
    expect(variantSummary([], 'v2')).toBe('空数组');
  });
});

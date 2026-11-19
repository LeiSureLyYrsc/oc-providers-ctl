import { describe, expect, it } from 'vitest';
import { parseTokenInput, tokenInputValue } from './tokens';
import {
  buildV2Reasoning,
  budgetClearsStored,
  budgetEdited,
  draftFromReasoning,
  draftIssue,
  effortClearsStored,
  emptyReasoningDraft,
  parseEffortText,
} from './reasoningDraft';

describe('token input', () => {
  it('accepts integers with human group separators only', () => {
    expect(parseTokenInput('262144')).toBe(262144);
    expect(parseTokenInput(' 262,144 ')).toBe(262144);
    expect(parseTokenInput('262 144')).toBe(262144);
    expect(parseTokenInput('0')).toBe(0);
  });

  it('rejects shorthand, negatives and fractions instead of rounding', () => {
    expect(parseTokenInput('262k')).toBe('invalid');
    expect(parseTokenInput('-1')).toBe('invalid');
    expect(parseTokenInput('1.5')).toBe('invalid');
    expect(parseTokenInput('1e6')).toBe('invalid');
  });

  it('treats blank as "do not write"', () => {
    expect(parseTokenInput('   ')).toBeNull();
    expect(tokenInputValue(null)).toBe('');
    expect(tokenInputValue(8192)).toBe('8192');
  });
});

describe('reasoning draft: explicit editing', () => {
  it('keeps unknown top-level and budget keys when nothing is edited', () => {
    const draft = draftFromReasoning({
      supported: true,
      toggle: false,
      effort: ['low', 'high'],
      budget: { min: 0, max: 8192, unit: 'tokens' },
      custom: { note: 'keep me' },
    })!;
    expect(buildV2Reasoning(draft)).toEqual({
      supported: true,
      toggle: false,
      effort: ['low', 'high'],
      budget: { unit: 'tokens', min: 0, max: 8192 },
      custom: { note: 'keep me' },
    });
  });

  it('deletes toggle when it is left unset', () => {
    const draft = draftFromReasoning({ supported: true, toggle: true, effort: ['low'] })!;
    expect(buildV2Reasoning({ ...draft, toggle: 'unset' })).toEqual({
      supported: true,
      effort: ['low'],
    });
  });

  it('removes effort when the field is cleared', () => {
    const draft = draftFromReasoning({ supported: true, effort: ['low', 'high'] })!;
    const cleared = buildV2Reasoning({ ...draft, effortText: '' });
    expect(cleared).toEqual({ supported: true });
    expect(cleared).not.toHaveProperty('effort');
    expect(effortClearsStored({ ...draft, effortText: '' })).toBe(true);
  });

  it('removes cleared bounds but keeps other budget keys', () => {
    const draft = draftFromReasoning({
      supported: true,
      budget: { min: 0, max: 8192, unit: 'tokens' },
    })!;
    const cleared = { ...draft, budgetMin: '', budgetMax: '' };
    expect(budgetClearsStored(cleared)).toBe(true);
    expect(buildV2Reasoning(cleared)).toEqual({
      supported: true,
      budget: { unit: 'tokens' },
    });
  });

  it('drops an emptied budget entirely when it had no other keys', () => {
    const draft = draftFromReasoning({ supported: true, budget: { max: 4096 } })!;
    const built = buildV2Reasoning({ ...draft, budgetMin: '', budgetMax: '' });
    expect(built).toEqual({ supported: true });
    expect(built).not.toHaveProperty('budget');
  });

  it('preserves an untouched empty effort array and empty budget object', () => {
    expect(buildV2Reasoning(draftFromReasoning({ supported: true, effort: [] })!)).toEqual({
      supported: true,
      effort: [],
    });
    expect(
      buildV2Reasoning(draftFromReasoning({ supported: true, budget: {} })!),
    ).toEqual({ supported: true, budget: {} });
    expect(
      buildV2Reasoning(draftFromReasoning({ supported: true, budget: { unit: 't' } })!),
    ).toEqual({ supported: true, budget: { unit: 't' } });
  });

  it('never adds effort when only supported is declared', () => {
    const built = buildV2Reasoning(draftFromReasoning({ supported: true })!);
    expect(built).toEqual({ supported: true });
    expect(built).not.toHaveProperty('effort');
    expect(built).not.toHaveProperty('budget');
  });

  it('writes only the flag when the capability is turned off', () => {
    const draft = {
      ...draftFromReasoning({ supported: true, effort: ['low'] })!,
      supported: false,
    };
    expect(buildV2Reasoning(draft)).toEqual({ supported: false });
  });

  it('returns null for a value the form cannot represent', () => {
    expect(draftFromReasoning({ toggle: true })).toBeNull();
    expect(draftFromReasoning([1, 2])).toBeNull();
    expect(draftFromReasoning(undefined)).toBeNull();
    expect(draftFromReasoning({ supported: true, toggle: 'yes' })).toBeNull();
    expect(draftFromReasoning({ supported: true, effort: [1] })).toBeNull();
    expect(draftFromReasoning({ supported: true, budget: { max: '8k' } })).toBeNull();
  });

  it('rejects non-integer budget and inverted ranges', () => {
    expect(draftIssue({ ...emptyReasoningDraft(), budgetMin: '10k' })).toContain('整数');
    expect(draftIssue({ ...emptyReasoningDraft(), budgetMin: '900', budgetMax: '100' })).toContain(
      '下限不能大于上限',
    );
    expect(draftIssue({ ...emptyReasoningDraft(), budgetMin: '0', budgetMax: '8192' })).toBeNull();
  });

  it('detects whether budget was actually edited, including clearing', () => {
    const draft = draftFromReasoning({ supported: true, budget: { min: 0, max: 8192 } })!;
    expect(budgetEdited(draft)).toBe(false);
    expect(budgetEdited({ ...draft, budgetMax: '16384' })).toBe(true);
    expect(budgetEdited({ ...draft, budgetMin: '', budgetMax: '' })).toBe(true);
  });

  it('splits effort text, de-duplicates, and stays empty when blank', () => {
    expect(parseEffortText('low, high，medium  low')).toEqual(['low', 'high', 'medium']);
    expect(parseEffortText('   ')).toEqual([]);
  });
});

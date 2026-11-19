import { parseTokenInput } from './tokens';

export type ToggleChoice = 'unset' | 'allowed' | 'denied';

/**
 * Editable shape of a V2 `capabilities.reasoning` object.
 *
 * Editing is explicit: `toggle: 'unset'`, an empty effort field or cleared
 * budget bounds delete those keys. `stored` is a read-only snapshot used for
 * "this will be removed" hints — it is never written back implicitly, so a
 * user can always delete a field they can see.
 *
 * Unknown top-level and budget keys live in `extra` / `budgetExtra` and are
 * always written back, and an untouched empty `effort: []` / `budget: {}` is
 * preserved instead of being silently dropped.
 */
export interface ReasoningDraft {
  supported: boolean;
  toggle: ToggleChoice;
  effortText: string;
  budgetMin: string;
  budgetMax: string;
  extra: Record<string, unknown>;
  budgetExtra: Record<string, unknown>;
  stored: {
    toggle?: boolean;
    effort: string[];
    hasEffort: boolean;
    budget?: { min?: number; max?: number };
    hasBudget: boolean;
  };
}

const KNOWN_TOP_LEVEL = new Set(['supported', 'toggle', 'effort', 'budget']);
const KNOWN_BUDGET_KEYS = new Set(['min', 'max']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function emptyReasoningDraft(): ReasoningDraft {
  return {
    supported: true,
    toggle: 'unset',
    effortText: '',
    budgetMin: '',
    budgetMax: '',
    extra: {},
    budgetExtra: {},
    stored: { effort: [], hasEffort: false, hasBudget: false },
  };
}

/** Split the effort editor text without inventing values. */
export function parseEffortText(text: string): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  text
    .split(/[,，\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      if (seen.has(entry)) return;
      seen.add(entry);
      list.push(entry);
    });
  return list;
}

/**
 * Returns null when the stored value cannot be represented by the form
 * (missing `supported`, non-boolean toggle, non-string effort, non-numeric
 * budget bounds). Callers must keep the raw JSON instead of silently
 * replacing it.
 */
export function draftFromReasoning(value: unknown): ReasoningDraft | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') {
    return { ...emptyReasoningDraft(), supported: value };
  }
  if (!isPlainObject(value) || typeof value.supported !== 'boolean') return null;
  if (value.toggle !== undefined && typeof value.toggle !== 'boolean') return null;
  if (
    value.effort !== undefined &&
    (!Array.isArray(value.effort) || value.effort.some((entry) => typeof entry !== 'string'))
  ) {
    return null;
  }
  if (value.budget !== undefined && !isPlainObject(value.budget)) return null;
  if (isPlainObject(value.budget)) {
    for (const key of ['min', 'max'] as const) {
      const bound = value.budget[key];
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) return null;
    }
  }

  const extra: Record<string, unknown> = {};
  Object.keys(value).forEach((key) => {
    if (!KNOWN_TOP_LEVEL.has(key)) extra[key] = value[key];
  });

  const effort = Array.isArray(value.effort) ? (value.effort as string[]) : [];

  let budgetMin = '';
  let budgetMax = '';
  const budgetExtra: Record<string, unknown> = {};
  const storedBudget: { min?: number; max?: number } = {};
  if (isPlainObject(value.budget)) {
    if (typeof value.budget.min === 'number') {
      budgetMin = String(value.budget.min);
      storedBudget.min = value.budget.min;
    }
    if (typeof value.budget.max === 'number') {
      budgetMax = String(value.budget.max);
      storedBudget.max = value.budget.max;
    }
    Object.keys(value.budget).forEach((key) => {
      if (!KNOWN_BUDGET_KEYS.has(key)) {
        budgetExtra[key] = (value.budget as Record<string, unknown>)[key];
      }
    });
  }

  return {
    supported: value.supported,
    toggle:
      typeof value.toggle === 'boolean' ? (value.toggle ? 'allowed' : 'denied') : 'unset',
    effortText: effort.join(', '),
    budgetMin,
    budgetMax,
    extra,
    budgetExtra,
    stored: {
      toggle: typeof value.toggle === 'boolean' ? value.toggle : undefined,
      effort,
      hasEffort: Array.isArray(value.effort),
      budget: Object.keys(storedBudget).length > 0 ? storedBudget : undefined,
      hasBudget: isPlainObject(value.budget),
    },
  };
}

export interface ParsedBudget {
  min?: number;
  max?: number;
}

/** Null when both fields are empty (nothing typed). */
export function parseBudget(draft: ReasoningDraft): ParsedBudget | null {
  const min = parseTokenInput(draft.budgetMin);
  const max = parseTokenInput(draft.budgetMax);
  const budget: ParsedBudget = {};
  if (typeof min === 'number') budget.min = min;
  if (typeof max === 'number') budget.max = max;
  return Object.keys(budget).length > 0 ? budget : null;
}

export function draftIssue(draft: ReasoningDraft): string | null {
  const min = parseTokenInput(draft.budgetMin);
  const max = parseTokenInput(draft.budgetMax);
  if (min === 'invalid' || max === 'invalid') {
    return '预算需要是非负整数 token，例如 8192。';
  }
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    return '预算下限不能大于上限。';
  }
  return null;
}

/** True when the typed bounds differ from the stored ones (including clearing). */
export function budgetEdited(draft: ReasoningDraft): boolean {
  const min = parseTokenInput(draft.budgetMin);
  const max = parseTokenInput(draft.budgetMax);
  const stored = draft.stored.budget;
  const nextMin = typeof min === 'number' ? min : undefined;
  const nextMax = typeof max === 'number' ? max : undefined;
  return nextMin !== stored?.min || nextMax !== stored?.max;
}

/** True when the user cleared bounds that the config currently has. */
export function budgetClearsStored(draft: ReasoningDraft): boolean {
  return (
    draft.stored.budget !== undefined &&
    parseTokenInput(draft.budgetMin) === null &&
    parseTokenInput(draft.budgetMax) === null
  );
}

/** True when the effort field no longer carries the stored levels. */
export function effortClearsStored(draft: ReasoningDraft): boolean {
  if (!draft.stored.hasEffort || draft.stored.effort.length === 0) return false;
  return parseEffortText(draft.effortText).length === 0;
}

/**
 * Build a V2 reasoning object from the form using explicit editing rules:
 *
 * - `supported: false` keeps only the flag; levels and budget are meaningless
 *   without the capability, matching V2 validation.
 * - `toggle: 'unset'` deletes `toggle`.
 * - An empty effort field deletes `effort`, except for an untouched `[]`.
 * - Clearing bounds deletes `min`/`max`; other budget keys survive. An
 *   untouched `{}` or unknown-only budget is written back unchanged.
 * - Unknown top-level keys always survive.
 */
export function buildV2Reasoning(draft: ReasoningDraft): Record<string, unknown> {
  if (!draft.supported) return { supported: false };

  const value: Record<string, unknown> = { ...draft.extra, supported: true };

  if (draft.toggle !== 'unset') value.toggle = draft.toggle === 'allowed';

  const effort = parseEffortText(draft.effortText);
  if (effort.length > 0) {
    value.effort = effort;
  } else if (draft.stored.hasEffort && draft.stored.effort.length === 0) {
    value.effort = [];
  }

  const min = parseTokenInput(draft.budgetMin);
  const max = parseTokenInput(draft.budgetMax);
  const budget: Record<string, unknown> = { ...draft.budgetExtra };
  if (typeof min === 'number') budget.min = min;
  if (typeof max === 'number') budget.max = max;

  if (Object.keys(budget).length > 0) {
    value.budget = budget;
  } else if (draft.stored.hasBudget && draft.stored.budget === undefined) {
    // Untouched empty budget object: keep it rather than deleting invisible data.
    value.budget = {};
  }

  return value;
}

import { describe, expect, it } from 'vitest';
import {
  baselineOf,
  candidateAdoptionEdits,
  defaultAdoptionSelection,
  describeCandidateFields,
} from './adoption';
import { locateModel, modelLeafPath } from './paths';
import { V1_NATIVE_SOURCE, V2_NATIVE_SOURCE, makeCandidate } from '../test/fixtures';

const v2Provider = V2_NATIVE_SOURCE.providers[0];
const v2Model = v2Provider.models[0];
const v1Provider = V1_NATIVE_SOURCE.providers[0];
const v1Model = v1Provider.models[0];

function selectAll() {
  return { name: true, context: true, input: true, output: true, reasoning: true };
}

describe('catalog adoption', () => {
  it('emits map-keyed V2 paths and normalized reasoning objects', () => {
    const edits = candidateAdoptionEdits('v2', v2Provider, v2Model, makeCandidate(), selectAll());
    const paths = edits.map((edit) => edit.path.join(' / '));
    expect(paths).toContain(
      ['providers', 'gateway', 'models', 'upstream/coder', 'limit', 'context'].join(' / '),
    );
    expect(paths).toContain(
      ['providers', 'gateway', 'models', 'upstream/coder', 'capabilities', 'reasoning'].join(
        ' / ',
      ),
    );
    const reasoning = edits.find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.value).toEqual({
      supported: true,
      toggle: true,
      effort: ['low', 'high'],
      budget: { min: 0, max: 16384 },
    });
    expect(paths).not.toContain(
      ['providers', 'gateway', 'models', 'upstream/coder', 'modelID'].join(' / '),
    );
    expect(paths.some((path) => path.includes('variants'))).toBe(false);
    expect(paths.some((path) => path.includes('requestId'))).toBe(false);
  });

  it('maps V2 normalized reasoning to the V1 supported boolean only', () => {
    const edits = candidateAdoptionEdits(
      'v1',
      v1Provider,
      { ...v1Model, reasoning: null },
      makeCandidate({
        providerId: 'zhipu',
        id: 'glm-4.6',
        name: 'GLM-4.6',
        context: 262144,
        input: null,
        output: 131072,
        reasoning: { supported: true, toggle: true, effort: ['low'], budget: { max: 4096 } },
      }),
      selectAll(),
    );
    const reasoning = edits.find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.path).toEqual(['provider', 'zhipu', 'models', 'glm-4.6', 'reasoning']);
    expect(reasoning?.value).toBe(true);
    expect(JSON.stringify(edits)).not.toContain('effort');
    expect(JSON.stringify(edits)).not.toContain('budget');
  });

  it('never writes a request id or variants, and keeps an unconfirmed name', () => {
    const target = { ...v2Model, name: 'Already named' };
    const edits = candidateAdoptionEdits('v2', v2Provider, target, makeCandidate(), {
      name: false,
      context: true,
      input: true,
      output: true,
      reasoning: true,
    });
    expect(edits.some((edit) => edit.path.at(-1) === 'name')).toBe(false);
    expect(edits.some((edit) => edit.path.at(-1) === 'variants')).toBe(false);
    expect(edits.some((edit) => edit.path.at(-1) === 'modelID')).toBe(false);
  });

  it('can omit reasoning while still adopting token metadata', () => {
    const edits = candidateAdoptionEdits(
      'v2',
      v2Provider,
      v2Model,
      makeCandidate(),
      { name: false, context: true, input: true, output: true, reasoning: false },
    );
    expect(edits.some((edit) => edit.path.includes('reasoning'))).toBe(false);
    // context and output differ; input already matches and is skipped.
    expect(edits).toHaveLength(2);
    const context = edits.find((edit) => edit.path.at(-1) === 'context');
    expect(context?.path).toEqual(
      modelLeafPath('v2', locateModel(v2Provider, v2Model), 'context'),
    );
  });

  it('supports legacy bool catalog reasoning without leaking it into V1 objects', () => {
    const edits = candidateAdoptionEdits(
      'v1',
      v1Provider,
      { ...v1Model, reasoning: null },
      makeCandidate({
        reasoning: true,
        context: null,
        input: null,
        output: null,
        name: '',
      }),
      selectAll(),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].value).toBe(true);
  });
});

describe('field-level candidate comparison', () => {
  it('only pre-selects fields the model is missing', () => {
    const rows = describeCandidateFields('v2', baselineOf(v2Model), makeCandidate());
    const selection = defaultAdoptionSelection(rows);
    // The fixture model already has name/context/input/output/reasoning values.
    expect(selection).toEqual({
      name: false,
      context: false,
      input: false,
      output: false,
      reasoning: false,
    });
  });

  it('marks identical values as 相同 and unknown candidate values as unavailable', () => {
    const rows = describeCandidateFields(
      'v2',
      baselineOf({ ...v2Model, output: 32768 }),
      makeCandidate({ input: null, name: v2Model.name ?? '', context: 262144 }),
    );
    const output = rows.find((row) => row.key === 'output');
    expect(output?.status).toBe('same');
    const input = rows.find((row) => row.key === 'input');
    expect(input?.status).toBe('unavailable');
    expect(input?.proposedEmpty).toBe(true);
  });

  it('uses an explicit empty marker so a null reasoning is not read as an overwrite', () => {
    const rows = describeCandidateFields('v2', baselineOf(v2Model), makeCandidate());
    const reasoning = rows.find((row) => row.key === 'reasoning');
    expect(reasoning?.currentEmpty).toBe(false);
    expect(reasoning?.current).toContain('支持');

    const emptyBaseline = describeCandidateFields(
      'v2',
      baselineOf({ ...v2Model, reasoning: null }),
      makeCandidate({ reasoning: null }),
    );
    const emptyReasoning = emptyBaseline.find((row) => row.key === 'reasoning');
    expect(emptyReasoning?.currentEmpty).toBe(true);
    expect(emptyReasoning?.current).toBe('未设置');
    expect(emptyReasoning?.status).toBe('unavailable');
  });

  it('compares reasoning by the written value, so unknown keys are not hidden', () => {
    const rows = describeCandidateFields(
      'v2',
      baselineOf({ ...v2Model, reasoning: { supported: true, effort: ['low'], custom: 1 } }),
      makeCandidate({ reasoning: { supported: true, effort: ['low'] } }),
    );
    const reasoning = rows.find((row) => row.key === 'reasoning');
    expect(reasoning?.status).toBe('available');
  });

  it('treats a V1 candidate with levels as equal when the boolean matches', () => {
    const rows = describeCandidateFields(
      'v1',
      baselineOf({ ...v1Model, reasoning: true }),
      makeCandidate({ reasoning: { supported: true, effort: ['high'] } }),
    );
    const reasoning = rows.find((row) => row.key === 'reasoning');
    expect(reasoning?.status).toBe('same');
    expect(reasoning?.proposed).toContain('旧版只写布尔');
  });

  it('shows only the known bound when a candidate budget is one-sided', () => {
    const current = describeCandidateFields(
      'v2',
      baselineOf(v2Model),
      makeCandidate({ reasoning: { supported: true, budget: { max: 16384 } } }),
    ).find((row) => row.key === 'reasoning');
    expect(current?.current).toContain('预算 0 – 8,192 token');
    expect(current?.proposed).toContain('预算 最多 16,384 token');
    expect(current?.proposed).not.toContain('0 –');

    const minOnly = describeCandidateFields(
      'v2',
      baselineOf(v2Model),
      makeCandidate({ reasoning: { supported: true, budget: { min: 1024 } } }),
    ).find((row) => row.key === 'reasoning');
    expect(minOnly?.proposed).toContain('预算 至少 1,024 token');
    expect(minOnly?.proposed).not.toContain('–');

    const full = describeCandidateFields(
      'v2',
      baselineOf(v2Model),
      makeCandidate({ reasoning: { supported: true, budget: { min: 0, max: 16384 } } }),
    ).find((row) => row.key === 'reasoning');
    expect(full?.proposed).toContain('预算 0 – 16,384 token');
  });

  it('does not read a truthy V1 object as supported', () => {
    const rows = describeCandidateFields(
      'v1',
      baselineOf({ ...v1Model, reasoning: { supported: false } }),
      makeCandidate({ reasoning: { supported: false } }),
    );
    const reasoning = rows.find((row) => row.key === 'reasoning');
    expect(reasoning?.current).toBe('不支持（其它字段旧版不适用）');
    expect(reasoning?.status).toBe('same');

    const unknown = describeCandidateFields(
      'v1',
      baselineOf({ ...v1Model, reasoning: { vendorMode: 'auto' } }),
      makeCandidate({ reasoning: { supported: true } }),
    ).find((row) => row.key === 'reasoning');
    expect(unknown?.current).toBe('结构未知');
    expect(unknown?.currentEmpty).toBe(false);
    expect(unknown?.status).toBe('available');
  });

  it('writes an explicitly confirmed name even when the stored one differs', () => {
    const edits = candidateAdoptionEdits(
      'v2',
      v2Provider,
      v2Model,
      makeCandidate({ name: 'New Name' }),
      { name: true, context: false, input: false, output: false, reasoning: false },
    );
    expect(edits).toEqual([
      {
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'name'],
        value: 'New Name',
        label: '显示名（建议）',
      },
    ]);
  });

  it('skips reasoning that would be written identically', () => {
    const edits = candidateAdoptionEdits(
      'v2',
      v2Provider,
      { ...v2Model, reasoning: { supported: false } },
      makeCandidate({
        context: v2Model.context,
        input: v2Model.input,
        output: v2Model.output,
        reasoning: { supported: false },
      }),
      { name: false, context: false, input: false, output: false, reasoning: true },
    );
    expect(edits).toEqual([]);
  });

  it('writes nothing when the selection matches stored values', () => {
    const edits = candidateAdoptionEdits(
      'v2',
      v2Provider,
      { ...v2Model, context: 262144, input: 180000, output: 32768 },
      makeCandidate(),
      { name: false, context: true, input: true, output: true, reasoning: false },
    );
    expect(edits).toEqual([]);
  });

  it('does not invent effort when the candidate only declares support', () => {
    const candidate = makeCandidate({ reasoning: { supported: true } });
    const edits = candidateAdoptionEdits('v2', v2Provider, { ...v2Model, reasoning: null }, candidate, {
      name: false,
      context: false,
      input: false,
      output: false,
      reasoning: true,
    });
    const reasoning = edits.find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.value).toEqual({ supported: true });
    expect(JSON.stringify(reasoning?.value)).not.toContain('effort');
  });
});

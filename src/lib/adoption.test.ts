import { describe, expect, it } from 'vitest';
import { candidateAdoptionEdits } from './adoption';
import { locateModel, modelLeafPath } from './paths';
import { V1_NATIVE_SOURCE, V2_NATIVE_SOURCE, makeCandidate } from '../test/fixtures';

const v2Provider = V2_NATIVE_SOURCE.providers[0];
const v2Model = v2Provider.models[0];
const v1Provider = V1_NATIVE_SOURCE.providers[0];
const v1Model = v1Provider.models[0];

describe('catalog adoption', () => {
  it('emits map-keyed V2 paths and normalized reasoning objects', () => {
    const edits = candidateAdoptionEdits(
      'v2',
      v2Provider,
      v2Model,
      makeCandidate(),
      true,
    );
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
      v1Model,
      makeCandidate({
        providerId: 'zhipu',
        id: 'glm-4.6',
        name: 'GLM-4.6',
        context: 262144,
        input: null,
        output: 131072,
        reasoning: { supported: true, toggle: true, effort: ['low'], budget: { max: 4096 } },
      }),
      true,
    );
    const reasoning = edits.find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.path).toEqual(['provider', 'zhipu', 'models', 'glm-4.6', 'reasoning']);
    expect(reasoning?.value).toBe(true);
    expect(JSON.stringify(edits)).not.toContain('effort');
    expect(JSON.stringify(edits)).not.toContain('budget');
  });

  it('does not overwrite an existing name and does not write request ids or variants', () => {
    const target = { ...v2Model, name: 'Already named' };
    const edits = candidateAdoptionEdits('v2', v2Provider, target, makeCandidate(), true);
    expect(edits.some((edit) => edit.path.at(-1) === 'name')).toBe(false);
    expect(edits.some((edit) => edit.path.at(-1) === 'variants')).toBe(false);
    expect(edits.some((edit) => edit.path.at(-1) === 'modelID')).toBe(false);
  });

  it('can omit reasoning while still adopting token metadata', () => {
    const edits = candidateAdoptionEdits('v2', v2Provider, v2Model, makeCandidate(), false);
    expect(edits.some((edit) => edit.path.includes('reasoning'))).toBe(false);
    expect(edits).toHaveLength(3); // context, input (candidate), output; name already set
    const context = edits.find((edit) => edit.path.at(-1) === 'context');
    expect(context?.path).toEqual(
      modelLeafPath('v2', locateModel(v2Provider, v2Model), 'context'),
    );
  });

  it('supports legacy bool catalog reasoning without leaking it into V1 objects', () => {
    const edits = candidateAdoptionEdits(
      'v1',
      v1Provider,
      v1Model,
      makeCandidate({
        reasoning: true,
        context: null,
        input: null,
        output: null,
        name: '',
      }),
      true,
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].value).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { validateEdit } from './editRules';
import { locateModel, modelLeafPath } from './paths';
import { V2_NATIVE_SOURCE } from '../test/fixtures';

const provider = V2_NATIVE_SOURCE.providers[0];
const model = provider.models[0];
const locator = locateModel(provider, model);

describe('V2 editing rules', () => {
  it('accepts keyed model field edits and capability objects', () => {
    const contextPath = modelLeafPath('v2', locator, 'context');
    expect(
      validateEdit({ op: 'set', path: contextPath, value: 262144 }, 'v2', 'field'),
    ).toBeNull();
    expect(
      validateEdit(
        {
          op: 'set',
          path: modelLeafPath('v2', locator, 'reasoning'),
          value: { supported: true, effort: ['low'], budget: { max: 900 } },
        },
        'v2',
        'field',
      ),
    ).toBeNull();
  });

  it('rejects bare booleans for V2 capabilities.reasoning', () => {
    const path = modelLeafPath('v2', locator, 'reasoning');
    expect(validateEdit({ op: 'set', path, value: true }, 'v2', 'field')).toMatch(
      '归一化对象',
    );
  });

  it('creates a V2 model at the map key', () => {
    expect(
      validateEdit(
        {
          op: 'set',
          path: ['providers', 'gateway', 'models', 'upstream/new-model'],
          value: { capabilities: { reasoning: { supported: true } } },
        },
        'v2',
        'create-model',
      ),
    ).toBeNull();
    expect(
      validateEdit(
        {
          op: 'set',
          path: ['providers', 'gateway', 'models', '0'],
          value: {},
        },
        'v2',
        'create-model',
      ),
    ).toBeNull();
  });

  it('rejects whole-provider replacement and credential paths', () => {
    expect(
      validateEdit(
        { op: 'set', path: ['providers', 'gateway'], value: { name: 'x' } },
        'v2',
        'field',
      ),
    ).toMatch('该提供方字段不在允许编辑的范围内');
    expect(
      validateEdit(
        {
          op: 'set',
          path: ['providers', 'gateway', 'models', 'upstream/coder'],
          value: { name: 'x' },
        },
        'v2',
        'field',
      ),
    ).toMatch('按字段修改');
    expect(
      validateEdit(
        { op: 'set', path: ['providers', 'gateway', 'apiKey'], value: 'nope' },
        'v2',
        'field',
      ),
    ).toMatch('敏感字段');
    expect(
      validateEdit(
        {
          op: 'set',
          path: ['providers', 'gateway', 'models', 'upstream/coder', 'modelID'],
          value: 'rewritten',
        },
        'v2',
        'field',
      ),
    ).toMatch('允许编辑');
  });

  it('only allows variants leaves to be replaced as a whole', () => {
    expect(
      validateEdit(
        {
          op: 'set',
          path: modelLeafPath('v2', locator, 'variants'),
          value: [{ id: 'fast' }],
        },
        'v2',
        'field',
      ),
    ).toBeNull();
    expect(
      validateEdit(
        {
          op: 'set',
          path: ['providers', 'gateway', 'models', 'upstream/coder', 'variants', '0'],
          value: { id: 'fast' },
        },
        'v2',
        'field',
      ),
    ).toMatch('允许编辑');
  });

  it('allows default model only at the top-level model path', () => {
    expect(
      validateEdit({ op: 'set', path: ['model'], value: 'gateway/upstream/coder' }, 'v2', 'default'),
    ).toBeNull();
    expect(
      validateEdit(
        { op: 'set', path: ['providers', 'gateway', 'model'], value: 'x/y' },
        'v2',
        'default',
      ),
    ).toMatch('顶层 model');
  });
});

describe('V1 editing rules', () => {
  it('requires boolean reasoning for V1', () => {
    const path = ['provider', 'zhipu', 'models', 'glm-4.6', 'reasoning'];
    expect(validateEdit({ op: 'set', path, value: true }, 'v1', 'field')).toBeNull();
    expect(
      validateEdit(
        { op: 'set', path, value: { supported: true } },
        'v1',
        'field',
      ),
    ).toMatch('布尔值');
  });
});

it('accepts provider deletion and creation intents only', () => {
  expect(
    validateEdit({ op: 'remove', path: ['providers', 'gateway'] }, 'v2', 'delete-provider'),
  ).toBeNull();
  expect(
    validateEdit({ op: 'set', path: ['providers', 'gateway'], value: {} }, 'v2', 'create-provider'),
  ).toBeNull();
  expect(
    validateEdit({ op: 'set', path: ['providers', 'gateway'], value: {} }, 'v2', 'delete-provider'),
  ).toMatch('remove');
});

import { describe, expect, it } from 'vitest';
import {
  buildModelCreateValue,
  buildProviderCreateValue,
  composeDefaultModel,
  formatPath,
  isConcreteDialect,
  locateModel,
  modelLeafPath,
  modelRoot,
  pathKey,
  pathStartsWith,
  providerLeafPath,
  providerRoot,
  resolveCurrentValue,
  validateModelId,
} from './paths';
import { V2_NATIVE_SOURCE } from '../test/fixtures';

const provider = V2_NATIVE_SOURCE.providers[0];
const model = provider.models[0];
const locator = locateModel(provider, model);

describe('map-key paths', () => {
  it('addresses V2 models by the object map key, never by array index', () => {
    expect(modelRoot('v2', { providerId: 'gateway', modelId: 'upstream/coder' })).toEqual([
      'providers',
      'gateway',
      'models',
      'upstream/coder',
    ]);
    expect(modelLeafPath('v2', locator, 'context')).toEqual([
      'providers',
      'gateway',
      'models',
      'upstream/coder',
      'limit',
      'context',
    ]);
    expect(modelLeafPath('v2', locator, 'reasoning')).toEqual([
      'providers',
      'gateway',
      'models',
      'upstream/coder',
      'capabilities',
      'reasoning',
    ]);
    expect(modelLeafPath('v2', locator, 'variants')).toEqual([
      'providers',
      'gateway',
      'models',
      'upstream/coder',
      'variants',
    ]);
    expect(modelLeafPath('v2', locator, 'input')).toEqual([
      'providers',
      'gateway',
      'models',
      'upstream/coder',
      'limit',
      'input',
    ]);
  });

  it('keeps V1 model keys and uses V1 option/base leaves', () => {
    expect(modelRoot('v1', { providerId: 'zhipu', modelId: 'glm-4.6' })).toEqual([
      'provider',
      'zhipu',
      'models',
      'glm-4.6',
    ]);
    expect(providerRoot('v1', 'zhipu')).toEqual(['provider', 'zhipu']);
    expect(providerHeapBase('v1')).toEqual(['provider', 'zhipu', 'options', 'baseURL']);
    expect(providerHeapBase('v2')).toEqual(['providers', 'gateway', 'settings', 'baseURL']);
  });

  it('renders key segments with quotes so slash/dot keys stay readable', () => {
    expect(formatPath(['providers', 'gateway', 'models', 'upstream/coder', 'name'])).toBe(
      'providers.gateway.models["upstream/coder"].name',
    );
    expect(formatPath(['providers', 'gateway', 'models', 'plain.model'])).toBe(
      'providers.gateway.models["plain.model"]',
    );
    // No array brackets for model paths in either dialect.
    expect(formatPath(['providers', 'gateway', 'models', '0'])).toBe(
      'providers.gateway.models.0',
    );
  });

  it('resolves current values by key and maps modelID to requestId', () => {
    expect(
      resolveCurrentValue(V2_NATIVE_SOURCE, [
        'providers',
        'gateway',
        'models',
        'upstream/coder',
        'limit',
        'context',
      ]),
    ).toEqual({ found: true, value: 200000 });
    expect(
      resolveCurrentValue(V2_NATIVE_SOURCE, [
        'providers',
        'gateway',
        'models',
        'upstream/coder',
        'modelID',
      ]),
    ).toEqual({ found: true, value: 'vendor-request-id-42' });
    expect(
      resolveCurrentValue(V2_NATIVE_SOURCE, [
        'providers',
        'gateway',
        'models',
        'upstream/coder',
        'capabilities',
        'reasoning',
      ]),
    ).toEqual({
      found: true,
      value: {
        supported: true,
        toggle: true,
        effort: ['low', 'high'],
        budget: { min: 0, max: 8192 },
      },
    });
  });

  it('derives default model strings without variant suffixes', () => {
    expect(composeDefaultModel('gateway', 'upstream/coder')).toBe('gateway/upstream/coder');
    expect(pathKey(['model'])).not.toBe(pathKey(['model', 'extra']));
    expect(pathStartsWith(['providers', 'gateway', 'models', 'x'], ['providers', 'gateway'])).toBe(
      true,
    );
  });
});

describe('creation shapes', () => {
  it('creates a V2 provider with an object models map', () => {
    const value = buildProviderCreateValue('v2', {
      id: 'new-provider',
      name: 'New',
      baseUrl: 'https://example.com/v1',
      packageName: '',
    });
    expect(value.models).toEqual({});
    expect(Array.isArray(value.models)).toBe(false);
    expect(value.settings).toEqual({ baseURL: 'https://example.com/v1' });
  });

  it('creates a V2 model without modelID and with capability object', () => {
    const value = buildModelCreateValue('v2', {
      id: 'upstream/coder-2',
      name: '',
      context: 64000,
      input: null,
      output: 8000,
      reasoning: true,
    });
    expect(value).toEqual({
      limit: { context: 64000, output: 8000 },
      capabilities: { reasoning: { supported: true } },
    });
    expect(value).not.toHaveProperty('modelID');
    expect(value).not.toHaveProperty('id');
  });

  it('creates V1 with boolean reasoning and no capabilities wrapper', () => {
    const value = buildModelCreateValue('v1', {
      id: 'glm-x',
      name: 'GLM X',
      context: null,
      input: null,
      output: null,
      reasoning: false,
    });
    expect(value).toEqual({ name: 'GLM X', reasoning: false });
  });

  it('rejects whitespace model ids but accepts slash/dot keys', () => {
    expect(validateModelId('upstream/coder')).toBeNull();
    expect(validateModelId('plain.model')).toBeNull();
    expect(validateModelId('bad model')).not.toBeNull();
    expect(isConcreteDialect('mixed')).toBe(false);
  });
});

function providerHeapBase(dialect: 'v1' | 'v2') {
  return providerLeafPath(dialect, dialect === 'v1' ? 'zhipu' : 'gateway', 'baseUrl');
}

import type { Dialect, ModelEntry, ProviderEntry, SourceDocument } from '../ipc';

export type ConcreteDialect = 'v1' | 'v2';

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

export function isConcreteDialect(dialect: Dialect): dialect is ConcreteDialect {
  return dialect === 'v1' || dialect === 'v2';
}

export function toConcreteDialect(dialect: Dialect): ConcreteDialect {
  if (dialect === 'v1' || dialect === 'v2') return dialect;
  throw new PathError(`方言 ${dialect} 不能作为编辑目标，请先明确 V1 或 V2。`);
}

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function validateProviderId(id: string): string | null {
  if (!id.trim()) return '提供方标识不能为空。';
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return '提供方标识只能使用小写字母、数字、点、下划线或短横线。';
  }
  return null;
}

export function validateModelId(id: string): string | null {
  if (!id.trim()) return '模型标识不能为空。';
  if (/\s/.test(id)) return '模型标识不能包含空白字符。';
  return null;
}

export function providerMapKey(dialect: ConcreteDialect): 'provider' | 'providers' {
  return dialect === 'v1' ? 'provider' : 'providers';
}

export function providerRoot(dialect: ConcreteDialect, providerId: string): string[] {
  return [providerMapKey(dialect), providerId];
}

export function providerLeafPath(
  dialect: ConcreteDialect,
  providerId: string,
  leaf: 'name' | 'baseUrl',
): string[] {
  if (leaf === 'name') return [...providerRoot(dialect, providerId), 'name'];
  return dialect === 'v1'
    ? [...providerRoot(dialect, providerId), 'options', 'baseURL']
    : [...providerRoot(dialect, providerId), 'settings', 'baseURL'];
}

export function providerPackagePath(
  dialect: ConcreteDialect,
  providerId: string,
): string[] {
  return [...providerRoot(dialect, providerId), dialect === 'v1' ? 'npm' : 'package'];
}

export interface ModelLocator {
  providerId: string;
  modelId: string;
}

/**
 * V1 and V2 both address models by the map key (`ModelEntry.id`).
 * `modelID` is an optional upstream request-id override, not the catalog key.
 */
export function modelRoot(dialect: ConcreteDialect, locator: ModelLocator): string[] {
  return [providerMapKey(dialect), locator.providerId, 'models', locator.modelId];
}

export type ModelLeaf =
  | 'name'
  | 'context'
  | 'input'
  | 'output'
  | 'reasoning'
  | 'variants';

export function modelLeafPath(
  dialect: ConcreteDialect,
  locator: ModelLocator,
  leaf: ModelLeaf,
): string[] {
  const root = modelRoot(dialect, locator);
  switch (leaf) {
    case 'name':
      return [...root, 'name'];
    case 'context':
      return [...root, 'limit', 'context'];
    case 'input':
      return [...root, 'limit', 'input'];
    case 'output':
      return [...root, 'limit', 'output'];
    case 'reasoning':
      return dialect === 'v1' ? [...root, 'reasoning'] : [...root, 'capabilities', 'reasoning'];
    case 'variants':
      return [...root, 'variants'];
  }
}

export function defaultModelPath(): string[] {
  return ['model'];
}

/** `provider/model` exactly — never append a made-up variant suffix. */
export function composeDefaultModel(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function locateModel(provider: ProviderEntry, model: ModelEntry): ModelLocator {
  return { providerId: provider.id, modelId: model.id };
}

export interface ProviderDraftInput {
  id: string;
  name: string;
  baseUrl: string;
  packageName: string;
}

export interface ModelDraftInput {
  id: string;
  name: string;
  context: number | null;
  input: number | null;
  output: number | null;
  reasoning: boolean | null;
  variants?: unknown;
}

function compactLimit(input: {
  context: number | null;
  input: number | null;
  output: number | null;
}): Record<string, number> | null {
  const limit: Record<string, number> = {};
  if (input.context !== null) limit.context = input.context;
  if (input.input !== null) limit.input = input.input;
  if (input.output !== null) limit.output = input.output;
  return Object.keys(limit).length > 0 ? limit : null;
}

/** Safe shape for a brand-new provider. Existing providers are never replaced. */
export function buildProviderCreateValue(
  dialect: ConcreteDialect,
  input: ProviderDraftInput,
): Record<string, unknown> {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim();
  const packageName = input.packageName.trim();
  if (dialect === 'v1') {
    const value: Record<string, unknown> = {};
    if (name) value.name = name;
    if (packageName) value.npm = packageName;
    if (baseUrl) value.options = { baseURL: baseUrl };
    value.models = {};
    return value;
  }
  const value: Record<string, unknown> = {};
  if (name) value.name = name;
  if (packageName) value.package = packageName;
  if (baseUrl) value.settings = { baseURL: baseUrl };
  value.models = {};
  return value;
}

/** Safe shape for a brand-new model. Existing models are edited leaf by leaf. */
export function buildModelCreateValue(
  dialect: ConcreteDialect,
  input: ModelDraftInput,
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  const name = input.name.trim();
  if (name) value.name = name;
  const limit = compactLimit(input);
  if (limit) value.limit = limit;
  if (input.reasoning !== null) {
    if (dialect === 'v1') {
      value.reasoning = input.reasoning;
    } else {
      // V2 capabilities.reasoning is a normalized object; never a bare boolean.
      value.capabilities = { reasoning: { supported: input.reasoning } };
    }
  }
  if (input.variants !== undefined) value.variants = input.variants;
  return value;
}

/**
 * Render a path for the UI. Model ids and provider ids are map keys in both
 * dialects; segments containing `.` or `/` are quoted so keys stay readable.
 * Editing `variants` replaces the whole array/object leaf, so no array indexes
 * ever appear in an edit path.
 */
export function formatPath(path: string[], _dialect: Dialect = 'v1'): string {
  let rendered = '';
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (index === 0) {
      rendered = segment;
    } else if (/^[A-Za-z0-9_-]+$/.test(segment)) {
      rendered += `.${segment}`;
    } else {
      rendered += `[${JSON.stringify(segment)}]`;
    }
  }
  return rendered;
}

export function pathKey(path: string[]): string {
  return JSON.stringify(path);
}

export function pathStartsWith(path: string[], prefix: string[]): boolean {
  if (path.length < prefix.length) return false;
  return prefix.every((segment, index) => path[index] === segment);
}

export function resolveCurrentValue(
  source: SourceDocument,
  path: string[],
): { found: true; value: unknown } | { found: false } {
  if (path.length === 1 && path[0] === 'model') {
    return source.defaultModel === null
      ? { found: false }
      : { found: true, value: source.defaultModel };
  }
  const map = path[0];
  if (map !== 'provider' && map !== 'providers') return { found: false };
  const providerId = path[1];
  if (!providerId) return { found: false };
  const provider = source.providers.find((entry) => entry.id === providerId);
  if (!provider) return { found: false };

  const rest = path.slice(2);
  if (rest.length === 1 && rest[0] === 'name') {
    return provider.name === null ? { found: false } : { found: true, value: provider.name };
  }
  if (rest.length === 2) {
    const [first, second] = rest;
    if (first === 'options' && second === 'baseURL') {
      return provider.baseUrl === null ? { found: false } : { found: true, value: provider.baseUrl };
    }
    if (first === 'settings' && second === 'baseURL') {
      return provider.baseUrl === null ? { found: false } : { found: true, value: provider.baseUrl };
    }
  }
  if (rest[0] === 'npm' || rest[0] === 'package') return { found: false };

  if (rest[0] !== 'models') return { found: false };
  const modelKey = rest[1];
  const model = provider.models.find((entry) => entry.id === modelKey);
  const leaf = rest.slice(2);
  if (!model) return { found: false };

  if (leaf.length === 1) {
    switch (leaf[0]) {
      case 'modelID':
        return model.requestId === null
          ? { found: false }
          : { found: true, value: model.requestId };
      case 'requestId':
        return model.requestId === null ? { found: false } : { found: true, value: model.requestId };
      case 'name':
        return model.name === null ? { found: false } : { found: true, value: model.name };
      case 'reasoning':
        return model.reasoning === null ? { found: false } : { found: true, value: model.reasoning };
      case 'variants':
        return model.variants === null ? { found: false } : { found: true, value: model.variants };
      default:
        return { found: false };
    }
  }
  if (leaf.length === 2) {
    if (leaf[0] === 'limit') {
      if (leaf[1] === 'context') {
        return model.context === null ? { found: false } : { found: true, value: model.context };
      }
      if (leaf[1] === 'input') {
        return model.input === null ? { found: false } : { found: true, value: model.input };
      }
      if (leaf[1] === 'output') {
        return model.output === null ? { found: false } : { found: true, value: model.output };
      }
    }
    if (leaf[0] === 'capabilities' && leaf[1] === 'reasoning') {
      return model.reasoning === null ? { found: false } : { found: true, value: model.reasoning };
    }
  }
  return { found: false };
}

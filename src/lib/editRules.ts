import type { ConcreteDialect } from './paths';
import type { Edit } from '../ipc';
import { PROVIDER_ID_PATTERN, validateModelId, validateProviderId } from './paths';
import { validateReasoningValue, validateVariantsValue } from './validate';

export type DraftIntent =
  | 'field'
  | 'create-provider'
  | 'create-model'
  | 'delete-provider'
  | 'delete-model'
  | 'default';

const SECRET_SEGMENT =
  /^(api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|authorization|headers|credentials?|env)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function validateLeafValue(dialect: ConcreteDialect, leaf: string, value: unknown): string | null {
  if (leaf === 'name') {
    return typeof value === 'string' ? null : '名称必须是字符串。';
  }
  if (leaf === 'baseURL') {
    return typeof value === 'string' ? null : '基础地址必须是字符串。';
  }
  if (leaf === 'context' || leaf === 'input' || leaf === 'output') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return '令牌数量必须是非负整数。';
    }
    return null;
  }
  if (leaf === 'reasoning') {
    const issues = validateReasoningValue(dialect, value);
    const error = issues.find((issue) => issue.level === 'error');
    return error ? error.message : null;
  }
  if (leaf === 'variants') {
    if (value === null) return null;
    if (!isSerializable(value)) return '变体字段必须是可序列化的 JSON 值。';
    const issues = validateVariantsValue(dialect, value);
    const error = issues.find((issue) => issue.level === 'error');
    return error ? error.message : null;
  }
  return '该字段不在允许编辑的范围内。';
}

/**
 * Front-load the contract's editing rules so the shell never receives an unsafe path.
 * Existing providers/models may only be changed leaf by leaf; creation and deletion use
 * dedicated intents so a sanitized DTO can never reconstruct a secret-bearing entry.
 */
export function validateEdit(
  edit: Edit,
  dialect: ConcreteDialect,
  intent: DraftIntent,
): string | null {
  if (!Array.isArray(edit.path) || edit.path.length === 0) return '编辑路径为空。';
  if (edit.path.some((segment) => typeof segment !== 'string' || segment.length === 0)) {
    return '编辑路径包含无效片段。';
  }
  const blocked = edit.path.find((segment) => SECRET_SEGMENT.test(segment));
  if (blocked) return `凭据或敏感字段（${blocked}）不能在界面中编辑。`;
  if (edit.op !== 'set' && edit.op !== 'remove') return '未知编辑操作。';

  if (intent === 'default') {
    if (edit.path.length !== 1 || edit.path[0] !== 'model') {
      return '默认模型只能写入顶层 model 字段。';
    }
    if (edit.op === 'remove') return null;
    if (typeof edit.value !== 'string' || !edit.value.includes('/')) {
      return '默认模型必须使用 provider/model 形式。';
    }
    return null;
  }

  const root = dialect === 'v1' ? 'provider' : 'providers';
  if (edit.path[0] !== root) {
    return `该路径不属于 ${dialect.toUpperCase()} 的 ${root} 映射。`;
  }

  if (intent === 'create-provider') {
    if (edit.op !== 'set') return '新建提供方只能使用 set 操作。';
    if (edit.path.length !== 2) return '新建提供方路径必须指向映射中的新键。';
    const id = edit.path[1];
    if (validateProviderId(id)) return validateProviderId(id);
    if (!isPlainObject(edit.value)) return '新建提供方需要对象值。';
    if (!isSerializable(edit.value)) return '新建提供方值无法序列化。';
    return null;
  }

  if (intent === 'delete-provider') {
    if (edit.op !== 'remove') return '删除提供方只能使用 remove 操作。';
    if (edit.path.length !== 2) return '删除提供方路径不完整。';
    return null;
  }

  if (intent === 'create-model') {
    if (edit.op !== 'set') return '新建模型只能使用 set 操作。';
    if (edit.path.length !== 4 || edit.path[2] !== 'models') return '新建模型路径不完整。';
    if (validateProviderId(edit.path[1])) return validateProviderId(edit.path[1]);
    const idError = validateModelId(edit.path[3]);
    if (idError) return idError;
    if (!isPlainObject(edit.value)) return '新建模型需要对象值。';
    if (!isSerializable(edit.value)) return '新建模型值无法序列化。';
    return null;
  }

  if (intent === 'delete-model') {
    if (edit.op !== 'remove') return '删除模型只能使用 remove 操作。';
    if (edit.path.length !== 4 || edit.path[2] !== 'models') return '删除模型路径不完整。';
    return null;
  }

  // intent === 'field': leaf-only edits on an existing provider or model.
  const rest = edit.path.slice(2);

  const providerFields: string[][] =
    dialect === 'v1'
      ? [['name'], ['options', 'baseURL']]
      : [['name'], ['settings', 'baseURL']];

  if (providerFields.some((candidate) => rest.length === candidate.length && candidate.every((segment, index) => rest[index] === segment))) {
    const leaf = rest[rest.length - 1];
    return edit.op === 'remove' ? null : validateLeafValue(dialect, leaf, edit.value);
  }

  if (rest[0] !== 'models') return '该提供方字段不在允许编辑的范围内。';
  if (rest.length < 3) return '已有条目只能按字段修改，不能整体替换。';
  const tail = rest.slice(2);
  if (edit.op === 'remove') {
    const allowedTail =
      tail.length === 1
        ? ['name', 'reasoning', 'variants'].includes(tail[0]) ||
          (dialect === 'v2' && tail[0] === 'capabilities')
        : tail.length === 2 &&
          ((tail[0] === 'limit' && ['context', 'input', 'output'].includes(tail[1])) ||
            (dialect === 'v2' && tail[0] === 'capabilities' && tail[1] === 'reasoning'));
    return allowedTail ? null : '该模型字段不能清除。';
  }

  const modelName = tail.length === 1 && tail[0] === 'name';
  const limitLeaf =
    tail.length === 2 && tail[0] === 'limit' && ['context', 'input', 'output'].includes(tail[1]);
  const reasoningLeaf =
    dialect === 'v1'
      ? tail.length === 1 && tail[0] === 'reasoning'
      : tail.length === 2 && tail[0] === 'capabilities' && tail[1] === 'reasoning';
  const variantsLeaf = tail.length === 1 && tail[0] === 'variants';
  if (!modelName && !limitLeaf && !reasoningLeaf && !variantsLeaf) {
    return '该模型字段不在允许编辑的范围内。';
  }
  const leaf = tail[tail.length - 1];
  return validateLeafValue(dialect, leaf, edit.value);
}

/** Convenience for UI-only checks before staging. */
export function providerIdIssue(id: string): string | null {
  return PROVIDER_ID_PATTERN.test(id) ? null : validateProviderId(id);
}

import type { Dialect, ModelEntry, ProviderEntry, SourceDocument } from '../ipc';
import { compactValue, credentialLabel, dialectLabel, formatTokens, shortHash } from './format';
import { describeReasoning } from './reasoning';
import type { Batch, Draft } from './store';
import { draftForPath } from './store';
import {
  formatPath,
  isConcreteDialect,
  locateModel,
  modelLeafPath,
  modelRoot,
  providerLeafPath,
  providerRoot,
} from './paths';

export type LineageTone = 'read' | 'draft' | 'muted' | 'danger';

export interface LineageNode {
  key: string;
  label: string;
  value: string;
  meta?: string;
  tone: LineageTone;
  tag?: string;
  targetPath?: string;
}

function providerDialectForPath(source: SourceDocument, provider: ProviderEntry): Dialect {
  return isConcreteDialect(provider.dialect)
    ? provider.dialect
    : isConcreteDialect(source.dialect)
      ? source.dialect
      : 'ambiguous';
}

function fieldNode(
  key: string,
  label: string,
  path: string[],
  dialect: Dialect,
  current: string,
  batch: Batch | null,
  draftLabel: string,
): LineageNode {
  const draft: Draft | undefined = draftForPath(batch, path);
  if (!draft) {
    return { key, label, value: current, tone: 'read', targetPath: formatPath(path, dialect) };
  }
  const suffix = draft.op === 'remove' ? '（清除）' : compactValue(draft.value, 64);
  const tag =
    draft.origin === 'suggestion' ? '建议草稿' : draft.origin === 'inventory' ? '清单草稿' : '草稿';
  return {
    key,
    label,
    value: `${current} → ${suffix}`,
    meta: draftLabel,
    tone: 'draft',
    tag,
    targetPath: formatPath(path, dialect),
  };
}

function fileNode(source: SourceDocument, keyPrefix: string): LineageNode {
  const writable = source.writable ? '可写' : '只读';
  return {
    key: `${keyPrefix}-file`,
    label: 'SOURCE',
    value: source.path,
    meta: `${dialectLabel(source.dialect)} · ${writable} · ${shortHash(source.hash, 10)}`,
    tone: source.dialect === 'invalid' ? 'danger' : 'read',
  };
}

export function sourceLineage(source: SourceDocument): LineageNode[] {
  return [
    fileNode(source, 'source'),
    {
      key: 'source-dialect',
      label: 'DIALECT',
      value: `${dialectLabel(source.dialect)}${source.dialect === 'mixed' ? ' · 顶层并存' : ''}`,
      meta: source.dialect === 'v1' ? 'provider' : source.dialect === 'v2' ? 'providers' : '需明确目标映射',
      tone: source.dialect === 'invalid' ? 'danger' : 'read',
    },
    {
      key: 'source-hash',
      label: 'HASH',
      value: source.hash,
      meta: '预演与应用都以该哈希为基准',
      tone: 'read',
    },
    {
      key: 'source-default',
      label: 'DEFAULT',
      value: source.defaultModel ?? '未声明',
      meta: '顶层 model 字段；不补写变体后缀',
      tone: source.defaultModel ? 'read' : 'muted',
    },
    {
      key: 'source-counts',
      label: 'SCOPE',
      value: `${source.providers.length} 提供方 · ${source.providers.reduce((total, provider) => total + provider.models.length, 0)} 模型`,
      meta: source.writable ? '允许字段级草稿' : '结构只读',
      tone: source.writable ? 'read' : 'muted',
    },
  ];
}

export function providerLineage(
  source: SourceDocument,
  provider: ProviderEntry,
  batch: Batch | null,
): LineageNode[] {
  const dialect = providerDialectForPath(source, provider);
  const concrete = isConcreteDialect(dialect) ? dialect : null;
  const nodes: LineageNode[] = [fileNode(source, 'provider')];
  if (concrete) {
    nodes.push({
      key: 'provider-map',
      label: 'PROVIDER',
      value: formatPath(providerRoot(concrete, provider.id), concrete),
      meta: `${dialectLabel(provider.dialect)} · ${provider.models.length} 模型`,
      tone: 'read',
    });
    nodes.push(
      fieldNode(
        'provider-name',
        'NAME',
        providerLeafPath(concrete, provider.id, 'name'),
        concrete,
        provider.name ?? '未设置',
        batch,
        '显示名',
      ),
      fieldNode(
        'provider-base',
        'BASE URL',
        providerLeafPath(concrete, provider.id, 'baseUrl'),
        concrete,
        provider.baseUrl ?? '未设置',
        batch,
        '基础地址',
      ),
    );
  } else {
    nodes.push({
      key: 'provider-map',
      label: 'PROVIDER',
      value: provider.id,
      meta: '嵌套方言无效，条目只读',
      tone: 'danger',
    });
  }
  nodes.push({
    key: 'provider-credential',
    label: 'CREDENTIAL',
    value: credentialLabel(provider.credentialStatus),
    meta: '凭据字段不显示具体值，也不在界面中编辑',
    tone: provider.credentialStatus === 'inline' ? 'muted' : 'read',
  });
  return nodes;
}

export function modelLineage(
  source: SourceDocument,
  provider: ProviderEntry,
  model: ModelEntry,
  batch: Batch | null,
): LineageNode[] {
  const dialect = providerDialectForPath(source, provider);
  const nodes: LineageNode[] = [fileNode(source, 'model')];
  if (!isConcreteDialect(dialect)) {
    nodes.push({
      key: 'model-unavailable',
      label: 'MODEL',
      value: model.id,
      meta: '嵌套结构无效，无法生成可编辑路径',
      tone: 'danger',
    });
    return nodes;
  }
  const locator = locateModel(provider, model);
  const root = modelRoot(dialect, locator);
  nodes.push(
    {
      key: 'model-provider',
      label: 'PROVIDER',
      value: formatPath(providerRoot(dialect, provider.id), dialect),
      meta: dialectLabel(provider.dialect),
      tone: 'read',
    },
    {
      key: 'model-root',
      label: 'MODEL KEY',
      value: formatPath(root, dialect),
      meta: model.requestId ? `请求 ID ${model.requestId}` : '未设置请求 ID',
      tone: 'read',
    },
    fieldNode('model-name', 'NAME', modelLeafPath(dialect, locator, 'name'), dialect, model.name ?? '未设置', batch, '显示名'),
    fieldNode(
      'model-context',
      'CONTEXT',
      modelLeafPath(dialect, locator, 'context'),
      dialect,
      formatTokens(model.context),
      batch,
      '上下文窗口',
    ),
    fieldNode(
      'model-input',
      'LIMIT.INPUT',
      modelLeafPath(dialect, locator, 'input'),
      dialect,
      formatTokens(model.input),
      batch,
      '输入上限',
    ),
    fieldNode(
      'model-output',
      'LIMIT.OUTPUT',
      modelLeafPath(dialect, locator, 'output'),
      dialect,
      formatTokens(model.output),
      batch,
      '输出上限',
    ),
    fieldNode(
      'model-reasoning',
      'REASONING',
      modelLeafPath(dialect, locator, 'reasoning'),
      dialect,
      describeReasoning(model.reasoning),
      batch,
      '推理标记',
    ),
    fieldNode(
      'model-variants',
      'VARIANTS',
      modelLeafPath(dialect, locator, 'variants'),
      dialect,
      compactValue(model.variants, 56),
      batch,
      '变体定义',
    ),
  );
  if (source.defaultModel === `${provider.id}/${model.id}`) {
    nodes.push({
      key: 'model-default',
      label: 'DEFAULT',
      value: source.defaultModel,
      meta: '当前顶层默认模型',
      tone: 'read',
      tag: '默认',
    });
  }
  return nodes;
}

export function fieldToneLabel(node: LineageNode): string | undefined {
  return node.tag;
}

import type { ProviderEntry, SourceDocument } from '../ipc';
import { DEMO_WRITE_BLOCKED } from '../ipc';
import { dialectLabel, isModelDefault } from './format';
import type { WorkbenchState, View } from './store';
import { countModels } from './store';

export type CheckSeverity = 'error' | 'warning' | 'info';

export interface CheckAction {
  view: View;
  providerId?: string;
  modelId?: string;
}

export interface CheckItem {
  id: string;
  severity: CheckSeverity;
  title: string;
  scope: string;
  detail: string;
  sourcePath?: string;
  action?: CheckAction;
}

const SEVERITY_ORDER: Record<CheckSeverity, number> = { error: 0, warning: 1, info: 2 };

function providerCheckScope(provider: ProviderEntry): string {
  return `${dialectLabel(provider.dialect)} · ${provider.id}`;
}

export function buildChecks(state: WorkbenchState): CheckItem[] {
  const checks: CheckItem[] = [];
  const snapshot = state.snapshot;
  if (state.mode === 'demo') {
    checks.push({
      id: 'demo-mode',
      severity: 'info',
      title: '浏览器演示模式',
      scope: '工作区',
      detail: DEMO_WRITE_BLOCKED,
    });
  }
  if (!snapshot) {
    checks.push({
      id: 'no-snapshot',
      severity: 'info',
      title: '尚未扫描工作区',
      scope: '工作区',
      detail: '扫描全局或项目后，这里会列出结构、目录与草稿检查。',
    });
    return checks;
  }
  if (state.scanError) {
    checks.push({
      id: 'scan-error',
      severity: 'error',
      title: '扫描失败',
      scope: '工作区',
      detail: state.scanError,
    });
  }
  snapshot.warnings.forEach((warning, index) => {
    checks.push({
      id: `workspace-warning-${index}`,
      severity: 'warning',
      title: '工作区提示',
      scope: '工作区',
      detail: warning,
    });
  });
  if (snapshot.sources.length === 0) {
    checks.push({
      id: 'no-sources',
      severity: 'info',
      title: '未发现配置源',
      scope: '工作区',
      detail: '可以扫描项目目录，或显式载入 JSON / JSONC 配置源。',
    });
  }

  snapshot.sources.forEach((source) => {
    const path = source.path;
    const shortPath = path.length > 58 ? `…${path.slice(-56)}` : path;
    source.warnings.forEach((warning, index) => {
      checks.push({
        id: `source-warning:${path}:${index}`,
        severity: source.dialect === 'invalid' ? 'error' : 'warning',
        title: '配置源告警',
        scope: shortPath,
        detail: warning,
        sourcePath: path,
        action: { view: 'sources' },
      });
    });
    if (source.dialect === 'invalid') {
      checks.push({
        id: `source-invalid:${path}`,
        severity: 'error',
        title: '配置源结构无效',
        scope: shortPath,
        detail: '嵌套结构无法安全定位，界面将该配置源视为只读。',
        sourcePath: path,
        action: { view: 'sources' },
      });
    } else if (source.dialect === 'ambiguous') {
      checks.push({
        id: `source-ambiguous:${path}`,
        severity: 'warning',
        title: '顶层方言待定',
        scope: shortPath,
        detail: '新建提供方时必须明确写入 provider（V1）还是 providers（V2）。',
        sourcePath: path,
        action: { view: 'sources' },
      });
    } else if (source.dialect === 'mixed') {
      checks.push({
        id: `source-mixed:${path}`,
        severity: 'info',
        title: '顶层 V1 / V2 并存',
        scope: shortPath,
        detail: '并存本身不视为损坏；按各提供方自身的方言编辑，新建提供方需指定目标映射。',
        sourcePath: path,
        action: { view: 'sources' },
      });
    }
    if (!source.writable) {
      checks.push({
        id: `source-readonly:${path}`,
        severity: 'info',
        title: '只读配置源',
        scope: shortPath,
        detail: '该文件只能查看，预演与应用入口会保持禁用。',
        sourcePath: path,
        action: { view: 'sources' },
      });
    }
    if (source.defaultModel) {
      const [providerId, ...rest] = source.defaultModel.split('/');
      const modelId = rest.join('/');
      const provider = source.providers.find((entry) => entry.id === providerId);
      const exists = Boolean(provider?.models.some((model) => model.id === modelId));
      if (!exists) {
        checks.push({
          id: `default-missing:${path}`,
          severity: 'warning',
          title: '默认模型指向未发现的条目',
          scope: shortPath,
          detail: `顶层 model 为 ${source.defaultModel}，但该提供方 / 模型不在当前文档中。`,
          sourcePath: path,
          action: { view: 'models' },
        });
      }
    }
    source.providers.forEach((provider) => {
      const scope = `${shortPath} · ${provider.id}`;
      if (provider.dialect === 'invalid') {
        checks.push({
          id: `provider-invalid:${path}:${provider.id}`,
          severity: 'error',
          title: '嵌套提供方结构无效',
          scope,
          detail: '该条目只读；可查看标识与凭据状态，但不能编辑字段。',
          sourcePath: path,
          action: { view: 'providers', providerId: provider.id },
        });
        return;
      }
      if (!provider.name) {
        checks.push({
          id: `provider-name:${path}:${provider.id}`,
          severity: 'warning',
          title: '提供方缺少显示名',
          scope: providerCheckScope(provider),
          detail: '显示名通常用于界面选择器；可在详情中只改 name 叶子字段。',
          sourcePath: path,
          action: { view: 'providers', providerId: provider.id },
        });
      }
      if (!provider.baseUrl) {
        checks.push({
          id: `provider-base:${path}:${provider.id}`,
          severity: 'warning',
          title: '提供方基础地址不可见',
          scope: providerCheckScope(provider),
          detail:
            '基础地址未提供或无法安全展示，请查看配置源告警；内置供应商也可能使用默认端点。界面不做运行时推断。',
          sourcePath: path,
          action: { view: 'providers', providerId: provider.id },
        });
      }
      if (provider.credentialStatus === 'inline') {
        checks.push({
          id: `provider-inline-credential:${path}:${provider.id}`,
          severity: 'info',
          title: '内联凭据不可编辑',
          scope: providerCheckScope(provider),
          detail:
            '该提供方在配置中内联了凭据；界面不接收、不显示、不修改具体值。手动拉取清单时仅由后端解析已有凭证。',
          sourcePath: path,
          action: { view: 'providers', providerId: provider.id },
        });
      }
      if (provider.models.length === 0) {
        checks.push({
          id: `provider-no-models:${path}:${provider.id}`,
          severity: 'warning',
          title: '提供方下没有模型',
          scope: providerCheckScope(provider),
          detail: '可以新建模型，或通过「手动抓取清单」查看提供方实际返回的模型标识。',
          sourcePath: path,
          action: { view: 'providers', providerId: provider.id },
        });
      }
      const thin = provider.models.filter(
        (model) => model.name === null && model.context === null && model.output === null,
      );
      if (thin.length > 0) {
        checks.push({
          id: `model-thin:${path}:${provider.id}`,
          severity: 'info',
          title: `${thin.length} 个模型只有标识`,
          scope: providerCheckScope(provider),
          detail: `缺少名称与令牌上限：${thin.map((model) => model.id).join('、')}。可用目录建议补充元数据，但不会写入请求 ID。`,
          sourcePath: path,
          action: { view: 'models', providerId: provider.id, modelId: thin[0]?.id },
        });
      }
    });
  });

  if (!state.catalog) {
    checks.push({
      id: 'catalog-empty',
      severity: 'info',
      title: '模型目录未载入',
      scope: '本地目录',
      detail: '刷新目录后才能使用本地候选匹配与建议元数据。',
    });
  } else {
    if (state.catalog.stale) {
      checks.push({
        id: 'catalog-stale',
        severity: 'warning',
        title: '模型目录缓存可能过期',
        scope: '本地目录',
        detail: `缓存时间 ${state.catalog.fetchedAt}；可刷新目录获取新结果。`,
      });
    }
    state.catalog.warnings.forEach((warning, index) => {
      checks.push({
        id: `catalog-warning:${index}`,
        severity: 'warning',
        title: '模型目录提示',
        scope: '本地目录',
        detail: warning,
      });
    });
  }

  Object.values(state.batches).forEach((batch) => {
    checks.push({
      id: `drafts:${batch.sourcePath}`,
      severity: 'info',
      title: `存在 ${batch.edits.length} 条未应用草稿`,
      scope: batch.sourcePath,
      detail: '草稿只存在于当前会话；预演通过后才会写入磁盘，重新扫描会清空草稿。',
      sourcePath: batch.sourcePath,
    });
  });

  return checks.sort((left, right) => {
    const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (severity !== 0) return severity;
    return left.title.localeCompare(right.title, 'zh-CN');
  });
}

export interface WorkspaceStats {
  sources: number;
  providers: number;
  models: number;
  writes: number;
  actionable: number;
}

export function workspaceStats(state: WorkbenchState): WorkspaceStats {
  const sources = state.snapshot?.sources ?? [];
  const providers = sources.reduce((total, source) => total + source.providers.length, 0);
  const models = sources.reduce((total, source) => total + countModels(source), 0);
  const checks = buildChecks(state);
  return {
    sources: sources.length,
    providers,
    models,
    writes: sources.filter((source) => source.writable).length,
    actionable: checks.filter((check) => check.severity !== 'info').length,
  };
}

export function checkSeverityCount(checks: CheckItem[], severity: CheckSeverity): number {
  return checks.filter((check) => check.severity === severity).length;
}

export function defaultModelStatus(source: SourceDocument): string {
  if (!source.defaultModel) return '未声明默认模型';
  const [providerId] = source.defaultModel.split('/');
  const provider = source.providers.find((entry) => entry.id === providerId);
  if (provider?.models.some((model) => isModelDefault(source, providerId, model.id))) {
    return source.defaultModel;
  }
  return `${source.defaultModel}（未匹配）`;
}

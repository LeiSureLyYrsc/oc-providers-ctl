import type { Backend, ChangePreview, Edit, ModelCandidate, ProviderInventory } from '../ipc';
import { DEMO_WRITE_BLOCKED } from '../ipc';
import {
  DEMO_CATALOG,
  DEMO_INVENTORIES,
  demoLoad,
  demoMatch,
  demoScan,
} from './fixtures';
import { formatPath, resolveCurrentValue } from '../lib/paths';
import { compactValue, maskSecretsInDiff, shortHash } from '../lib/format';

let previewCounter = 0;

export function resetDemoPreviewCounter(): void {
  previewCounter = 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return compactValue(value, 120);
}

function buildDemoPreview(path: string, expectedHash: string, edits: Edit[]): ChangePreview {
  const source = demoLoad(path);
  if (source.hash !== expectedHash) {
    throw new Error('配置源哈希与预演基准不一致。请重新扫描载入后再试。');
  }
  const lines: string[] = [
    '=== 演示示意差异 · 由草稿生成 ===',
    `目标: ${path}`,
    `基准哈希: ${shortHash(source.hash, 16)}`,
    `编辑: ${edits.length} 处`,
    '说明: 以下按草稿路径与当前 DTO 读取值生成示意，不是文件字节级 diff，也未读取磁盘。',
    '',
  ];
  edits.forEach((edit) => {
    const rendered = formatPath(edit.path, source.dialect);
    const current = resolveCurrentValue(source, edit.path);
    if (edit.op === 'set') {
      if (current.found) {
        lines.push(`~ ${rendered}`);
        lines.push(`- 读取  ${renderValue(current.value)}`);
      } else {
        lines.push(`+ ${rendered}`);
        lines.push('- 读取  未设置');
      }
      lines.push(`+ 草稿  ${renderValue(edit.value)}`);
    } else {
      lines.push(`- ${rendered}`);
      lines.push(`  读取  ${current.found ? renderValue(current.value) : '未设置'}`);
    }
  });
  previewCounter += 1;
  return {
    previewId: `demo-preview-${previewCounter}`,
    path,
    diff: maskSecretsInDiff(lines.join('\n')),
    warnings: [
      '演示预演由前端生成，仅用于查看草稿意图；不代表真实文件字节差异。',
      '演示模式不会创建备份，也不会写入磁盘。',
    ],
    editCount: edits.length,
  };
}

export const demoBackend: Backend = {
  async scanConfigs(projectPath) {
    await delay(80);
    return demoScan(projectPath);
  },
  async loadConfig(path) {
    return demoLoad(path);
  },
  async previewChanges(path, expectedHash, edits) {
    return buildDemoPreview(path, expectedHash, edits);
  },
  async applyChanges() {
    throw new Error(DEMO_WRITE_BLOCKED);
  },
  async restoreBackup() {
    throw new Error('演示模式没有本进程创建的备份，也不能恢复磁盘文件。');
  },
  async fetchCatalog() {
    await delay(220);
    return { ...DEMO_CATALOG, warnings: [...DEMO_CATALOG.warnings] };
  },
  async matchModels(query, providerId): Promise<ModelCandidate[]> {
    return demoMatch(query, providerId);
  },
  async fetchProviderModels(_path, providerId): Promise<ProviderInventory> {
    await delay(180);
    const inventory = DEMO_INVENTORIES[providerId];
    if (!inventory) {
      throw new Error(`演示清单中没有提供方 ${providerId} 的可用清单。`);
    }
    return {
      ...inventory,
      modelIds: [...inventory.modelIds],
      warnings: [...inventory.warnings],
    };
  },
};

export interface SummaryEdit {
  op: 'set' | 'remove';
  path: string[];
  value?: unknown;
  label?: string;
}

const LEAF_LABELS: Record<string, string> = {
  name: '名称',
  context: '上下文',
  input: '输入上限',
  output: '输出上限',
  reasoning: '推理',
  variants: '变体',
  baseURL: '基础地址',
  settings: '设置',
  capabilities: '推理',
  model: '默认模型',
};

export interface SummaryLine {
  op: 'set' | 'remove';
  target: string;
  value?: string;
}

function humanLeaf(segment: string): string {
  return LEAF_LABELS[segment] ?? segment;
}

/** Reads staged edit paths, never the diff text, so native and demo agree. */
export function describeEdits(edits: SummaryEdit[]): SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const edit of edits) {
    const path = edit.path;
    if (path.length === 0) continue;

    if (path.length === 1 && path[0] === 'model') {
      lines.push({
        op: edit.op,
        target: edit.op === 'set' ? '默认模型' : '清除默认模型',
        value: edit.op === 'set' ? formatValue(edit.value) : undefined,
      });
      continue;
    }

    const map = path[0];
    if (map !== 'provider' && map !== 'providers') continue;
    const providerId = path[1] ?? '';
    const rest = path.slice(2);

    // Whole provider create / delete.
    if (rest.length === 0) {
      lines.push({
        op: edit.op,
        target: edit.op === 'set' ? `新增供应商 ${providerId}` : `删除供应商 ${providerId}`,
      });
      continue;
    }

    // Provider-level leaves (name, options/settings.baseURL).
    if (rest[0] !== 'models') {
      const leaf = rest[rest.length - 1];
      lines.push({
        op: edit.op,
        target: `${providerId} › ${humanLeaf(leaf)}`,
        value: edit.op === 'set' ? formatValue(edit.value) : undefined,
      });
      continue;
    }

    const modelId = rest[1] ?? '';
    const tail = rest.slice(2);

    // Whole model create / delete.
    if (tail.length === 0) {
      lines.push({
        op: edit.op,
        target:
          edit.op === 'set'
            ? `新增模型 ${providerId} › ${modelId}`
            : `删除模型 ${providerId} › ${modelId}`,
      });
      continue;
    }

    const leaf = tail[tail.length - 1];
    lines.push({
      op: edit.op,
      target: `${providerId} › ${modelId} › ${humanLeaf(leaf)}`,
      value: edit.op === 'set' ? formatValue(edit.value, leaf) : undefined,
    });
  }
  return lines;
}

function formatValue(value: unknown, leaf?: string): string {
  if (value === null || value === undefined) return '（空）';
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (typeof value === 'number') {
    const formatted = new Intl.NumberFormat('en-US').format(value);
    return leaf && (leaf === 'context' || leaf === 'input' || leaf === 'output')
      ? `${formatted} token`
      : formatted;
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.supported === 'boolean') {
      const effort = Array.isArray(record.effort)
        ? (record.effort as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : [];
      const budget = record.budget;
      const hasBudget =
        budget !== null && typeof budget === 'object' && !Array.isArray(budget) &&
        ('min' in budget || 'max' in budget);
      const parts = [record.supported ? '支持' : '不支持'];
      if (effort.length > 0) parts.push(`档位 ${effort.join('/')}`);
      if (hasBudget) parts.push('含预算');
      return parts.join(' · ');
    }
    try {
      const text = JSON.stringify(value);
      return text.length > 60 ? `${text.slice(0, 57)}…` : text;
    } catch {
      return '已有内容';
    }
  }
  return String(value);
}

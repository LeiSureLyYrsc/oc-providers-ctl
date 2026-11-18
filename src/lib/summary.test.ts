import { describe, expect, it } from 'vitest';
import { describeEdits } from './summary';

/**
 * The Rust core renders its semantic summary as:
 *   ~ set providers.x.models.y.limit.context = 333333
 *   - remove providers.x.models.y.name
 * The dialog must never show that text as a target; it reads staged edits instead.
 */
const NATIVE_DIFF = [
  '--- C:\\Users\\demo\\opencode.jsonc',
  '+++ semantic change preview (credential values are masked)',
  '~ set providers.gateway.models.upstream/coder.limit.context = 333333',
  '- remove providers.gateway.models.upstream/coder.name',
  '~ set model = "gateway/upstream/coder"',
].join('\n');

describe('preview summary from staged edits', () => {
  it('renders V2 model leaves with Chinese labels and the new value', () => {
    const lines = describeEdits([
      {
        op: 'set',
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'limit', 'context'],
        value: 333333,
      },
    ]);
    expect(lines).toEqual([
      { op: 'set', target: 'gateway › upstream/coder › 上下文', value: '333333' },
    ]);
    expect(JSON.stringify(lines)).not.toContain('set providers');
  });

  it('labels removals and provider-level leaves', () => {
    const lines = describeEdits([
      { op: 'remove', path: ['providers', 'gateway', 'models', 'upstream/coder', 'name'] },
      { op: 'set', path: ['providers', 'gateway', 'settings', 'baseURL'], value: 'https://a.test' },
      { op: 'set', path: ['model'], value: 'gateway/upstream/coder' },
    ]);
    expect(lines[0]).toEqual({ op: 'remove', target: 'gateway › upstream/coder › 名称' });
    expect(lines[1]).toEqual({
      op: 'set',
      target: 'gateway › 基础地址',
      value: 'https://a.test',
    });
    expect(lines[2]).toEqual({
      op: 'set',
      target: '默认模型',
      value: 'gateway/upstream/coder',
    });
  });

  it('summarises V1 paths and reasoning objects without raw JSON noise', () => {
    const lines = describeEdits([
      { op: 'set', path: ['provider', 'zhipu', 'models', 'glm-4.6', 'limit', 'output'], value: 131072 },
      {
        op: 'set',
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'capabilities', 'reasoning'],
        value: { supported: true, effort: ['low', 'high'] },
      },
      { op: 'set', path: ['providers', 'new-vendor'], value: { models: {} } },
    ]);
    expect(lines[0].target).toBe('zhipu › glm-4.6 › 输出上限');
    expect(lines[1].value).toBe('支持 · 档位 low/high');
    expect(lines[2].target).toBe('新增供应商 new-vendor');
  });

  it('does not treat the native diff as the source of truth', () => {
    // Guards the regression: parsing the diff produced "set providers…" targets.
    const fromDiff = NATIVE_DIFF.split('\n').filter((line) => /^[-+~]\s+set providers/.test(line));
    expect(fromDiff).toHaveLength(1);
    const lines = describeEdits([
      {
        op: 'set',
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'limit', 'context'],
        value: 333333,
      },
    ]);
    expect(lines.map((line) => line.target)).not.toContain(expect.stringContaining('set providers'));
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/dom';
import { App } from '../workbench/App';
import type { Backend, Edit } from '../ipc';
import { V2_NATIVE_SOURCE, makeCandidate, makePreview, snapshotOf } from './fixtures';

function backendWith(overrides: Partial<Backend> = {}): Backend {
  return {
    scanConfigs: vi.fn(async () => snapshotOf([V2_NATIVE_SOURCE], 'C:\\work')),
    loadConfig: vi.fn(async () => V2_NATIVE_SOURCE),
    previewChanges: vi.fn(async (path: string) => makePreview(path)),
    applyChanges: vi.fn(async () => V2_NATIVE_SOURCE),
    restoreBackup: vi.fn(async () => V2_NATIVE_SOURCE),
    fetchCatalog: vi.fn(async () => ({
      modelCount: 42,
      fetchedAt: '2026-11-17T09:40:00Z',
      stale: false,
      warnings: [],
    })),
    matchModels: vi.fn(async () => [makeCandidate()]),
    fetchProviderModels: vi.fn(async () => ({
      providerId: 'gateway',
      modelIds: [],
      fetchedAt: '2026-11-17T09:40:00Z',
      warnings: [],
    })),
    ...overrides,
  };
}

async function openModelEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Upstream Coder/ }));
  await user.click(await screen.findByRole('button', { name: '编辑' }));
  return waitFor(() => screen.getByRole('dialog'));
}

function stagedEdits(backend: Backend): Edit[] {
  const calls = (backend.previewChanges as ReturnType<typeof vi.fn>).mock.calls;
  return calls[0][2] as Edit[];
}

async function saveAndPreview(user: ReturnType<typeof userEvent.setup>, backend: Backend) {
  await waitFor(() =>
    expect(screen.getByRole('region', { name: '未保存的修改' })).toBeInTheDocument(),
  );
  await user.click(screen.getByRole('button', { name: '保存…' }));
  await waitFor(() => expect(backend.previewChanges).toHaveBeenCalledTimes(1));
}

describe('model editor: token limits', () => {
  it('shows grouped token feedback and stages plain integers', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    const context = within(dialog).getByLabelText('上下文长度') as HTMLInputElement;
    await user.clear(context);
    await user.type(context, '262144');
    expect(within(dialog).getByText('= 262,144 token')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);

    expect(stagedEdits(backend)).toEqual([
      {
        op: 'set',
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'limit', 'context'],
        value: 262144,
      },
    ]);
  });

  it('blocks shorthand token values instead of silently rounding', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    const output = within(dialog).getByLabelText('输出上限') as HTMLInputElement;
    await user.clear(output);
    await user.type(output, '32k');
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));

    expect(within(dialog).getByText(/输出上限需要是非负整数 token/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '未保存的修改' })).toBeNull();
  });

  it('blocks an inverted reasoning budget', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    const min = within(dialog).getByLabelText('预算下限') as HTMLInputElement;
    const max = within(dialog).getByLabelText('预算上限') as HTMLInputElement;
    await user.clear(min);
    await user.type(min, '9000');
    await user.clear(max);
    await user.type(max, '100');
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));

    expect(within(dialog).getAllByText(/预算下限不能大于上限/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: '未保存的修改' })).toBeNull();
  });
});

describe('model editor: reasoning', () => {
  it('subtracts effort and budget when the capability is switched off', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '不支持' }));
    expect(within(dialog).getByText(/只写入 supported: false/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);

    const reasoning = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.value).toEqual({ supported: false });
  });

  it('never invents effort when only support is declared', async () => {
    const user = userEvent.setup();
    const noReasoning = {
      ...V2_NATIVE_SOURCE,
      providers: [
        {
          ...V2_NATIVE_SOURCE.providers[0],
          models: [{ ...V2_NATIVE_SOURCE.providers[0].models[0], reasoning: null }],
        },
      ],
    };
    const backend = backendWith({
      scanConfigs: vi.fn(async () => snapshotOf([noReasoning])),
      loadConfig: vi.fn(async () => noReasoning),
      matchModels: vi.fn(async () => [makeCandidate({ reasoning: { supported: true } })]),
    });
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '查询模型资料' }));
    const fill = await screen.findByRole('button', { name: /填入所选/ });
    // Only the reasoning row has anything to offer for this empty model.
    expect(fill).toBeEnabled();
    await user.click(fill);

    await waitFor(() => expect(screen.queryByRole('button', { name: '返回编辑' })).toBeNull());
    const effort = within(dialog).getByLabelText('推理档位') as HTMLInputElement;
    expect(effort.value).toBe('');
    expect(within(dialog).getByText(/目录只声明支持时不会自动生成档位/)).toBeInTheDocument();
  });

  it('keeps effort and budget together and warns instead of dropping the budget', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    const effort = within(dialog).getByLabelText('推理档位') as HTMLInputElement;
    await user.clear(effort);
    await user.type(effort, 'medium');
    expect(within(dialog).getByText(/OpenCode 设置了档位时会忽略预算/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);

    const reasoning = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'reasoning');
    // The stored budget is kept, not silently cleared, while effort changes.
    expect(reasoning?.value).toEqual({
      supported: true,
      toggle: true,
      effort: ['medium'],
      budget: { min: 0, max: 8192 },
    });
  });

  it('deletes stale fields when the user clears them', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    const effort = within(dialog).getByLabelText('推理档位') as HTMLInputElement;
    expect(effort.value).toBe('low, high');
    await user.clear(effort);
    expect(within(dialog).getByText(/会移除原档位 low \/ high/)).toBeInTheDocument();

    const min = within(dialog).getByLabelText('预算下限') as HTMLInputElement;
    const max = within(dialog).getByLabelText('预算上限') as HTMLInputElement;
    await user.clear(min);
    await user.clear(max);
    expect(within(dialog).getByText(/保存后会移除原有的 min/)).toBeInTheDocument();

    const toggleOff = within(dialog).getByRole('button', { name: '不写入' });
    await user.click(toggleOff);

    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);

    const reasoning = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.value).toEqual({ supported: true });
  });

  it('carries unsaved form edits into the JSON view and back', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    const effort = within(dialog).getByLabelText('推理档位') as HTMLInputElement;
    await user.clear(effort);
    await user.type(effort, 'minimal');
    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));

    const json = within(dialog).getByLabelText('思考设置 JSON') as HTMLTextAreaElement;
    expect(json.value).toContain('minimal');

    await user.click(within(dialog).getByRole('button', { name: '收起高级' }));
    const back = within(dialog).getByLabelText('推理档位') as HTMLInputElement;
    expect(back.value).toBe('minimal');
  });

  it('preserves unknown reasoning keys through the JSON round trip', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    const json = within(dialog).getByLabelText('思考设置 JSON') as HTMLTextAreaElement;
    fireEvent.change(json, {
      target: { value: '{"supported": true, "custom": {"keep": 1}}' },
    });
    await user.click(within(dialog).getByRole('button', { name: '收起高级' }));
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);

    const reasoning = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.value).toMatchObject({ supported: true, custom: { keep: 1 } });
  });

  it('keeps V1 on the boolean path and points at V2 for full capability', async () => {
    const { V1_NATIVE_SOURCE } = await import('./fixtures');
    const user = userEvent.setup();
    const backend = backendWith({
      scanConfigs: vi.fn(async () => snapshotOf([V1_NATIVE_SOURCE])),
      loadConfig: vi.fn(async () => V1_NATIVE_SOURCE),
    });
    render(<App mode="native" backend={backend} />);
    await user.click(await screen.findByRole('button', { name: /GLM-4.6/ }));
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    const dialog = await waitFor(() => screen.getByRole('dialog'));

    expect(within(dialog).getByText(/档位和预算需要 V2/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('推理档位')).toBeNull();
    expect(within(dialog).queryByLabelText('推理档位')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: '不支持' }));
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);

    const reasoning = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning).toEqual({ op: 'set', path: ['provider', 'zhipu', 'models', 'glm-4.6', 'reasoning'], value: false });
    expect(stagedEdits(backend).some((edit) => edit.path.includes('variants'))).toBe(false);
  });
});

describe('model editor: catalog fill', () => {
  it('queries by request id and only fills confirmed fields without touching ids', async () => {
    const user = userEvent.setup();
    const backend = backendWith({
      matchModels: vi.fn(async () => [
        makeCandidate({
          name: 'Renamed Coder',
          context: 400000,
          input: null,
          output: 32768,
        }),
      ]),
    });
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '查询模型资料' }));
    await waitFor(() => expect(backend.matchModels).toHaveBeenCalled());
    const [query, providerId] = (backend.matchModels as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(query).toBe('vendor-request-id-42');
    expect(providerId).toBe('gateway');

    const fill = await screen.findByRole('button', { name: /填入所选/ });
    expect(fill).toBeDisabled(); // every differing field already has a value

    const contextCheck = screen.getByLabelText('覆盖上下文') as HTMLInputElement;
    await user.click(contextCheck);
    await user.click(screen.getByRole('button', { name: /填入所选/ }));

    await waitFor(() => expect(screen.queryByRole('button', { name: '返回编辑' })).toBeNull());
    expect((within(dialog).getByLabelText('上下文长度') as HTMLInputElement).value).toBe('400000');
    // Unconfirmed fields keep their stored values.
    expect((within(dialog).getByLabelText('显示名称（可选）') as HTMLInputElement).value).toBe(
      'Upstream Coder',
    );
    // Search/return to the form did not stage anything yet.
    expect(backend.previewChanges).not.toHaveBeenCalled();

    // The eventual save still only writes the edited leaf.
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);
    expect(stagedEdits(backend)).toEqual([
      {
        op: 'set',
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'limit', 'context'],
        value: 400000,
      },
    ]);
  });

  it('pre-selects only empty fields so a plain confirm never overwrites', async () => {
    const user = userEvent.setup();
    const backend = backendWith({
      matchModels: vi.fn(async () => [makeCandidate({ input: 180000, output: 32768 })]),
    });
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '查询模型资料' }));
    await waitFor(() => screen.getByLabelText('覆盖上下文'));
    // context/input/output all already have values in the fixture -> nothing selected.
    expect((screen.getByLabelText('覆盖上下文') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('覆盖输出上限') as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByText('相同').length).toBeGreaterThan(0);
  });

  it('keeps unknown catalog values out and reports failures without losing the form', async () => {
    const user = userEvent.setup();
    const backend = backendWith({
      matchModels: vi.fn(async () => {
        throw '目录不可用';
      }),
    });
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    const context = within(dialog).getByLabelText('上下文长度') as HTMLInputElement;
    await user.clear(context);
    await user.type(context, '999');
    await user.click(within(dialog).getByRole('button', { name: '查询模型资料' }));

    await waitFor(() => screen.getByText('目录不可用'));
    await user.click(screen.getByRole('button', { name: '返回编辑' }));
    expect((within(dialog).getByLabelText('上下文长度') as HTMLInputElement).value).toBe('999');
  });

  it('lets a read-only file query but not stage', async () => {
    const user = userEvent.setup();
    const readOnly = { ...V2_NATIVE_SOURCE, writable: false };
    const backend = backendWith({
      scanConfigs: vi.fn(async () => snapshotOf([readOnly])),
      loadConfig: vi.fn(async () => readOnly),
      matchModels: vi.fn(async () => [makeCandidate({ context: 400000 })]),
    });
    render(<App mode="native" backend={backend} />);
    await user.click(await screen.findByRole('button', { name: /Upstream Coder/ }));
    await user.click(await screen.findByRole('button', { name: '从模型目录查找' }));

    const dialog = await screen.findByRole('dialog', { name: '查询模型资料' });
    await waitFor(() => expect(backend.matchModels).toHaveBeenCalled());
    await user.click(await within(dialog).findByLabelText('覆盖上下文'));
    expect(within(dialog).getByRole('button', { name: /填入所选/ })).toBeDisabled();
    expect(within(dialog).getByText(/可以查询，但不能写入/)).toBeInTheDocument();
  });
});

describe('model editor: custom structures', () => {
  it('keeps a non-standard reasoning value when the user only edits the name', async () => {
    const user = userEvent.setup();
    const custom = {
      ...V2_NATIVE_SOURCE,
      providers: [
        {
          ...V2_NATIVE_SOURCE.providers[0],
          models: [
            {
              ...V2_NATIVE_SOURCE.providers[0].models[0],
              reasoning: { vendorMode: 'auto' },
            },
          ],
        },
      ],
    };
    const backend = backendWith({
      scanConfigs: vi.fn(async () => snapshotOf([custom])),
      loadConfig: vi.fn(async () => custom),
    });
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    expect(within(dialog).getByText(/不是标准结构/)).toBeInTheDocument();
    const name = within(dialog).getByLabelText('显示名称（可选）') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Custom Name');
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);

    expect(stagedEdits(backend)).toEqual([
      {
        op: 'set',
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'name'],
        value: 'Custom Name',
      },
    ]);
  });

  it('keeps the JSON view open when the text does not parse', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    const json = within(dialog).getByLabelText('思考设置 JSON') as HTMLTextAreaElement;
    fireEvent.change(json, { target: { value: '{ "supported": true ' } });
    await user.click(within(dialog).getByRole('button', { name: '收起高级' }));

    expect(within(dialog).getByLabelText('思考设置 JSON')).toBeInTheDocument();
    expect(within(dialog).getByText(/JSON 无法解析/)).toBeInTheDocument();
  });

  it('does not fold back to basic when the variants JSON is invalid', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    const variants = within(dialog).getByLabelText('模型变体 JSON') as HTMLTextAreaElement;
    fireEvent.change(variants, { target: { value: '[ { "id": ' } });
    await user.click(within(dialog).getByRole('button', { name: '收起高级' }));

    expect(within(dialog).getByLabelText('模型变体 JSON')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('推理档位')).toBeNull();
  });

  it('saves variants edited in the JSON view after folding back to basic', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    const variants = within(dialog).getByLabelText('模型变体 JSON') as HTMLTextAreaElement;
    fireEvent.change(variants, { target: { value: '[ { "id": "precise" } ]' } });
    await user.click(within(dialog).getByRole('button', { name: '收起高级' }));
    expect(within(dialog).queryByLabelText('模型变体 JSON')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);

    const staged = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'variants');
    expect(staged?.value).toEqual([{ id: 'precise' }]);
  });

  it('keeps a cleared variants block empty after reopening the JSON view', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    const variants = within(dialog).getByLabelText('模型变体 JSON') as HTMLTextAreaElement;
    expect(variants.value).toContain('fast');
    fireEvent.change(variants, { target: { value: '' } });
    await user.click(within(dialog).getByRole('button', { name: '收起高级' }));

    // Reopening must not refill the textarea from the stored model.
    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    const reopened = within(dialog).getByLabelText('模型变体 JSON') as HTMLTextAreaElement;
    expect(reopened.value).toBe('');

    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);

    const staged = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'variants');
    expect(staged).toEqual({
      op: 'remove',
      path: ['providers', 'gateway', 'models', 'upstream/coder', 'variants'],
    });
  });

  it('refuses to collapse advanced when variants are invalid instead of saving stale ones', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    const variants = within(dialog).getByLabelText('模型变体 JSON') as HTMLTextAreaElement;
    fireEvent.change(variants, { target: { value: '{ "oops": ' } });
    await user.click(within(dialog).getByRole('button', { name: '收起高级' }));

    expect(within(dialog).getByLabelText('模型变体 JSON')).toBeInTheDocument();
  });

  it('validates advanced JSON before entering the picker and keeps edits', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    const json = within(dialog).getByLabelText('思考设置 JSON') as HTMLTextAreaElement;
    fireEvent.change(json, {
      target: { value: '{"supported": true, "effort": ["minimal"]}' },
    });
    await user.click(within(dialog).getByRole('button', { name: '查询模型资料' }));

    // Entering the picker folds the JSON back into the basic draft first.
    expect(screen.getByLabelText('搜索模型')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回编辑' }));
    expect((within(dialog).getByLabelText('推理档位') as HTMLInputElement).value).toBe('minimal');

    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);
    const reasoning = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.value).toMatchObject({ supported: true, effort: ['minimal'] });
  });

  it('blocks the picker when advanced JSON cannot be parsed', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    const json = within(dialog).getByLabelText('思考设置 JSON') as HTMLTextAreaElement;
    fireEvent.change(json, { target: { value: '{ "supported": ' } });
    await user.click(within(dialog).getByRole('button', { name: '查询模型资料' }));

    expect(within(dialog).getByLabelText('思考设置 JSON')).toBeInTheDocument();
    expect(screen.queryByLabelText('搜索模型')).toBeNull();
  });

  it('keeps a candidate reasoning value after returning from an advanced query', async () => {
    const user = userEvent.setup();
    const backend = backendWith({
      matchModels: vi.fn(async () => [
        makeCandidate({ reasoning: { supported: true, effort: ['low', 'medium'] } }),
      ]),
    });
    render(<App mode="native" backend={backend} />);
    const dialog = await openModelEditor(user);

    await user.click(within(dialog).getByRole('button', { name: '高级选项' }));
    await user.click(within(dialog).getByRole('button', { name: '查询模型资料' }));
    await user.click(await screen.findByLabelText('覆盖思考能力'));
    await user.click(screen.getByRole('button', { name: /填入所选/ }));

    // Basic form now reflects the candidate levels, and saving uses them.
    expect((within(dialog).getByLabelText('推理档位') as HTMLInputElement).value).toBe(
      'low, medium',
    );
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await saveAndPreview(user, backend);
    const reasoning = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.value).toMatchObject({ supported: true, effort: ['low', 'medium'] });
  });

});

describe('inventory: plain HTTP', () => {
  it('shows the transport warning and provider warnings without a gate', async () => {
    const user = userEvent.setup();
    const plainHttpSource = {
      ...V2_NATIVE_SOURCE,
      providers: [
        {
          ...V2_NATIVE_SOURCE.providers[0],
          baseUrl: 'http://gateway.example/v1?token=secret',
        },
      ],
    };
    const backend = backendWith({
      scanConfigs: vi.fn(async () => snapshotOf([plainHttpSource])),
      loadConfig: vi.fn(async () => plainHttpSource),
      fetchProviderModels: vi.fn(async () => ({
        providerId: 'gateway',
        modelIds: ['upstream/new-model'],
        fetchedAt: '2026-11-17T10:05:00Z',
        warnings: [
          'This request used plain HTTP. The provider response and any credentials were sent without transport encryption and could be observed or modified on the network. Prefer an HTTPS base URL.',
        ],
      })),
    });
    render(<App mode="native" backend={backend} />);
    await user.click(await screen.findByRole('button', { name: /Gateway/ }));
    await user.click(await screen.findByRole('button', { name: '从供应商获取' }));

    const dialog = await screen.findByRole('dialog');
    const notice = await within(dialog).findByText(/这次请求使用明文 HTTP/);
    expect(notice).toBeInTheDocument();
    const note = notice.parentElement as HTMLElement;
    // The English transport warning is folded into the localized notice exactly once.
    expect(note.textContent?.match(/这次请求使用明文 HTTP/g) ?? []).toHaveLength(1);
    expect(within(dialog).queryByText(/This request used plain HTTP/)).toBeNull();
    // Only the origin is shown; the query string never reaches the UI.
    expect(within(dialog).queryByText(/token=secret/)).toBeNull();
    expect(within(dialog).getByText(/http:\/\/gateway\.example/)).toBeInTheDocument();
    // No consent gate: adding stays available as soon as a model is selected.
    const box = await within(dialog).findByLabelText('upstream/new-model');
    await user.click(box);
    expect(within(dialog).getByRole('button', { name: /添加 1 个/ })).toBeEnabled();
  });

  it('renders other backend warnings verbatim without claiming credentials exist', async () => {
    const user = userEvent.setup();
    const backend = backendWith({
      fetchProviderModels: vi.fn(async () => ({
        providerId: 'gateway',
        modelIds: ['upstream/new-model'],
        fetchedAt: '2026-11-17T10:05:00Z',
        warnings: ['The provider rejected the request with status 401.'],
      })),
    });
    render(<App mode="native" backend={backend} />);
    await user.click(await screen.findByRole('button', { name: /Gateway/ }));
    await user.click(await screen.findByRole('button', { name: '从供应商获取' }));

    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText('The provider rejected the request with status 401.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/这次请求使用明文 HTTP/)).toBeNull();
    expect(within(dialog).queryByText(/配置里带凭据/)).toBeNull();
  });
});

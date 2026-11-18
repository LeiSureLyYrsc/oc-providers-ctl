import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('reasoning preservation', () => {
  it('does not restage the reasoning object when only the name changes', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    await openModelEditor(user);

    const nameInput = screen.getByLabelText('显示名称（可选）') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed Coder');
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() =>
      expect(screen.getByRole('region', { name: '未保存的修改' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: '保存…' }));
    await waitFor(() => expect(backend.previewChanges).toHaveBeenCalledTimes(1));

    const edits = stagedEdits(backend);
    expect(edits).toEqual([
      {
        op: 'set',
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'name'],
        value: 'Renamed Coder',
      },
    ]);
  });

  it('merges new effort into the existing object and keeps toggle and budget', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    await openModelEditor(user);

    const effortInput = screen.getByLabelText('推理档位') as HTMLInputElement;
    await user.clear(effortInput);
    await user.type(effortInput, 'medium');
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() =>
      expect(screen.getByRole('region', { name: '未保存的修改' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: '保存…' }));
    await waitFor(() => expect(backend.previewChanges).toHaveBeenCalledTimes(1));

    const reasoning = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.value).toEqual({
      supported: true,
      toggle: true,
      effort: ['medium'],
      budget: { min: 0, max: 8192 },
    });
  });

  it('removes effort and budget when reasoning is switched off', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    await openModelEditor(user);

    await user.click(screen.getByRole('button', { name: '不支持' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() =>
      expect(screen.getByRole('region', { name: '未保存的修改' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: '保存…' }));
    await waitFor(() => expect(backend.previewChanges).toHaveBeenCalledTimes(1));

    const reasoning = stagedEdits(backend).find((edit) => edit.path.at(-1) === 'reasoning');
    expect(reasoning?.value).toEqual({ supported: false });
  });

  it('keeps a new V2 model\'s supported + effort in the created object', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());

    await user.click(await screen.findByRole('button', { name: /添加模型/ }));
    const dialog = await waitFor(() => screen.getByRole('dialog'));

    const idInput = screen.getByLabelText('模型 ID') as HTMLInputElement;
    await user.clear(idInput);
    await user.type(idInput, 'upstream/new-coder');
    await user.click(screen.getByRole('button', { name: '支持' }));
    const effortInput = screen.getByLabelText('推理档位') as HTMLInputElement;
    await user.type(effortInput, 'low, high');
    expect(dialog).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '添加' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: '未保存的修改' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: '保存…' }));
    await waitFor(() => expect(backend.previewChanges).toHaveBeenCalledTimes(1));

    const created = stagedEdits(backend).find(
      (edit) => edit.path[3] === 'upstream/new-coder',
    );
    expect(created?.value).toEqual({
      capabilities: { reasoning: { supported: true, effort: ['low', 'high'] } },
    });
  });
});

describe('catalog', () => {
  it('is never fetched at startup and loads on demand before searching', async () => {
    const user = userEvent.setup();
    const backend = backendWith();
    render(<App mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());
    expect(backend.fetchCatalog).not.toHaveBeenCalled();

    await openModelEditor(user);
    await user.click(screen.getByRole('button', { name: '从模型目录查找' }));
    const catalogDialog = await waitFor(() => screen.findByRole('dialog', { name: '从模型目录查找' }));
    expect(within(catalogDialog).getByText(/还没有载入模型目录/)).toBeInTheDocument();
    expect(within(catalogDialog).getByText('更新目录')).toBeInTheDocument();
    expect(backend.fetchCatalog).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '更新目录' }));
    await waitFor(() => expect(backend.fetchCatalog).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText(/42 个模型/).length).toBeGreaterThan(0));
    await waitFor(() => expect(backend.matchModels).toHaveBeenCalled());
  });

  it('does not invent a cache entry when the refresh fails', async () => {
    const user = userEvent.setup();
    const backend = backendWith({
      fetchCatalog: vi.fn(async () => {
        throw '网络不可用';
      }),
    });
    render(<App mode="native" backend={backend} />);
    await openModelEditor(user);
    await user.click(screen.getByRole('button', { name: '从模型目录查找' }));
    await waitFor(() => screen.getByRole('dialog', { name: '从模型目录查找' }));
    await user.click(screen.getByRole('button', { name: '更新目录' }));
    await waitFor(() => expect(screen.getByText('模型目录刷新失败。')).toBeInTheDocument());
    expect(screen.queryByText(/个模型 ·/)).toBeNull();
  });
});

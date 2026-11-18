import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../workbench/App';
import type { Backend, ChangePreview, SourceDocument } from '../ipc';
import { demoBackend } from '../demo/backend';
import { SECOND_SOURCE, V2_NATIVE_SOURCE, makePreview, snapshotOf } from './fixtures';

function nativeStub(overrides: Partial<Backend> = {}): Backend {
  return {
    scanConfigs: vi.fn(async () => snapshotOf([V2_NATIVE_SOURCE, SECOND_SOURCE], 'C:\\work')),
    loadConfig: vi.fn(async (path: string) =>
      path === V2_NATIVE_SOURCE.path ? V2_NATIVE_SOURCE : SECOND_SOURCE,
    ),
    previewChanges: vi.fn(async (path: string) => makePreview(path)),
    applyChanges: vi.fn(async () => ({ ...V2_NATIVE_SOURCE, hash: 'written-hash' })),
    restoreBackup: vi.fn(async () => ({ ...V2_NATIVE_SOURCE, hash: 'restored-hash' })),
    fetchCatalog: vi.fn(async () => ({
      modelCount: 0,
      fetchedAt: '2026-11-17T09:40:00Z',
      stale: false,
      warnings: [],
    })),
    matchModels: vi.fn(async () => []),
    fetchProviderModels: vi.fn(async () => ({
      providerId: 'gateway',
      modelIds: [],
      fetchedAt: '2026-11-17T09:40:00Z',
      warnings: [],
    })),
    ...overrides,
  };
}

function savebar(): HTMLElement {
  return screen.getByRole('region', { name: '未保存的修改' });
}

async function waitForDialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
}

async function openModelEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Upstream Coder/ }));
  await user.click(await screen.findByRole('button', { name: '编辑' }));
  const dialog = await screen.findByRole('dialog');
  return dialog;
}

async function editContext(user: ReturnType<typeof userEvent.setup>, value: string) {
  const dialog = await openModelEditor(user);
  const input = within(dialog).getByLabelText('上下文长度') as HTMLInputElement;
  await user.clear(input);
  await user.type(input, value);
  await user.click(within(dialog).getByRole('button', { name: '保存修改' }));
  await waitForDialogClosed();
  await waitFor(() => expect(savebar()).toBeInTheDocument());
}

async function addSupplier(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(await screen.findByRole('button', { name: /^添加$/ }));
  const dialog = await screen.findByRole('dialog');
  const idInput = within(dialog).getByLabelText('标识') as HTMLInputElement;
  await user.clear(idInput);
  await user.type(idInput, id);
  await user.click(within(dialog).getByRole('button', { name: '添加' }));
  await waitForDialogClosed();
  await waitFor(() => expect(within(savebar()).getByText(/项修改待保存/)).toBeInTheDocument());
}

describe('demo mode', () => {
  it('never invokes apply, even if the write control is clicked', async () => {
    const user = userEvent.setup();
    const applySpy = vi.spyOn(demoBackend, 'applyChanges');
    render(<App mode="demo" backend={demoBackend} />);

    expect(await screen.findByRole('note')).toBeInTheDocument();
    await addSupplier(user, 'demo-vendor');

    await user.click(within(savebar()).getByRole('button', { name: '保存…' }));
    await screen.findByRole('dialog');
    expect((await screen.findAllByText(/演示预览，不会写入磁盘/)).length).toBeGreaterThan(0);

    const write = screen.getByRole('button', { name: '写入文件' });
    expect(write).toBeDisabled();
    await user.click(write);
    expect(applySpy).not.toHaveBeenCalled();
    expect(screen.queryByText('修改已写入文件。')).not.toBeInTheDocument();
  });
});

describe('native mode', () => {
  it('emits the V2 map-keyed edit and applies only after confirmation', async () => {
    const user = userEvent.setup();
    const backend = nativeStub();
    render(<App mode="native" backend={backend} />);

    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalledWith(null));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    await editContext(user, '262144');
    await user.click(within(savebar()).getByRole('button', { name: '保存…' }));

    await waitFor(() => expect(backend.previewChanges).toHaveBeenCalledTimes(1));
    const [path, hash, edits] = (backend.previewChanges as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe(V2_NATIVE_SOURCE.path);
    expect(hash).toBe(V2_NATIVE_SOURCE.hash);
    expect(edits).toEqual([
      {
        op: 'set',
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'limit', 'context'],
        value: 262144,
      },
    ]);

    const write = await screen.findByRole('button', { name: '写入文件' });
    expect(backend.applyChanges).not.toHaveBeenCalled();
    await user.click(write);
    await waitFor(() => expect(backend.applyChanges).toHaveBeenCalledWith('preview-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('已写入配置文件');
  });

  it('shows a new supplier as pending until it is saved', async () => {
    const user = userEvent.setup();
    const backend = nativeStub();
    render(<App mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());

    await addSupplier(user, 'pending-vendor');
    expect(screen.getAllByText(/待保存|项修改待保存/).length).toBeGreaterThan(0);
  });

  it('refuses to apply when the preview belongs to another file', async () => {
    const user = userEvent.setup();
    const backend = nativeStub({
      previewChanges: vi.fn(async () => makePreview(SECOND_SOURCE.path)),
    });
    render(<App mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());

    await editContext(user, '1024');
    await user.click(within(savebar()).getByRole('button', { name: '保存…' }));
    await waitFor(() => expect(backend.previewChanges).toHaveBeenCalled());

    await user.click(await screen.findByRole('button', { name: '写入文件' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/请重新保存预览/));
    expect(backend.applyChanges).not.toHaveBeenCalled();
  });

  it('freezes edits while a preview is pending and ignores the stale reply', async () => {
    const user = userEvent.setup();
    const deferred: { resolve: (value: ChangePreview) => void } = { resolve: () => undefined };
    const backend = nativeStub({
      previewChanges: vi.fn(
        () =>
          new Promise<ChangePreview>((resolve) => {
            deferred.resolve = resolve;
          }),
      ),
    });
    render(<App mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());

    await editContext(user, '2000');
    await user.click(within(savebar()).getByRole('button', { name: '保存…' }));
    await waitFor(() => expect(backend.previewChanges).toHaveBeenCalledTimes(1));

    // While pending there is no successful preview state to write from.
    const previewDialog = await waitFor(() => screen.getByRole('dialog', { name: '保存修改' }));
    expect(within(previewDialog).getByText(/正在检查修改/)).toBeInTheDocument();
    expect(within(previewDialog).queryByRole('button', { name: '写入文件' })).toBeNull();

    // Switching files discards the pending preview; the late reply is ignored.
    await user.click(within(previewDialog).getByRole('button', { name: '返回修改' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.selectOptions(screen.getByLabelText('选择配置文件'), SECOND_SOURCE.path);
    const discard = await screen.findByRole('dialog');
    await user.click(within(discard).getByRole('button', { name: '丢弃并继续' }));

    deferred.resolve(makePreview(V2_NATIVE_SOURCE.path));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: '写入文件' })).toBeNull();
    expect(backend.applyChanges).not.toHaveBeenCalled();
  });
  it('asks before discarding when switching files with drafts', async () => {
    const user = userEvent.setup();
    const backend = nativeStub();
    render(<App mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());

    await editContext(user, '4096');
    await user.selectOptions(screen.getByLabelText('选择配置文件'), SECOND_SOURCE.path);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('放弃未保存的修改？')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(savebar()).toBeInTheDocument();
  });

  it('disambiguates config names and exposes file problems from the menu', async () => {
    const user = userEvent.setup();
    const broken: SourceDocument = {
      ...SECOND_SOURCE,
      writable: false,
      warnings: ['这一项的结构无法安全识别。'],
    };
    const backend = nativeStub({
      scanConfigs: vi.fn(async () => snapshotOf([V2_NATIVE_SOURCE, broken], 'C:\\work\\acme')),
    });
    render(<App mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());

    const select = screen.getByLabelText('选择配置文件');
    const labels = Array.from(select.querySelectorAll('option')).map((option) => option.textContent);
    expect(labels.some((label) => label?.includes('全局'))).toBe(true);
    expect(labels.some((label) => label?.includes('second.jsonc'))).toBe(true);

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: /配置详情/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('这一项的结构无法安全识别。')).toBeInTheDocument();
    expect(within(dialog).getByText(/只能查看/)).toBeInTheDocument();
  });

  it('disables editing on a read-only file', async () => {
    const user = userEvent.setup();
    const readOnly: SourceDocument = { ...V2_NATIVE_SOURCE, path: 'C:\\ro.jsonc', writable: false, warnings: [] };
    const backend = nativeStub({
      scanConfigs: vi.fn(async () => snapshotOf([V2_NATIVE_SOURCE, readOnly])),
    });
    render(<App mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /编辑供应商/ }).length).toBeGreaterThan(0),
    );

    await user.selectOptions(screen.getByLabelText('选择配置文件'), readOnly.path);
    await waitFor(() => expect(screen.getByRole('button', { name: '添加' })).toBeDisabled());
  });
});

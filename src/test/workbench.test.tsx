import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Workbench } from '../workbench/Workbench';
import type { Backend } from '../ipc';
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

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: '工作台视图' });
}

function tray(): HTMLElement {
  return screen.getByRole('region', { name: '变更台' });
}

function draftCount(): number {
  return tray().querySelectorAll('.draft-row').length;
}

async function openModels() {
  const user = userEvent.setup();
  await user.click(within(nav()).getByRole('button', { name: /模型/ }));
  return user;
}

async function stageContextValue(user: ReturnType<typeof userEvent.setup>, value: string) {
  const input = (await waitFor(
    () => screen.getByLabelText('上下文窗口 / CONTEXT'),
  )) as HTMLInputElement;
  await user.clear(input);
  await user.type(input, value);
  const field = input.closest('.field-editor') as HTMLElement;
  await user.click(within(field).getByRole('button', { name: '设为草稿' }));
}

describe('demo mode', () => {
  it('shows the explicit demo banner and never reports a disk write', async () => {
    const user = userEvent.setup();
    render(<Workbench mode="demo" backend={demoBackend} />);

    expect(await screen.findByRole('note')).toBeInTheDocument();
    await user.click(within(nav()).getByRole('button', { name: /提供方/ }));

    const nameInput = (await waitFor(
      () => screen.getByLabelText('显示名 / NAME'),
    )) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, '演示改名');
    const field = nameInput.closest('.field-editor') as HTMLElement;
    await waitFor(() => expect(nameInput).toHaveValue('演示改名'));
    await user.click(within(field).getByRole('button', { name: '设为草稿' }));
    await waitFor(() => expect(draftCount()).toBe(1));

    await user.click(within(tray()).getByRole('button', { name: /预演变更/ }));
    await waitFor(
      () => expect(within(tray()).getByRole('button', { name: '应用到磁盘' })).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(tray().textContent).toContain('演示示意');
    expect(within(tray()).getByRole('button', { name: '应用到磁盘' })).toBeDisabled();
    expect(within(tray()).getByText(/绝不伪造写盘成功/)).toBeInTheDocument();
    expect(screen.queryByText(/变更已写入磁盘/)).not.toBeInTheDocument();
    expect(draftCount()).toBe(1);
  });
});

describe('native mode', () => {
  it('scans, emits keyed edits, previews, and applies only after confirmation', async () => {
    const backend = nativeStub();
    render(<Workbench mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalledWith(null));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    const user = await openModels();
    await stageContextValue(user, '262144');

    expect(
      within(tray()).getByText('providers.gateway.models["upstream/coder"].limit.context'),
    ).toBeInTheDocument();

    await user.click(within(tray()).getByRole('button', { name: /预演变更/ }));
    await waitFor(() => expect(backend.previewChanges).toHaveBeenCalledTimes(1));
    const previewCall = (backend.previewChanges as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(previewCall[0]).toBe(V2_NATIVE_SOURCE.path);
    expect(previewCall[1]).toBe(V2_NATIVE_SOURCE.hash);
    expect(previewCall[2]).toEqual([
      {
        op: 'set',
        path: ['providers', 'gateway', 'models', 'upstream/coder', 'limit', 'context'],
        value: 262144,
      },
    ]);

    await waitFor(() => expect(within(tray()).getByText(/后端预演/)).toBeInTheDocument());
    await user.click(within(tray()).getByRole('button', { name: '应用到磁盘' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(V2_NATIVE_SOURCE.path)).toBeInTheDocument();
    expect(backend.applyChanges).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '应用并写入' }));
    await waitFor(() => expect(backend.applyChanges).toHaveBeenCalledWith('preview-1'));
    await waitFor(() => expect(within(tray()).getByText(/变更已写入磁盘/)).toBeInTheDocument());
  });

  it('asks before discarding drafts on rescan and keeps them when cancelled', async () => {
    const backend = nativeStub();
    render(<Workbench mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());

    const user = await openModels();
    await stageContextValue(user, '4096');

    await user.click(screen.getByRole('button', { name: '扫描全局' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('重新扫描会丢弃草稿')).toBeInTheDocument();
    expect(backend.scanConfigs).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(draftCount()).toBe(1);
    expect(backend.scanConfigs).toHaveBeenCalledTimes(1);
  });

  it('binds the preview to the active file and rejects a mismatched target', async () => {
    const backend = nativeStub({
      previewChanges: vi.fn(async () => makePreview(SECOND_SOURCE.path)),
    });
    render(<Workbench mode="native" backend={backend} />);
    await waitFor(() => expect(backend.scanConfigs).toHaveBeenCalled());

    const user = await openModels();
    await stageContextValue(user, '1024');
    await user.click(within(tray()).getByRole('button', { name: /预演变更/ }));
    await waitFor(() => expect(backend.previewChanges).toHaveBeenCalled());
    const [path, hash] = (backend.previewChanges as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe(V2_NATIVE_SOURCE.path);
    expect(hash).toBe(V2_NATIVE_SOURCE.hash);

    // Switching files invalidates the preview and cannot apply it.
    await user.selectOptions(screen.getByLabelText('选择当前配置源'), SECOND_SOURCE.path);
    expect(tray().textContent ?? '').not.toContain('应用到磁盘');
    expect(backend.applyChanges).not.toHaveBeenCalled();
  });

  it('shows normalized V2 reasoning and rejects bare booleans in the advanced editor', async () => {
    render(<Workbench mode="native" backend={nativeStub()} />);
    await waitFor(() => expect(tray()).toBeInTheDocument());
    const user = await openModels();

    const reasoning = (await waitFor(
      () => screen.getByLabelText('推理 / REASONING JSON'),
    )) as HTMLTextAreaElement;
    expect(reasoning.value).toContain('"supported":true');
    const summary = document.querySelector('.advanced-field .field-read-value')?.textContent ?? '';
    expect(summary).toContain('支持');
    expect(summary).toContain('档位 low/high');
    expect(summary).toContain('预算 0–8192');

    await user.clear(reasoning);
    await user.type(reasoning, 'true');
    expect(screen.getByText(/不能是裸布尔值/)).toBeInTheDocument();
    const reasoningField = reasoning.closest('.advanced-field') as HTMLElement;
    expect(within(reasoningField).getByRole('button', { name: '设为草稿' })).toBeDisabled();
  });
});

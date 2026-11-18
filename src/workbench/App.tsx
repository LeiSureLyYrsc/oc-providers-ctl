import { useEffect, useMemo, useReducer, useState } from 'react';
import type { Backend, ModelCandidate, ModelEntry, ProviderEntry, SourceDocument } from '../ipc';
import { pickConfigFile, pickProjectFolder, toSafeMessage } from '../ipc';
import { candidateAdoptionEdits } from '../lib/adoption';
import type { DraftIntent } from '../lib/editRules';
import {
  buildModelCreateValue,
  buildProviderCreateValue,
  composeDefaultModel,
  locateModel,
  modelLeafPath,
  modelRoot,
  pathKey,
  providerLeafPath,
  providerRoot,
  type ConcreteDialect,
  type ModelDraftInput,
  type ProviderDraftInput,
} from '../lib/paths';
import {
  batchFor,
  createInitialState,
  editsToApply,
  MAX_EDITS_PER_BATCH,
  reducer,
  type Mode,
} from '../lib/store';
import { DemoBanner } from '../components/DemoBanner';
import { ConfirmDialog } from '../components/Dialog';
import { MenuButton, type MenuItem } from '../components/Menu';
import { Icon } from '../components/Icon';
import { SupplierPane } from './SupplierPane';
import { ModelsPane } from './ModelsPane';
import { SaveBar } from '../components/SaveBar';
import { ProviderSetupDialog } from './ProviderSetupDialog';
import { ProviderEditDialog } from '../components/ProviderEditDialog';
import { ModelEditDialog } from '../components/ModelEditDialog';
import { SuggestionDialog } from '../components/SuggestionDialog';
import { InventoryDialog } from '../components/InventoryDialog';
import { PreviewDialog } from '../components/PreviewDialog';
import { ConfigDetailDialog } from '../components/ConfigDetailDialog';

interface Props {
  mode: Mode;
  backend: Backend;
}

type ConfirmState =
  | { kind: 'delete-provider'; provider: ProviderEntry }
  | { kind: 'delete-model'; model: ModelEntry }
  | { kind: 'discard'; next: () => void }
  | { kind: 'restore' }
  | null;

function concreteDialect(provider: ProviderEntry): ConcreteDialect | null {
  return provider.dialect === 'v1' || provider.dialect === 'v2' ? provider.dialect : null;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function parentFolderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/** Disambiguates identical file names: 全局 · opencode.jsonc or <folder> · opencode.jsonc. */
function describeSource(
  path: string,
  projectPath: string | null,
): { scope: string; label: string } {
  const label = fileName(path);
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (projectPath) {
    const project = normalize(projectPath);
    if (normalize(path).startsWith(`${project}/`)) {
      return { scope: parentFolderName(path) || '项目', label };
    }
  }
  if (/[\\/]\.config[\\/]opencode[\\/]/i.test(path) || /[\\/]AppData[\\/]/i.test(path)) {
    return { scope: '全局', label };
  }
  return { scope: parentFolderName(path) || '其他', label };
}

function readTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function App({ mode, backend }: Props) {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    createInitialState({ mode, theme: readTheme() }),
  );
  const [providerId, setProviderId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [editingProvider, setEditingProvider] = useState(false);
  const [editingModel, setEditingModel] = useState(false);
  const [suggestionFor, setSuggestionFor] = useState<string | null>(null);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const source = useMemo<SourceDocument | null>(() => {
    if (!state.snapshot) return null;
    return (
      state.snapshot.sources.find((entry) => entry.path === state.activeSourcePath) ??
      state.snapshot.sources[0] ??
      null
    );
  }, [state.snapshot, state.activeSourcePath]);

  const provider = source?.providers.find((entry) => entry.id === providerId) ?? null;
  const model = provider?.models.find((entry) => entry.id === modelId) ?? null;
  const batch = batchFor(state, source?.path ?? null);
  const dirty = Boolean(batch && batch.edits.length > 0);
  const hasAnyDrafts = Object.values(state.batches).some((entry) => entry.edits.length > 0);
  const readOnly = Boolean(source && !source.writable);
  const demo = mode === 'demo';

  useEffect(() => {
    if (!source) {
      setProviderId(null);
      setModelId(null);
      return;
    }
    const current = source.providers.find((entry) => entry.id === providerId);
    if (!current) {
      setProviderId(source.providers[0]?.id ?? null);
      setModelId(null);
      return;
    }
    if (modelId && !current.models.some((entry) => entry.id === modelId)) {
      setModelId(null);
    }
  }, [source, providerId, modelId]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme);
    try {
      localStorage.setItem('occtl.theme', state.theme);
    } catch {
      // Theme persistence is a convenience only.
    }
  }, [state.theme]);

  useEffect(() => {
    if (!hasAnyDrafts) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasAnyDrafts]);

  useEffect(() => {
    if (!state.notice) return;
    const timer = window.setTimeout(() => dispatch({ type: 'DISMISS_NOTICE' }), 6000);
    return () => window.clearTimeout(timer);
  }, [state.notice?.seq]);

  useEffect(() => {
    void scan(null, false, false);
    // Initial scan runs once per mount; quiet so the first screen isn't covered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function notify(kind: 'info' | 'success' | 'error', text: string) {
    dispatch({ type: 'NOTICE', kind, text });
  }

  function confirmDiscardAnd(next: () => void): void {
    setConfirm({
      kind: 'discard',
      next: () => {
        dispatch({ type: 'DISCARD_ALL_DRAFTS' });
        next();
      },
    });
  }

  async function scan(
    projectPath: string | null,
    discardConfirmed: boolean,
    announce = true,
  ): Promise<void> {
    if (hasAnyDrafts && !discardConfirmed) {
      confirmDiscardAnd(() => void scan(projectPath, true));
      return;
    }
    dispatch({ type: 'SCAN_START' });
    setBusy(true);
    try {
      const snapshot = await backend.scanConfigs(projectPath);
      dispatch({ type: 'SCAN_SUCCESS', snapshot });
      if (announce) notify('success', `已读取 ${snapshot.sources.length} 个配置文件。`);
    } catch (failure) {
      const message = toSafeMessage(failure);
      dispatch({ type: 'SCAN_ERROR', message });
      notify('error', message);
    } finally {
      setBusy(false);
    }
  }

  async function loadPath(path: string): Promise<void> {
    dispatch({ type: 'LOAD_START' });
    setLoadError(null);
    setBusy(true);
    try {
      const document = await backend.loadConfig(path);
      dispatch({ type: 'SOURCE_ADDED', source: document });
      notify('success', '已打开配置文件。');
    } catch (failure) {
      const message = toSafeMessage(failure);
      dispatch({ type: 'LOAD_ERROR', message });
      setLoadError(message);
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(): Promise<void> {
    if (demo) {
      notify('info', '演示模式不会打开系统文件选择器。');
      return;
    }
    try {
      const path = await pickConfigFile();
      if (!path) return;
      if (hasAnyDrafts) {
        confirmDiscardAnd(() => void loadPath(path));
        return;
      }
      await loadPath(path);
    } catch (failure) {
      notify('error', toSafeMessage(failure));
    }
  }

  async function pickProject(): Promise<void> {
    if (demo) {
      notify('info', '演示模式不会打开系统目录选择器。');
      return;
    }
    try {
      const path = await pickProjectFolder();
      if (!path) return;
      await scan(path, false);
    } catch (failure) {
      notify('error', toSafeMessage(failure));
    }
  }

  function stage(
    dialect: ConcreteDialect,
    intent: DraftIntent,
    path: string[],
    op: 'set' | 'remove',
    value: unknown,
    label: string,
  ): void {
    if (!source) return;
    if (batch && batch.edits.length >= MAX_EDITS_PER_BATCH) {
      notify('error', `一次最多修改 ${MAX_EDITS_PER_BATCH} 项，请先保存。`);
      return;
    }
    dispatch({
      type: 'STAGE',
      input: { sourcePath: source.path, dialect, intent, path, op, value, label },
    });
  }

  async function refreshCatalog(silent: boolean): Promise<import('../ipc').CatalogResult | null> {
    dispatch({ type: 'CATALOG_START' });
    try {
      const catalog = await backend.fetchCatalog();
      dispatch({ type: 'CATALOG_LOADED', catalog });
      if (!silent) notify('success', `模型目录已更新：${catalog.modelCount} 个模型。`);
      return catalog;
    } catch (failure) {
      const message = toSafeMessage(failure);
      dispatch({ type: 'CATALOG_ERROR', message });
      return null;
    }
  }

  function openPreview(): void {
    if (!source || !batch || batch.edits.length === 0) {
      notify('info', '还没有任何修改。');
      return;
    }
    const request = { path: source.path, sourceHash: batch.sourceHash, revision: batch.revision };
    dispatch({ type: 'PREVIEW_START', demo, request });
    setPreviewOpen(true);
    setBusy(true);
    void (async () => {
      try {
        const result = await backend.previewChanges(
          source.path,
          batch.sourceHash,
          editsToApply(batch),
        );
        dispatch({ type: 'PREVIEW_RESULT', result, demo, request });
      } catch (failure) {
        dispatch({ type: 'PREVIEW_ERROR', message: toSafeMessage(failure), request });
      } finally {
        setBusy(false);
      }
    })();
  }

  async function applyChanges(): Promise<void> {
    if (demo) {
      dispatch({ type: 'APPLY_START' });
      notify('info', '演示模式不会写入文件。');
      return;
    }
    const result = state.preview.result;
    const request = state.preview.request;
    if (!result || state.preview.status !== 'ready' || !request) {
      notify('error', '请先保存预览，再写入文件。');
      return;
    }
    if (
      !source ||
      !batch ||
      request.path !== source.path ||
      request.sourceHash !== source.hash ||
      request.revision !== batch.revision ||
      result.path !== source.path
    ) {
      notify('error', '文件或修改已变化，请重新保存预览。');
      return;
    }
    dispatch({ type: 'APPLY_START' });
    if (state.mode === 'demo') {
      notify('info', '演示模式不会写入文件。');
      return;
    }
    if (state.preview.status !== 'ready') {
      notify('error', '请先保存预览，再写入文件。');
      return;
    }
    setBusy(true);
    try {
      const previewId = result.previewId;
      const updated = await backend.applyChanges(previewId);
      dispatch({ type: 'SOURCE_UPDATED', source: updated, reason: 'apply' });
      setPreviewOpen(false);
      notify('success', '已写入配置文件。');
    } catch (failure) {
      dispatch({ type: 'APPLY_ERROR', message: toSafeMessage(failure) });
      notify('error', toSafeMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup(): Promise<void> {
    if (!source) return;
    setBusy(true);
    try {
      const updated = await backend.restoreBackup(source.path, source.hash);
      dispatch({ type: 'SOURCE_UPDATED', source: updated, reason: 'restore' });
      notify('success', '已恢复上次保存前的备份。');
    } catch (failure) {
      notify('error', toSafeMessage(failure));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  function saveProviderFields(input: { name: string; baseUrl: string }): void {
    if (!provider) return;
    const dialect = concreteDialect(provider);
    if (!dialect) return;
    if (input.name !== (provider.name ?? '')) {
      stage(
        dialect,
        'field',
        providerLeafPath(dialect, provider.id, 'name'),
        input.name ? 'set' : 'remove',
        input.name || undefined,
        '供应商名称',
      );
    }
    if (input.baseUrl !== (provider.baseUrl ?? '')) {
      stage(
        dialect,
        'field',
        providerLeafPath(dialect, provider.id, 'baseUrl'),
        input.baseUrl ? 'set' : 'remove',
        input.baseUrl || undefined,
        '基础地址',
      );
    }
    setEditingProvider(false);
  }

  function saveModelFields(input: ModelDraftInput, reasoning: unknown, variants: unknown): void {
    if (!provider || !model) return;
    const dialect = concreteDialect(provider);
    if (!dialect) return;
    const locator = locateModel(provider, model);

    if (input.name.trim() !== (model.name ?? '')) {
      stage(
        dialect,
        'field',
        modelLeafPath(dialect, locator, 'name'),
        input.name.trim() ? 'set' : 'remove',
        input.name.trim() || undefined,
        '模型名称',
      );
    }

    const tokens: Array<[number | null, number | null, 'context' | 'input' | 'output', string]> = [
      [input.context, model.context, 'context', '上下文长度'],
      [input.input, model.input, 'input', '输入上限'],
      [input.output, model.output, 'output', '输出上限'],
    ];
    tokens.forEach(([next, current, leaf, label]) => {
      if (next === current) return;
      stage(
        dialect,
        'field',
        modelLeafPath(dialect, locator, leaf),
        next === null ? 'remove' : 'set',
        next ?? undefined,
        label,
      );
    });

    if (JSON.stringify(reasoning) !== JSON.stringify(model.reasoning)) {
      stage(
        dialect,
        'field',
        modelLeafPath(dialect, locator, 'reasoning'),
        reasoning === null ? 'remove' : 'set',
        reasoning ?? undefined,
        '推理能力',
      );
    }
    if (JSON.stringify(variants) !== JSON.stringify(model.variants)) {
      stage(
        dialect,
        'field',
        modelLeafPath(dialect, locator, 'variants'),
        variants === null ? 'remove' : 'set',
        variants ?? undefined,
        '模型变体',
      );
    }
    setEditingModel(false);
  }

  function createProvider(dialect: ConcreteDialect, input: ProviderDraftInput): void {
    stage(
      dialect,
      'create-provider',
      [dialect === 'v1' ? 'provider' : 'providers', input.id],
      'set',
      buildProviderCreateValue(dialect, input),
      '新增供应商',
    );
    setCreatingProvider(false);
    setProviderId(input.id);
    setModelId(null);
  }

  function createModel(input: ModelDraftInput, reasoning: unknown): void {
    if (!provider) return;
    const dialect = concreteDialect(provider);
    if (!dialect) return;
    const value = buildModelCreateValue(dialect, input);
    if (reasoning !== null && reasoning !== undefined) {
      if (dialect === 'v1') {
        if (typeof reasoning === 'boolean') value.reasoning = reasoning;
      } else {
        value.capabilities = { reasoning };
      }
    }
    stage(
      dialect,
      'create-model',
      modelRoot(dialect, { providerId: provider.id, modelId: input.id }),
      'set',
      value,
      '新增模型',
    );
    setModelId(input.id);
    setEditingModel(false);
  }

  function setDefaultModel(target: ProviderEntry, entry: ModelEntry, clear: boolean): void {
    const dialect = concreteDialect(target);
    if (!dialect) return;
    stage(
      dialect,
      'default',
      ['model'],
      clear ? 'remove' : 'set',
      clear ? undefined : composeDefaultModel(target.id, entry.id),
      '默认模型',
    );
  }

  function adoptSuggestion(candidate: ModelCandidate, includeReasoning: boolean): void {
    if (!provider || !model) return;
    const dialect = concreteDialect(provider);
    if (!dialect) return;
    const edits = candidateAdoptionEdits(dialect, provider, model, candidate, includeReasoning);
    edits.forEach((edit) => stage(dialect, 'field', edit.path, 'set', edit.value, edit.label));
    setSuggestionFor(null);
    if (edits.length === 0) notify('info', '这条建议没有可补充的内容。');
  }

  function addFromInventory(ids: string[]): void {
    if (!provider) return;
    const dialect = concreteDialect(provider);
    if (!dialect) return;
    const existing = new Set(provider.models.map((entry) => entry.id));
    const fresh = ids.filter((id) => !existing.has(id));
    fresh.forEach((id) =>
      stage(
        dialect,
        'create-model',
        modelRoot(dialect, { providerId: provider.id, modelId: id }),
        'set',
        buildModelCreateValue(dialect, {
          id,
          name: '',
          context: null,
          input: null,
          output: null,
          reasoning: null,
        }),
        `新增模型 ${id}`,
      ),
    );
    setInventoryOpen(false);
    if (fresh.length === 0) notify('info', '所选模型都已存在。');
  }

  function deleteProvider(): void {
    if (!provider) return;
    const dialect = concreteDialect(provider);
    if (!dialect) return;
    stage(
      dialect,
      'delete-provider',
      providerRoot(dialect, provider.id),
      'remove',
      undefined,
      `删除供应商 ${provider.id}`,
    );
    setProviderId(null);
    setModelId(null);
    setConfirm(null);
  }

  function deleteModel(): void {
    if (!provider || !model) return;
    const dialect = concreteDialect(provider);
    if (!dialect) return;
    stage(
      dialect,
      'delete-model',
      modelRoot(dialect, locateModel(provider, model)),
      'remove',
      undefined,
      `删除模型 ${model.id}`,
    );
    setModelId(null);
    setConfirm(null);
  }

  function switchSource(path: string): void {
    if (hasAnyDrafts) {
      setConfirm({
        kind: 'discard',
        next: () => {
          dispatch({ type: 'DISCARD_ALL_DRAFTS' });
          dispatch({ type: 'SELECT_SOURCE', path });
        },
      });
      return;
    }
    dispatch({ type: 'SELECT_SOURCE', path });
  }

  const editedPaths = new Set(batch?.edits.map((draft) => pathKey(draft.path)) ?? []);
  const draftLabels = (batch?.edits ?? []).map((draft) => ({ label: draft.label, path: draft.path }));
  const currentProblems = source
    ? [...source.warnings, ...(source.writable ? [] : ['只读文件'])]
    : [];

  const menuItems: MenuItem[] = [
    {
      key: 'open',
      label: '打开配置文件…',
      disabled: demo,
      onSelect: () => {
        void pickFile();
      },
    },
    {
      key: 'rescan',
      label: '重新读取',
      onSelect: () => {
        void scan(null, false);
      },
    },
    {
      key: 'project',
      label: '包含项目目录…',
      disabled: demo,
      onSelect: () => {
        void pickProject();
      },
    },
    {
      key: 'catalog',
      label: '更新模型目录',
      disabled: state.catalogLoading,
      onSelect: () => {
        void refreshCatalog(false);
      },
    },
    {
      key: 'detail',
      label: '配置详情…',
      hint: currentProblems.length > 0 ? `${currentProblems.length} 个问题` : undefined,
      onSelect: () => setDetailOpen(true),
    },
    {
      key: 'restore',
      label: '恢复上次保存前的备份',
      separatorBefore: true,
      disabled: !source?.writable || demo,
      onSelect: () => setConfirm({ kind: 'restore' }),
    },
  ];

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar-title">
          <h1>OpenCode 供应商</h1>
          <span className="sub">{demo ? '演示数据' : '本地配置'}</span>
        </div>
        <div className="appbar-spacer" />
        <div className="config-picker">
          <label className="sr-only" htmlFor="config-select">
            选择配置文件
          </label>
          <select
            id="config-select"
            value={source?.path ?? ''}
            onChange={(event) => switchSource(event.target.value)}
            disabled={!state.snapshot || state.snapshot.sources.length === 0}
            title={source?.path ?? '没有配置文件'}
          >
            {(state.snapshot?.sources ?? []).map((entry) => {
              const described = describeSource(entry.path, state.snapshot?.projectPath ?? null);
              return (
                <option key={entry.path} value={entry.path} title={entry.path}>
                  {described.scope} · {described.label}
                  {entry.writable ? '' : '（只读）'}
                </option>
              );
            })}
            {!state.snapshot || state.snapshot.sources.length === 0 ? (
              <option value="">没有配置文件</option>
            ) : null}
          </select>
          <button
            type="button"
            className="btn btn-tonal btn-small"
            onClick={() => {
              void pickFile();
            }}
            disabled={demo}
            title={demo ? '演示模式不可用' : '选择配置文件'}
          >
            <Icon name="file" size={18} />
            打开
          </button>
        </div>
        <div style={{ width: 1, height: 28, background: 'var(--outline-variant)' }} />
        <button
          type="button"
          className="btn-icon btn-icon-outlined"
          aria-label={state.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          onClick={() =>
            dispatch({ type: 'SET_THEME', theme: state.theme === 'dark' ? 'light' : 'dark' })
          }
        >
          <Icon name={state.theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <MenuButton label="更多操作" items={menuItems} />
      </header>

      {demo && !bannerDismissed ? <DemoBanner onDismiss={() => setBannerDismissed(true)} /> : null}

      {state.scanning ? (
        <div className="banner" role="status">
          <span className="spinner" aria-hidden="true" />
          正在读取配置…
        </div>
      ) : null}

      {loadError ? (
        <div
          className="banner"
          role="alert"
          style={{ background: 'var(--error-container)', color: 'var(--on-error-container)' }}
        >
          <Icon name="warning" size={20} />
          <span>{loadError}</span>
          <button type="button" className="text-btn banner-dismiss" onClick={() => setLoadError(null)}>
            关闭
          </button>
        </div>
      ) : null}

      <div className="workspace">
        <SupplierPane
          source={source}
          providers={source?.providers ?? []}
          selectedId={providerId}
          query={query}
          onQuery={setQuery}
          onSelect={(id) => {
            setProviderId(id);
            setModelId(null);
          }}
          onAdd={() => setCreatingProvider(true)}
          addDisabled={!source || readOnly}
          editedPaths={editedPaths}
        />

        <ModelsPane
          source={source}
          provider={provider}
          model={model}
          defaultModel={source?.defaultModel ?? null}
          query={query}
          draftLabels={draftLabels}
          onSelectModel={setModelId}
          onEditProvider={() => setEditingProvider(true)}
          onAddModel={() => setEditingModel(true)}
          onEditModel={() => setEditingModel(true)}
          onRefreshModels={() => setInventoryOpen(true)}
          onSuggest={() => setSuggestionFor(model?.id ?? null)}
          onSetDefault={setDefaultModel}
          onDeleteProvider={(target) => setConfirm({ kind: 'delete-provider', provider: target })}
          onDeleteModel={(target) => setConfirm({ kind: 'delete-model', model: target })}
          onAddProvider={() => setCreatingProvider(true)}
          busy={busy}
        />
      </div>

      {dirty && source ? (
        <SaveBar
          count={batch?.edits.length ?? 0}
          sourcePath={source.path}
          onPreview={openPreview}
          onDiscard={() => dispatch({ type: 'CLEAR_BATCH', sourcePath: source.path })}
          busy={busy}
        />
      ) : null}

      {state.notice ? (
        <div
          className="toast"
          data-kind={state.notice.kind}
          role={state.notice.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="text">{state.notice.text}</span>
          <button
            type="button"
            className="btn-icon"
            aria-label="关闭提示"
            onClick={() => dispatch({ type: 'DISMISS_NOTICE' })}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      ) : null}

      <ProviderSetupDialog
        open={creatingProvider}
        source={source}
        onClose={() => setCreatingProvider(false)}
        onCreate={createProvider}
      />

      {provider ? (
        <ProviderEditDialog
          open={editingProvider}
          provider={provider}
          onClose={() => setEditingProvider(false)}
          onSave={saveProviderFields}
        />
      ) : null}

      {provider ? (
        <ModelEditDialog
          open={editingModel}
          provider={provider}
          model={model}
          onClose={() => setEditingModel(false)}
          onSave={saveModelFields}
          onCreate={(input, reasoning) => createModel(input, reasoning)}
        />
      ) : null}

      {provider && suggestionFor ? (
        <SuggestionDialog
          open
          provider={provider}
          model={provider.models.find((entry) => entry.id === suggestionFor) ?? null}
          catalog={state.catalog}
          catalogLoading={state.catalogLoading}
          onRefreshCatalog={() => refreshCatalog(false)}
          onClose={() => setSuggestionFor(null)}
          onSearch={(text: string) => backend.matchModels(text, provider.id)}
          onAdopt={adoptSuggestion}
        />
      ) : null}

      {source && provider ? (
        <InventoryDialog
          open={inventoryOpen}
          provider={provider}
          remaining={Math.max(0, MAX_EDITS_PER_BATCH - (batch?.edits.length ?? 0))}
          onClose={() => setInventoryOpen(false)}
          onFetch={() => backend.fetchProviderModels(source.path, provider.id)}
          onAdd={addFromInventory}
        />
      ) : null}

      <PreviewDialog
        open={previewOpen}
        preview={state.preview}
        edits={batch?.edits ?? []}
        demo={demo}
        busy={busy}
        onClose={() => setPreviewOpen(false)}
        onApply={() => {
          void applyChanges();
        }}
      />

      <ConfigDetailDialog
        open={detailOpen}
        state={state}
        source={source}
        onClose={() => setDetailOpen(false)}
        onOpenPath={switchSource}
      />

      {confirm?.kind === 'delete-provider' ? (
        <ConfirmDialog
          open
          title="删除这个供应商？"
          body={
            <>
              将删除 <strong>{confirm.provider.id}</strong> 及其下的全部模型。这条修改会先进入待保存状态。
            </>
          }
          confirmLabel="删除"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={deleteProvider}
        />
      ) : null}

      {confirm?.kind === 'delete-model' ? (
        <ConfirmDialog
          open
          title="删除这个模型？"
          body={
            <>
              将删除模型 <strong>{confirm.model.id}</strong>。这条修改会先进入待保存状态。
            </>
          }
          confirmLabel="删除"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={deleteModel}
        />
      ) : null}

      {confirm?.kind === 'discard' ? (
        <ConfirmDialog
          open
          title="放弃未保存的修改？"
          body="当前修改还没有保存，继续会丢弃它们。"
          confirmLabel="丢弃并继续"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const next = confirm.next;
            setConfirm(null);
            dispatch({ type: 'CLEAR_BATCH', sourcePath: source?.path ?? '' });
            next();
          }}
        />
      ) : null}

      {confirm?.kind === 'restore' ? (
        <ConfirmDialog
          open
          title="恢复上次保存前的备份？"
          body="会用本应用上次保存前创建的备份覆盖当前文件。若文件在外部被改动过，恢复会被拒绝。"
          confirmLabel="恢复"
          danger
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            void restoreBackup();
          }}
        />
      ) : null}

      {!state.snapshot && !state.scanning ? (
        <div className="empty" style={{ position: 'fixed', inset: 0, background: 'var(--surface)', zIndex: 20 }}>
          <Icon name="file" size={40} />
          <h3>没有找到配置文件</h3>
          <p>
            {demo
              ? '演示数据没有加载成功，请刷新页面。'
              : '可以重新读取全局配置，或手动选择一个 JSON / JSONC 文件。'}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="button" className="btn btn-tonal" onClick={() => void scan(null, false)}>
              重新读取
            </button>
            <button type="button" className="btn btn-filled" onClick={() => void pickFile()} disabled={demo}>
              选择文件
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

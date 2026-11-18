import { useEffect, useReducer, useState } from 'react';
import type {
  Backend,
  ModelCandidate,
  ModelEntry,
  ProviderEntry,
  SourceDocument,
} from '../ipc';
import {
  DEMO_WRITE_BLOCKED,
  pickConfigFile,
  pickProjectFolder,
  toSafeMessage,
} from '../ipc';
import { DEMO_PATHS, DEMO_PROJECT_PATH } from '../demo/fixtures';
import {
  buildChecks,
  type CheckItem,
} from '../lib/checks';
import { isConcreteDialect } from '../lib/paths';
import { candidateAdoptionEdits } from '../lib/adoption';
import type { DraftIntent } from '../lib/editRules';
import { ProviderDialog } from '../components/ProviderDialog';
import { ModelDialog } from '../components/ModelDialog';
import { CandidateDialog } from '../components/CandidateDialog';
import { InventoryDialog } from '../components/InventoryDialog';
import { ConfirmDialog, ShortcutsDialog } from '../components/Dialogs';
import { TopBar } from '../components/TopBar';
import { CommandBar } from '../components/CommandBar';
import { ContextBar } from '../components/ContextBar';
import { Rail } from '../components/Rail';
import { StatusBar } from '../components/StatusBar';
import { Inspector } from '../components/Inspector';
import type { InspectorActions } from '../components/Inspector';
import { OverviewView } from '../views/OverviewView';
import { ProvidersView } from '../views/ProvidersView';
import { ModelsView } from '../views/ModelsView';
import { SourcesView } from '../views/SourcesView';
import { ChecksView } from '../views/ChecksView';
import {
  activeSource,
  batchFor,
  createInitialState,
  editsToApply,
  MAX_EDITS_PER_BATCH,
  reducer,
  type Density,
  type DialectFilter,
  type Mode,
  type PreviewRequest,
  type Theme,
  type View,
} from '../lib/store';
import {
  buildModelCreateValue,
  buildProviderCreateValue,
  composeDefaultModel,
  locateModel,
  modelRoot,
  pathKey,
  providerRoot,
  type ConcreteDialect,
  type ModelDraftInput,
  type ProviderDraftInput,
} from '../lib/paths';
import { Badge } from '../components/Badge';
import { Icon } from '../components/Icon';

interface WorkbenchProps {
  mode: Mode;
  backend: Backend;
}

type ConfirmState =
  | { kind: 'delete-provider'; sourcePath: string; provider: ProviderEntry }
  | { kind: 'delete-model'; sourcePath: string; provider: ProviderEntry; model: ModelEntry }
  | { kind: 'apply' }
  | { kind: 'restore'; source: SourceDocument }
  | null;

type DirtyIntent =
  | { kind: 'scan'; target: string | null }
  | { kind: 'load'; path: string }
  | { kind: 'reload'; document: SourceDocument };

interface CandidateState {
  providerId: string;
  modelId: string;
  /** Marks the dialog as the owner of the pending model create target. */
  kind: 'suggest';
}

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function readDensity(): Density {
  if (typeof document === 'undefined') return 'compact';
  return document.documentElement.getAttribute('data-density') === 'comfortable'
    ? 'comfortable'
    : 'compact';
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is a convenience; the UI state remains authoritative.
  }
}

export function Workbench({ mode, backend }: WorkbenchProps) {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    createInitialState({ mode, theme: readTheme(), density: readDensity() }),
  );
  const [projectPath, setProjectPath] = useState(mode === 'demo' ? DEMO_PROJECT_PATH : '');
  const [loadPath, setLoadPath] = useState(mode === 'demo' ? DEMO_PATHS.globalV1 : '');
  const [modelProviderFilter, setModelProviderFilter] = useState('all');
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [newModelProvider, setNewModelProvider] = useState<ProviderEntry | null>(null);
  const [candidate, setCandidate] = useState<CandidateState | null>(null);
  const [inventoryProviderId, setInventoryProviderId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [dirtyPrompt, setDirtyPrompt] = useState<DirtyIntent | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const source = activeSource(state);
  const checks = buildChecks(state);
  const selectedCheck =
    state.view === 'checks'
      ? checks.find((check) => check.id === selectedCheckId) ?? checks[0] ?? null
      : null;
  const candidateProvider =
    candidate?.kind === 'suggest'
      ? source?.providers.find((provider) => provider.id === candidate.providerId) ?? null
      : null;
  const candidateModel =
    candidate?.kind === 'suggest'
      ? candidateProvider?.models.find((model) => model.id === candidate.modelId) ?? null
      : null;
  const inventoryProvider =
    source?.providers.find((provider) => provider.id === inventoryProviderId) ?? null;

  const modalOpen = Boolean(
    providerDialogOpen ||
      newModelProvider ||
      candidate ||
      inventoryProviderId ||
      confirm ||
      dirtyPrompt ||
      shortcutsOpen,
  );
  const hasNotice = Boolean(state.notice);
  const hasDrafts = Object.values(state.batches).some((batch) => batch.edits.length > 0);

  async function scan(target: string | null): Promise<void> {
    dispatch({ type: 'SCAN_START' });
    try {
      const snapshot = await backend.scanConfigs(target);
      dispatch({ type: 'SCAN_SUCCESS', snapshot });
      if (snapshot.projectPath) setProjectPath(snapshot.projectPath);
    } catch (failure) {
      const message = toSafeMessage(failure);
      dispatch({ type: 'SCAN_ERROR', message });
      dispatch({ type: 'NOTICE', kind: 'error', text: `扫描失败：${message}` });
    }
  }

  function previewBlocked(): boolean {
    if (state.applyInFlight) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '写入进行中，不能开始新的文件操作。' });
      return true;
    }
    if (state.preview.status === 'loading') {
      dispatch({ type: 'NOTICE', kind: 'error', text: '预演进行中，请等待结果后再操作。' });
      return true;
    }
    return false;
  }

  function requestScan(target: string | null): void {
    if (previewBlocked()) return;
    if (hasDrafts) {
      setDirtyPrompt({ kind: 'scan', target });
      return;
    }
    void scan(target);
  }

  async function load(path: string): Promise<void> {
    const target = path.trim();
    if (!target) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '请填写要载入的 JSON / JSONC 路径。' });
      return;
    }
    dispatch({ type: 'LOAD_START' });
    try {
      const document = await backend.loadConfig(target);
      dispatch({ type: 'SOURCE_ADDED', source: document });
      setLoadPath(target);
    } catch (failure) {
      dispatch({ type: 'LOAD_ERROR', message: toSafeMessage(failure) });
    }
  }

  function requestLoad(path: string): void {
    if (previewBlocked()) return;
    if (hasDrafts) {
      setDirtyPrompt({ kind: 'load', path });
      return;
    }
    void load(path);
  }

  async function reloadDocument(document: SourceDocument): Promise<void> {
    dispatch({ type: 'LOAD_START' });
    try {
      const fresh = await backend.loadConfig(document.path);
      dispatch({ type: 'SOURCE_ADDED', source: fresh });
    } catch (failure) {
      dispatch({ type: 'LOAD_ERROR', message: toSafeMessage(failure) });
    }
  }

  function requestReload(document: SourceDocument): void {
    if (previewBlocked()) return;
    if (hasDrafts) {
      setDirtyPrompt({ kind: 'reload', document });
      return;
    }
    void reloadDocument(document);
  }

  function confirmDirtyIntent(): void {
    const pending = dirtyPrompt;
    setDirtyPrompt(null);
    if (!pending) return;
    dispatch({ type: 'DISCARD_ALL_DRAFTS' });
    if (pending.kind === 'scan') {
      void scan(pending.target);
    } else if (pending.kind === 'load') {
      void load(pending.path);
    } else {
      void reloadDocument(pending.document);
    }
  }

  async function refreshCatalog(silent = false): Promise<void> {
    dispatch({ type: 'CATALOG_START' });
    try {
      const catalog = await backend.fetchCatalog();
      dispatch({ type: 'CATALOG_LOADED', catalog });
      if (!silent) {
        dispatch({
          type: 'NOTICE',
          kind: 'success',
          text: `模型目录已刷新：${catalog.modelCount} 个模型。`,
        });
      }
    } catch (failure) {
      dispatch({ type: 'CATALOG_ERROR', message: toSafeMessage(failure) });
    }
  }

  async function pickProject(): Promise<void> {
    if (mode === 'demo') {
      dispatch({
        type: 'NOTICE',
        kind: 'info',
        text: '演示模式不打开系统目录选择器；已保留虚构项目路径。',
      });
      return;
    }
    try {
      const picked = await pickProjectFolder();
      if (picked) setProjectPath(picked);
    } catch (failure) {
      dispatch({ type: 'NOTICE', kind: 'error', text: toSafeMessage(failure) });
    }
  }

  async function pickFile(): Promise<void> {
    if (mode === 'demo') {
      dispatch({
        type: 'NOTICE',
        kind: 'info',
        text: '演示模式不打开系统文件选择器；可直接载入预填的虚构路径。',
      });
      return;
    }
    try {
      const picked = await pickConfigFile();
      if (picked) {
        setLoadPath(picked);
        requestLoad(picked);
      }
    } catch (failure) {
      dispatch({ type: 'NOTICE', kind: 'error', text: toSafeMessage(failure) });
    }
  }

  function stage(
    targetSource: SourceDocument | null,
    dialect: ConcreteDialect,
    intent: DraftIntent,
    path: string[],
    op: 'set' | 'remove',
    value: unknown,
    label: string,
    origin: 'manual' | 'suggestion' | 'inventory' = 'manual',
  ): void {
    if (!targetSource) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '请先选择配置源。' });
      return;
    }
    if (!targetSource.writable) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '该配置源为只读，不能暂存草稿。' });
      return;
    }
    dispatch({
      type: 'STAGE',
      input: {
        sourcePath: targetSource.path,
        dialect,
        intent,
        path,
        op,
        value,
        label,
        origin,
      },
    });
  }

  function preview(): void {
    if (state.applyInFlight) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '写入进行中，不能重新预演。' });
      return;
    }
    if (state.preview.status === 'loading') {
      dispatch({ type: 'NOTICE', kind: 'info', text: '预演正在进行，请等待结果。' });
      return;
    }
    if (!source) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '请先选择配置源。' });
      return;
    }
    const batch = batchFor(state, source.path);
    if (!batch || batch.edits.length === 0) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '没有可预演的草稿。' });
      return;
    }
    if (batch.edits.length > MAX_EDITS_PER_BATCH) {
      dispatch({
        type: 'NOTICE',
        kind: 'error',
        text: `单个文件每批最多 ${MAX_EDITS_PER_BATCH} 处编辑；请先撤销部分草稿。`,
      });
      return;
    }
    const request: PreviewRequest = {
      path: source.path,
      sourceHash: batch.sourceHash,
      revision: batch.revision,
    };
    dispatch({ type: 'PREVIEW_START', demo: mode === 'demo', request });
    void (async () => {
      try {
        const result = await backend.previewChanges(
          source.path,
          batch.sourceHash,
          editsToApply(batch),
        );
        dispatch({ type: 'PREVIEW_RESULT', result, demo: mode === 'demo' });
      } catch (failure) {
        dispatch({
          type: 'PREVIEW_ERROR',
          message: toSafeMessage(failure),
          request,
        });
      }
    })();
  }

  async function applyConfirmed(): Promise<void> {
    const result = state.preview.result;
    const batch = source ? batchFor(state, source.path) : null;
    const request = state.preview.request;
    if (!result) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '预演结果不可用，请重新预演。' });
      setConfirm(null);
      return;
    }
    if (
      state.preview.status !== 'ready' ||
      !source ||
      !batch ||
      !request ||
      result.path !== source.path ||
      request.path !== source.path ||
      request.sourceHash !== batch.sourceHash ||
      request.revision !== batch.revision
    ) {
      dispatch({
        type: 'NOTICE',
        kind: 'error',
        text: '预演目标与当前草稿不一致，请重新预演。',
      });
      setConfirm(null);
      return;
    }
    dispatch({ type: 'APPLY_START' });
    if (mode === 'demo') {
      dispatch({ type: 'APPLY_BLOCKED', message: DEMO_WRITE_BLOCKED });
      setConfirm(null);
      return;
    }
    setApplying(true);
    try {
      const updated = await backend.applyChanges(result.previewId);
      dispatch({ type: 'SOURCE_UPDATED', source: updated, reason: 'apply' });
      dispatch({ type: 'NOTICE', kind: 'success', text: '变更已写入磁盘，源哈希已更新。' });
    } catch (failure) {
      dispatch({ type: 'APPLY_ERROR', message: toSafeMessage(failure) });
    } finally {
      setApplying(false);
      setConfirm(null);
    }
  }

  async function restoreConfirmed(document: SourceDocument): Promise<void> {
    if (mode === 'demo') {
      dispatch({
        type: 'NOTICE',
        kind: 'error',
        text: '演示模式没有本进程创建的备份，不会恢复任何文件。',
      });
      setConfirm(null);
      return;
    }
    setApplying(true);
    try {
      const updated = await backend.restoreBackup(document.path, document.hash);
      dispatch({ type: 'SOURCE_UPDATED', source: updated, reason: 'restore' });
      dispatch({ type: 'NOTICE', kind: 'success', text: '已恢复本进程创建的上一份备份。' });
    } catch (failure) {
      dispatch({ type: 'NOTICE', kind: 'error', text: `恢复失败：${toSafeMessage(failure)}` });
    } finally {
      setApplying(false);
      setConfirm(null);
    }
  }

  function createProvider(
    dialect: ConcreteDialect,
    input: ProviderDraftInput,
    mapKey: string,
  ): void {
    if (!source) return;
    const value = buildProviderCreateValue(dialect, input);
    stage(
      source,
      dialect,
      'create-provider',
      [mapKey, input.id],
      'set',
      value,
      `新建提供方 ${input.id}`,
    );
    setProviderDialogOpen(false);
  }

  function createModel(input: ModelDraftInput): void {
    const provider = newModelProvider;
    if (!source || !provider || !isConcreteDialect(provider.dialect)) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '目标提供方不可写或方言不明确。' });
      return;
    }
    const dialect = provider.dialect;
    const root = modelRoot(dialect, { providerId: provider.id, modelId: input.id });
    const value = buildModelCreateValue(dialect, input);
    stage(source, dialect, 'create-model', root, 'set', value, `新建模型 ${input.id}`);
    setNewModelProvider(null);
  }

  function addInventoryModels(ids: string[]): void {
    const provider = inventoryProvider;
    if (!source || !provider || !isConcreteDialect(provider.dialect) || ids.length === 0) return;
    const dialect = provider.dialect;
    const batch = batchFor(state, source.path);
    const existingKeys = new Set(batch?.edits.map((draft) => pathKey(draft.path)) ?? []);
    const newCount = ids.filter(
      (id) =>
        !existingKeys.has(
          pathKey(modelRoot(dialect, { providerId: provider.id, modelId: id })),
        ),
    ).length;
    if ((batch?.edits.length ?? 0) + newCount > MAX_EDITS_PER_BATCH) {
      dispatch({
        type: 'NOTICE',
        kind: 'error',
        text: `单个文件每批最多 ${MAX_EDITS_PER_BATCH} 处编辑；当前草稿加上所选会超限。请减少选择。`,
      });
      return;
    }
    ids.forEach((id) => {
      const root = modelRoot(dialect, { providerId: provider.id, modelId: id });
      const value = buildModelCreateValue(dialect, {
        id,
        name: '',
        context: null,
        input: null,
        output: null,
        reasoning: null,
      });
      stage(source, dialect, 'create-model', root, 'set', value, `新建模型 ${id}`, 'inventory');
    });
    setInventoryProviderId(null);
    dispatch({
      type: 'NOTICE',
      kind: 'info',
      text: `已暂存 ${ids.length} 个模型草稿（只含标识键）。`,
    });
  }

  async function searchCandidates(query: string): Promise<ModelCandidate[]> {
    if (!candidateProvider) return [];
    try {
      return await backend.matchModels(query, candidateProvider.id);
    } catch (failure) {
      throw new Error(toSafeMessage(failure));
    }
  }

  function adoptCandidate(modelCandidate: ModelCandidate, includeReasoning: boolean): void {
    if (!source || !candidateProvider || !candidateModel) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '目标模型已变化，请重新选择。' });
      return;
    }
    const dialect = candidateProvider.dialect;
    if (!isConcreteDialect(dialect)) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '目标提供方方言不明确，不能采用建议。' });
      return;
    }
    const updates = candidateAdoptionEdits(
      dialect,
      candidateProvider,
      candidateModel,
      modelCandidate,
      includeReasoning,
    );
    if (updates.length === 0) {
      dispatch({ type: 'NOTICE', kind: 'info', text: '该候选没有可采用的元数据。' });
      return;
    }
    const batch = batchFor(state, source.path);
    const existingKeys = new Set(batch?.edits.map((draft) => pathKey(draft.path)) ?? []);
    const newCount = updates.filter((update) => !existingKeys.has(pathKey(update.path))).length;
    if ((batch?.edits.length ?? 0) + newCount > MAX_EDITS_PER_BATCH) {
      dispatch({
        type: 'NOTICE',
        kind: 'error',
        text: `单个文件每批最多 ${MAX_EDITS_PER_BATCH} 处编辑；采用这些建议会超限。请先清理草稿。`,
      });
      return;
    }
    updates.forEach((update) =>
      stage(source, dialect, 'field', update.path, 'set', update.value, update.label, 'suggestion'),
    );
    setCandidate(null);
    dispatch({
      type: 'NOTICE',
      kind: 'info',
      text: `已暂存 ${updates.length} 条建议草稿；请求 ID 与变体未写入。`,
    });
  }

  function requestDeleteProvider(provider: ProviderEntry): void {
    if (!source) return;
    setConfirm({ kind: 'delete-provider', sourcePath: source.path, provider });
  }

  function requestDeleteModel(provider: ProviderEntry, model: ModelEntry): void {
    if (!source) return;
    setConfirm({ kind: 'delete-model', sourcePath: source.path, provider, model });
  }

  function openConfirmApply(): void {
    if (mode === 'demo') {
      dispatch({ type: 'NOTICE', kind: 'info', text: DEMO_WRITE_BLOCKED });
      return;
    }
    if (state.preview.status !== 'ready' || !state.preview.result) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '请先完成预演。' });
      return;
    }
    setConfirm({ kind: 'apply' });
  }

  function requestRestore(document: SourceDocument): void {
    if (mode === 'demo') {
      dispatch({
        type: 'NOTICE',
        kind: 'info',
        text: '演示模式没有可恢复的进程备份；入口不会伪造恢复成功。',
      });
      return;
    }
    if (!document.writable) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '只读配置源不能恢复。' });
      return;
    }
    setConfirm({ kind: 'restore', source: document });
  }

  function requestNewProvider(): void {
    if (!source?.writable || source.dialect === 'invalid') {
      dispatch({
        type: 'NOTICE',
        kind: 'error',
        text: '当前配置源不可写或结构无效，不能新建提供方。',
      });
      return;
    }
    setProviderDialogOpen(true);
  }

  function requestNewModel(provider: ProviderEntry | null): void {
    if (!source?.writable || !provider || !isConcreteDialect(provider.dialect)) {
      dispatch({
        type: 'NOTICE',
        kind: 'error',
        text: '先选择一个可写、方言明确的提供方，再新建模型。',
      });
      return;
    }
    setNewModelProvider(provider);
  }

  function requestCandidates(provider: ProviderEntry, model: ModelEntry): void {
    if (!isConcreteDialect(provider.dialect)) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '该提供方方言不明确，不能采用建议。' });
      return;
    }
    setCandidate({ providerId: provider.id, modelId: model.id, kind: 'suggest' });
  }

  function requestInventory(provider: ProviderEntry): void {
    if (!isConcreteDialect(provider.dialect)) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '该提供方方言不明确，不能抓取清单。' });
      return;
    }
    setInventoryProviderId(provider.id);
  }

  function goView(view: View): void {
    dispatch({ type: 'SET_VIEW', view });
    dispatch({ type: 'SET_QUERY', query: '' });
    dispatch({ type: 'SET_DIALECT_FILTER', dialect: 'all' });
    if (view === 'checks' && !selectedCheckId) {
      const fresh = buildChecks(state);
      setSelectedCheckId(fresh[0]?.id ?? null);
    }
  }

  function jumpToCheck(check: CheckItem): void {
    setSelectedCheckId(check.id);
    if (check.sourcePath && check.sourcePath !== state.activeSourcePath) {
      dispatch({ type: 'SELECT_SOURCE', path: check.sourcePath });
    }
    if (check.action) {
      dispatch({ type: 'SET_VIEW', view: check.action.view });
      if (check.action.providerId) {
        dispatch({ type: 'SELECT_PROVIDER', providerId: check.action.providerId });
      }
      if (check.action.modelId && check.action.providerId) {
        dispatch({
          type: 'SELECT_MODEL',
          providerId: check.action.providerId,
          modelId: check.action.modelId,
        });
      }
    } else {
      dispatch({ type: 'SET_VIEW', view: 'checks' });
    }
  }

  function openSource(path: string): void {
    dispatch({ type: 'SELECT_SOURCE', path });
    dispatch({ type: 'SET_VIEW', view: 'sources' });
    dispatch({ type: 'SET_QUERY', query: '' });
  }

  function openProvider(path: string, providerId: string): void {
    dispatch({ type: 'SELECT_SOURCE', path });
    dispatch({ type: 'SET_VIEW', view: 'providers' });
    dispatch({ type: 'SELECT_PROVIDER', providerId });
  }

  function openModel(path: string, providerId: string, modelId: string): void {
    dispatch({ type: 'SELECT_SOURCE', path });
    dispatch({ type: 'SET_VIEW', view: 'models' });
    dispatch({ type: 'SELECT_MODEL', providerId, modelId });
  }

  function confirmDestructive(): void {
    if (!confirm) return;
    if (confirm.kind === 'delete-provider') {
      const target = state.snapshot?.sources.find((entry) => entry.path === confirm.sourcePath);
      const dialect = isConcreteDialect(confirm.provider.dialect)
        ? confirm.provider.dialect
        : target && isConcreteDialect(target.dialect)
          ? target.dialect
          : null;
      if (!target || !dialect) {
        dispatch({ type: 'NOTICE', kind: 'error', text: '无法定位可编辑的提供方映射。' });
        setConfirm(null);
        return;
      }
      stage(
        target,
        dialect,
        'delete-provider',
        providerRoot(dialect, confirm.provider.id),
        'remove',
        undefined,
        `删除提供方 ${confirm.provider.id}`,
      );
      setConfirm(null);
      return;
    }
    if (confirm.kind === 'delete-model') {
      const target = state.snapshot?.sources.find((entry) => entry.path === confirm.sourcePath);
      const dialect = isConcreteDialect(confirm.provider.dialect)
        ? confirm.provider.dialect
        : null;
      if (!target || !dialect) {
        dispatch({ type: 'NOTICE', kind: 'error', text: '无法定位可编辑的模型路径。' });
        setConfirm(null);
        return;
      }
      stage(
        target,
        dialect,
        'delete-model',
        modelRoot(dialect, locateModel(confirm.provider, confirm.model)),
        'remove',
        undefined,
        `删除模型 ${confirm.model.id}`,
      );
      setConfirm(null);
      return;
    }
    if (confirm.kind === 'apply') {
      void applyConfirmed();
      return;
    }
    if (confirm.kind === 'restore') {
      void restoreConfirmed(confirm.source);
    }
  }

  function handleSetDefault(provider: ProviderEntry, model: ModelEntry, clear: boolean): void {
    if (!source) return;
    const dialect = isConcreteDialect(provider.dialect)
      ? provider.dialect
      : isConcreteDialect(source.dialect)
        ? source.dialect
        : null;
    if (!dialect) {
      dispatch({ type: 'NOTICE', kind: 'error', text: '无法确定默认模型的写入目标。' });
      return;
    }
    if (clear) {
      stage(source, dialect, 'default', ['model'], 'remove', undefined, '默认模型');
    } else {
      stage(
        source,
        dialect,
        'default',
        ['model'],
        'set',
        composeDefaultModel(provider.id, model.id),
        '默认模型',
      );
    }
  }

  const inspectorActions: InspectorActions = {
    stage: (dialect, intent, path, op, value, label) =>
      stage(source, dialect, intent, path, op, value, label),
    setDefault: handleSetDefault,
    addModel: requestNewModel,
    deleteProvider: requestDeleteProvider,
    deleteModel: requestDeleteModel,
    openCandidates: requestCandidates,
    openInventory: requestInventory,
    restore: requestRestore,
    reload: (document) => {
      requestReload(document);
    },
    jump: jumpToCheck,
    openProvider: (providerId) => {
      if (source) openProvider(source.path, providerId);
    },
    openModel: (providerId, modelId) => {
      if (source) openModel(source.path, providerId, modelId);
    },
    selectSource: (path) => dispatch({ type: 'SELECT_SOURCE', path }),
    preview,
    apply: openConfirmApply,
    unstage: (draftId) => {
      if (!source) return;
      dispatch({ type: 'UNSTAGE', sourcePath: source.path, draftId });
    },
    clearBatch: () => {
      if (!source) return;
      dispatch({ type: 'CLEAR_BATCH', sourcePath: source.path });
    },
  };

  useEffect(() => {
    void scan(mode === 'demo' ? DEMO_PROJECT_PATH : null);
    if (mode === 'demo') void refreshCatalog(true);
    // Initial scan is explicit and once per shell mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme);
    persist('occtl.theme', state.theme);
  }, [state.theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', state.density);
    persist('occtl.density', state.density);
  }, [state.density]);

  useEffect(() => {
    if (!state.notice) return;
    const timer = window.setTimeout(() => dispatch({ type: 'DISMISS_NOTICE' }), 5200);
    return () => window.clearTimeout(timer);
  }, [state.notice?.seq]);

  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('[data-view-title]');
    heading?.focus({ preventScroll: true });
  }, [state.view]);

  useEffect(() => {
    if (!source) return;
    if (state.view === 'providers') {
      if (
        !source.providers.some((provider) => provider.id === state.selectedProviderId) &&
        source.providers[0]
      ) {
        dispatch({ type: 'SELECT_PROVIDER', providerId: source.providers[0].id });
      }
    }
    if (state.view === 'models') {
      const provider =
        source.providers.find((entry) => entry.id === state.selectedProviderId) ??
        source.providers[0];
      if (!provider) return;
      if (provider.id !== state.selectedProviderId) {
        dispatch({ type: 'SELECT_PROVIDER', providerId: provider.id });
        return;
      }
      if (!provider.models.some((model) => model.id === state.selectedModelId) && provider.models[0]) {
        dispatch({
          type: 'SELECT_MODEL',
          providerId: provider.id,
          modelId: provider.models[0].id,
        });
      }
    }
  }, [state.view, source?.path, source?.hash, state.selectedProviderId, state.selectedModelId, source]);

  useEffect(() => {
    setModelProviderFilter('all');
    setProviderDialogOpen(false);
    setNewModelProvider(null);
    setCandidate(null);
    setInventoryProviderId(null);
    setConfirm(null);
  }, [state.activeSourcePath]);

  useEffect(() => {
    if (
      modelProviderFilter !== 'all' &&
      !source?.providers.some((provider) => provider.id === modelProviderFilter)
    ) {
      setModelProviderFilter('all');
    }
  }, [modelProviderFilter, source]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
      if (event.defaultPrevented) return;
      if (event.altKey && /^[1-5]$/.test(event.key) && !modalOpen) {
        event.preventDefault();
        const views: View[] = ['overview', 'providers', 'models', 'sources', 'checks'];
        goView(views[Number(event.key) - 1]);
        return;
      }
      if (modalOpen) return;
      if (event.key === '/' && !typing) {
        const filter = document.querySelector<HTMLInputElement>('[data-filter-input]');
        if (filter) {
          event.preventDefault();
          filter.focus();
          filter.select();
        }
        return;
      }
      if (event.key === '?' && !typing) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key === 'Escape' && hasNotice) {
        dispatch({ type: 'DISMISS_NOTICE' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen, hasNotice, state.view, state.snapshot, state.batches]);

  const demo = mode === 'demo';

  return (
    <div className="app">
      <TopBar
        mode={mode}
        theme={state.theme}
        density={state.density}
        catalog={state.catalog}
        catalogLoading={state.catalogLoading}
        onTheme={() =>
          dispatch({ type: 'SET_THEME', theme: state.theme === 'dark' ? 'light' : 'dark' })
        }
        onDensity={() =>
          dispatch({
            type: 'SET_DENSITY',
            density: state.density === 'compact' ? 'comfortable' : 'compact',
          })
        }
        onRefreshCatalog={() => {
          void refreshCatalog(false);
        }}
        onShortcuts={() => setShortcutsOpen(true)}
      />

      {demo ? (
        <div className="demo-banner" role="note">
          <Badge tone="suggestion">DEMO / 演示数据</Badge>
          <p>
            浏览器预览使用确定性的虚构配置。草稿与示意预演可以体验；应用与恢复入口不会伪造磁盘写入。
          </p>
          <span className="demo-banner-meta mono">NO DISK WRITES · FICTIONAL PATHS</span>
        </div>
      ) : null}

      <div className="workbench">
        <Rail state={state} onView={goView} />
        <div className="main-col">
          <CommandBar
            mode={mode}
            projectPath={projectPath}
            onProjectPath={setProjectPath}
            loadPath={loadPath}
            onLoadPath={setLoadPath}
            scanning={state.scanning}
            onScanGlobal={() => {
              requestScan(null);
            }}
            onScanProject={() => {
              requestScan(projectPath.trim() || null);
            }}
            onPickProject={() => {
              void pickProject();
            }}
            onLoad={() => {
              requestLoad(loadPath);
            }}
            onPickFile={() => {
              void pickFile();
            }}
          />
          <ContextBar
            source={source}
            sources={state.snapshot?.sources ?? []}
            projectPath={state.snapshot?.projectPath ?? (projectPath.trim() || null)}
            onSelect={(path) => dispatch({ type: 'SELECT_SOURCE', path })}
          />
          <div className="view-grid">
            {state.view === 'overview' ? (
              <OverviewView
                state={state}
                checks={checks}
                onOpenSource={openSource}
                onOpenProvider={openProvider}
                onOpenModel={openModel}
                onJumpCheck={jumpToCheck}
                onGoChecks={() => goView('checks')}
              />
            ) : null}
            {state.view === 'providers' ? (
              <ProvidersView
                state={state}
                source={source}
                onQuery={(value) => dispatch({ type: 'SET_QUERY', query: value })}
                onDialectFilter={(value: DialectFilter) =>
                  dispatch({ type: 'SET_DIALECT_FILTER', dialect: value })
                }
                onSelect={(providerId) => dispatch({ type: 'SELECT_PROVIDER', providerId })}
                onNewProvider={requestNewProvider}
              />
            ) : null}
            {state.view === 'models' ? (
              <ModelsView
                state={state}
                source={source}
                providerFilter={modelProviderFilter}
                onProviderFilter={setModelProviderFilter}
                onQuery={(value) => dispatch({ type: 'SET_QUERY', query: value })}
                onDialectFilter={(value: DialectFilter) =>
                  dispatch({ type: 'SET_DIALECT_FILTER', dialect: value })
                }
                onSelect={(providerId, modelId) =>
                  dispatch({ type: 'SELECT_MODEL', providerId, modelId })
                }
                onNewModel={requestNewModel}
              />
            ) : null}
            {state.view === 'sources' ? (
              <SourcesView
                state={state}
                projectPath={state.snapshot?.projectPath ?? (projectPath.trim() || null)}
                onQuery={(value) => dispatch({ type: 'SET_QUERY', query: value })}
                onDialectFilter={(value: DialectFilter) =>
                  dispatch({ type: 'SET_DIALECT_FILTER', dialect: value })
                }
                onSelect={(path) => dispatch({ type: 'SELECT_SOURCE', path })}
              />
            ) : null}
            {state.view === 'checks' ? (
              <ChecksView
                checks={checks as CheckItem[]}
                query={state.query}
                onQuery={(value) => dispatch({ type: 'SET_QUERY', query: value })}
                selectedCheckId={selectedCheck?.id ?? null}
                onSelect={(check) => setSelectedCheckId(check.id)}
              />
            ) : null}

            <Inspector
              state={state}
              source={source}
              check={selectedCheck}
              applying={applying}
              actions={inspectorActions}
            />
          </div>
        </div>
      </div>

      <StatusBar state={state} />

      {state.notice ? (
        <div
          className={`toast toast-${state.notice.kind}`}
          role={state.notice.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          key={state.notice.seq}
        >
          <span className="toast-mark" aria-hidden="true">
            <Icon
              name={state.notice.kind === 'error' ? 'warning' : state.notice.kind === 'success' ? 'check' : 'info'}
              size={15}
            />
          </span>
          <span>{state.notice.text}</span>
          <button
            type="button"
            className="icon-btn icon-btn-small"
            onClick={() => dispatch({ type: 'DISMISS_NOTICE' })}
            aria-label="关闭提示"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : null}

      <ProviderDialog
        open={providerDialogOpen && Boolean(source)}
        source={source}
        demo={demo}
        onClose={() => setProviderDialogOpen(false)}
        onCreate={createProvider}
      />

      {source && newModelProvider ? (
        <ModelDialog
          open
          source={source}
          provider={newModelProvider}
          demo={demo}
          onClose={() => setNewModelProvider(null)}
          onCreate={createModel}
        />
      ) : null}

      {candidateProvider && candidateModel && isConcreteDialect(candidateProvider.dialect) ? (
        <CandidateDialog
          open
          provider={candidateProvider}
          targetModel={candidateModel}
          dialect={candidateProvider.dialect}
          catalog={state.catalog}
          demo={demo}
          onClose={() => setCandidate(null)}
          onSearch={searchCandidates}
          onRefreshCatalog={() => refreshCatalog(false)}
          onAdopt={adoptCandidate}
        />
      ) : null}

      {source && inventoryProvider && isConcreteDialect(inventoryProvider.dialect) ? (
        <InventoryDialog
          open
          provider={inventoryProvider}
          dialect={inventoryProvider.dialect}
          demo={demo}
          remaining={Math.max(
            0,
            MAX_EDITS_PER_BATCH - (batchFor(state, source.path)?.edits.length ?? 0),
          )}
          onClose={() => setInventoryProviderId(null)}
          onFetch={() => backend.fetchProviderModels(source.path, inventoryProvider.id)}
          onAdd={addInventoryModels}
        />
      ) : null}

      {dirtyPrompt ? (
        <ConfirmDialog
          open
          title={
            dirtyPrompt.kind === 'scan'
              ? '重新扫描会丢弃草稿'
              : dirtyPrompt.kind === 'load'
                ? '载入前需要丢弃草稿'
                : '重新载入会丢弃草稿'
          }
          eyebrow="DIRTY DRAFTS / 未应用草稿"
          confirmLabel="丢弃草稿并继续"
          tone="danger"
          onClose={() => setDirtyPrompt(null)}
          onConfirm={confirmDirtyIntent}
        >
          <p>
            当前有
            <Badge tone="draft">
              {Object.values(state.batches).reduce((total, batch) => total + batch.edits.length, 0)} 条
            </Badge>
            未应用草稿。继续会让这些草稿失效，并且无法从预演恢复。
          </p>
          {dirtyPrompt.kind === 'scan' ? (
            <p className="muted small">
              将扫描{dirtyPrompt.target ? `项目 ${dirtyPrompt.target}` : '全局配置源'}。若确认继续，界面会先清空草稿。
            </p>
          ) : null}
          {dirtyPrompt.kind === 'load' ? (
            <p className="muted small">
              目标：<code className="mono">{dirtyPrompt.path}</code>
            </p>
          ) : null}
          {dirtyPrompt.kind === 'reload' ? (
            <p className="muted small">
              目标：<code className="mono">{dirtyPrompt.document.path}</code>
            </p>
          ) : null}
          <p className="muted small">
            也可以取消，先回到变更台预演或撤销草稿。桌面应用的写入仍需要预演与单独确认。
          </p>
        </ConfirmDialog>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          open
          title={
            confirm.kind === 'delete-provider'
              ? '删除提供方条目'
              : confirm.kind === 'delete-model'
                ? '删除模型条目'
                : confirm.kind === 'apply'
                  ? '写入磁盘'
                  : '恢复上一备份'
          }
          eyebrow={
            confirm.kind === 'apply'
              ? 'APPLY / 应用'
              : confirm.kind === 'restore'
                ? 'RESTORE / 恢复'
                : 'DELETE / 删除'
          }
          confirmLabel={
            confirm.kind === 'delete-provider'
              ? demo
                ? '暂存删除草稿'
                : '删除提供方'
              : confirm.kind === 'delete-model'
                ? demo
                  ? '暂存删除草稿'
                  : '删除模型'
                : confirm.kind === 'apply'
                  ? '应用并写入'
                  : '恢复上一备份'
          }
          tone={
            confirm.kind === 'delete-provider' || confirm.kind === 'delete-model'
              ? 'danger'
              : 'primary'
          }
          busy={applying}
          onClose={() => setConfirm(null)}
          onConfirm={confirmDestructive}
        >
          {confirm.kind === 'delete-provider' ? (
            <>
              <p>
                将从 <code className="mono">{confirm.sourcePath}</code> 删除提供方
                <code className="mono"> {confirm.provider.id}</code>
                。其 {confirm.provider.models.length} 个模型也会一并移除。
              </p>
              <p className="muted small">
                这是显式删除草稿，仍可撤销。已有条目不会被整体替换；凭据不会在界面显示。
              </p>
            </>
          ) : null}
          {confirm.kind === 'delete-model' ? (
            <>
              <p>
                将从 <code className="mono">{confirm.sourcePath}</code> 删除模型
                <code className="mono"> {confirm.model.id}</code>（提供方 {confirm.provider.id}）。
              </p>
              <p className="muted small">这是显式删除草稿，应用前仍可在变更台撤销。</p>
            </>
          ) : null}
          {confirm.kind === 'apply' ? (
            <>
              <p>
                目标文件：<code className="mono">{state.preview.result?.path}</code>
              </p>
              <p>
                <Badge tone="ok" dot>哈希校验</Badge>{' '}
                写入前会以当前预演基准校验外部改动；成功后创建限制性备份，失败则保留预演与草稿。
              </p>
              <p className="muted small">
                本批次共 {state.preview.result?.editCount ?? 0} 处编辑，只作用于这一个文件。演示模式的此入口不可用。
              </p>
            </>
          ) : null}
          {confirm.kind === 'restore' ? (
            <>
              <p>
                目标文件：<code className="mono">{confirm.source.path}</code>
              </p>
              <p>
                将用当前哈希 <code className="mono">{confirm.source.hash.slice(0, 12)}</code>{' '}
                校验后，恢复本进程为这个文件创建的上一份备份。
              </p>
              <p className="muted small">
                不会恢复任意外部备份，也不会绕过外部改动检查。Demo 模式不可用。
              </p>
            </>
          ) : null}
        </ConfirmDialog>
      ) : null}

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

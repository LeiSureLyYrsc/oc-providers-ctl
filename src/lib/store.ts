import type {
  CatalogResult,
  ChangePreview,
  Dialect,
  Edit,
  SourceDocument,
  WorkspaceSnapshot,
} from '../ipc';
import { DEMO_WRITE_BLOCKED } from '../ipc';
import type { ConcreteDialect } from './paths';
import { pathKey } from './paths';
import type { DraftIntent } from './editRules';
import { validateEdit } from './editRules';

export type View = 'overview' | 'providers' | 'models' | 'sources' | 'checks';
export type Density = 'compact' | 'comfortable';
export type Theme = 'dark' | 'light';
export type Mode = 'demo' | 'native';
export type DraftOrigin = 'manual' | 'suggestion' | 'inventory';
export type DialectFilter = 'all' | 'v1' | 'v2' | 'ambiguous' | 'mixed' | 'invalid';

/** Native core accepts at most 64 edits for one file batch. */
export const MAX_EDITS_PER_BATCH = 64;

export interface Draft {
  id: string;
  path: string[];
  op: 'set' | 'remove';
  value?: unknown;
  intent: DraftIntent;
  label: string;
  origin: DraftOrigin;
  dialect: ConcreteDialect;
}

export interface Batch {
  sourcePath: string;
  sourceHash: string;
  edits: Draft[];
  /** Monotonic revision used to reject late preview results. */
  revision: number;
}

export interface PreviewRequest {
  path: string;
  sourceHash: string;
  revision: number;
}

export interface PreviewState {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'applied' | 'blocked';
  result?: ChangePreview;
  request?: PreviewRequest;
  message?: string;
  applyError?: string;
  demo?: boolean;
}

export interface Notice {
  kind: 'info' | 'success' | 'error';
  text: string;
  seq: number;
}

export interface WorkbenchState {
  mode: Mode;
  snapshot: WorkspaceSnapshot | null;
  scanning: boolean;
  scanError: string | null;
  catalog: CatalogResult | null;
  catalogLoading: boolean;
  view: View;
  density: Density;
  theme: Theme;
  activeSourcePath: string | null;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  query: string;
  dialectFilter: DialectFilter;
  batches: Record<string, Batch>;
  preview: PreviewState;
  applyInFlight: boolean;
  draftRevision: number;
  notice: Notice | null;
  draftSeq: number;
  noticeSeq: number;
}

export interface StageInput {
  sourcePath: string;
  dialect: ConcreteDialect;
  intent: DraftIntent;
  path: string[];
  op: 'set' | 'remove';
  value?: unknown;
  label: string;
  origin?: DraftOrigin;
}

export type Action =
  | { type: 'SCAN_START' }
  | { type: 'SCAN_SUCCESS'; snapshot: WorkspaceSnapshot }
  | { type: 'SCAN_ERROR'; message: string }
  | { type: 'LOAD_START' }
  | { type: 'LOAD_ERROR'; message: string }
  | { type: 'SOURCE_ADDED'; source: SourceDocument }
  | { type: 'SOURCE_UPDATED'; source: SourceDocument; reason: 'apply' | 'restore' }
  | { type: 'SELECT_SOURCE'; path: string }
  | { type: 'SELECT_PROVIDER'; providerId: string | null }
  | { type: 'SELECT_MODEL'; providerId: string; modelId: string }
  | { type: 'SET_VIEW'; view: View }
  | { type: 'SET_QUERY'; query: string }
  | { type: 'SET_DIALECT_FILTER'; dialect: DialectFilter }
  | { type: 'SET_DENSITY'; density: Density }
  | { type: 'SET_THEME'; theme: Theme }
  | { type: 'STAGE'; input: StageInput }
  | { type: 'UNSTAGE'; sourcePath: string; draftId: string }
  | { type: 'CLEAR_BATCH'; sourcePath: string }
  | { type: 'DISCARD_ALL_DRAFTS' }
  | { type: 'PREVIEW_START'; demo: boolean; request: PreviewRequest }
  | { type: 'PREVIEW_RESULT'; result: ChangePreview; demo: boolean }
  | { type: 'PREVIEW_ERROR'; message: string; request: PreviewRequest }
  | { type: 'APPLY_START' }
  | { type: 'APPLY_BLOCKED'; message: string }
  | { type: 'APPLY_ERROR'; message: string }
  | { type: 'CATALOG_START' }
  | { type: 'CATALOG_LOADED'; catalog: CatalogResult }
  | { type: 'CATALOG_ERROR'; message: string }
  | { type: 'NOTICE'; kind: Notice['kind']; text: string }
  | { type: 'DISMISS_NOTICE' };

export function createInitialState(options?: {
  mode?: Mode;
  density?: Density;
  theme?: Theme;
}): WorkbenchState {
  return {
    mode: options?.mode ?? 'demo',
    snapshot: null,
    scanning: false,
    scanError: null,
    catalog: null,
    catalogLoading: false,
    view: 'overview',
    density: options?.density ?? 'compact',
    theme: options?.theme ?? 'dark',
    activeSourcePath: null,
    selectedProviderId: null,
    selectedModelId: null,
    query: '',
    dialectFilter: 'all',
    batches: {},
    preview: { status: 'idle' },
    applyInFlight: false,
    draftRevision: 0,
    notice: null,
    draftSeq: 0,
    noticeSeq: 0,
  };
}

function withNotice(state: WorkbenchState, kind: Notice['kind'], text: string): WorkbenchState {
  return { ...state, notice: { kind, text, seq: state.noticeSeq + 1 }, noticeSeq: state.noticeSeq + 1 };
}

function selectedExists(source: SourceDocument, providerId: string | null, modelId: string | null) {
  if (!providerId) return { providerId: null, modelId: null };
  const provider = source.providers.find((entry) => entry.id === providerId);
  if (!provider) return { providerId: null, modelId: null };
  if (modelId && !provider.models.some((entry) => entry.id === modelId)) {
    return { providerId: provider.id, modelId: null };
  }
  return { providerId: provider.id, modelId };
}

function withFreshDraft(state: WorkbenchState, input: StageInput): WorkbenchState {
  if (state.applyInFlight) {
    return withNotice(state, 'error', '写入进行中，草稿已冻结；请等待应用结果。');
  }
  if (state.preview.status === 'loading') {
    return withNotice(state, 'error', '预演进行中，暂不能修改草稿；请等待预演结果。');
  }
  const source = state.snapshot?.sources.find((entry) => entry.path === input.sourcePath);
  if (!source) {
    return withNotice(state, 'error', '请先选择并载入配置源，再暂存草稿。');
  }
  if (!source.writable) {
    return withNotice(state, 'error', '该配置源为只读，不能暂存草稿。');
  }
  const invalid = validateEdit(
    { op: input.op, path: input.path, value: input.value },
    input.dialect,
    input.intent,
  );
  if (invalid) return withNotice(state, 'error', invalid);

  const existing = state.batches[input.sourcePath];
  const hashFresh = !existing || existing.sourceHash === source.hash;
  const priorEdits = hashFresh ? existing?.edits ?? [] : [];
  const key = `${input.intent}:${pathKey(input.path)}`;
  const previous = priorEdits.find(
    (draft) => `${draft.intent}:${pathKey(draft.path)}` === key,
  );
  const retained = priorEdits.filter(
    (draft) => `${draft.intent}:${pathKey(draft.path)}` !== key,
  );
  if (!previous && retained.length >= MAX_EDITS_PER_BATCH) {
    return withNotice(
      state,
      'error',
      `单个文件每批最多 ${MAX_EDITS_PER_BATCH} 处编辑。请先预演与应用，或撤销部分草稿。`,
    );
  }
  const revision = state.draftRevision + 1;
  const id = `draft-${state.draftSeq + 1}`;
  const draft: Draft = {
    id,
    path: input.path,
    op: input.op,
    value: input.op === 'set' ? input.value : undefined,
    intent: input.intent,
    label: input.label,
    origin: input.origin ?? 'manual',
    dialect: input.dialect,
  };
  const nextBatches = {
    ...state.batches,
    [input.sourcePath]: {
      sourcePath: input.sourcePath,
      sourceHash: source.hash,
      edits: [...retained, draft],
      revision,
    },
  };
  let next: WorkbenchState = {
    ...state,
    batches: nextBatches,
    draftSeq: state.draftSeq + 1,
    draftRevision: revision,
    preview: { status: 'idle' },
  };
  if (!hashFresh) {
    next = withNotice(next, 'info', '磁盘哈希已变化，旧草稿已清空，本次草稿从新状态开始。');
  } else if (previous) {
    next = withNotice(next, 'info', `已更新草稿：${previous.label}。`);
  }
  return next;
}

function clearBatch(state: WorkbenchState, sourcePath: string): WorkbenchState {
  if (state.applyInFlight) {
    return withNotice(state, 'error', '写入进行中，草稿已冻结；请等待应用结果。');
  }
  if (state.preview.status === 'loading') {
    return withNotice(state, 'error', '预演进行中，暂不能清除草稿。');
  }
  const nextBatches = { ...state.batches };
  delete nextBatches[sourcePath];
  return {
    ...state,
    batches: nextBatches,
    draftRevision: state.draftRevision + 1,
    preview: { status: 'idle' },
  };
}

function sameRequest(left: PreviewRequest | undefined, right: PreviewRequest | undefined): boolean {
  if (!left || !right) return false;
  return (
    left.path === right.path &&
    left.sourceHash === right.sourceHash &&
    left.revision === right.revision
  );
}

function previewRequestMatches(state: WorkbenchState, request: PreviewRequest): boolean {
  const active = state.snapshot?.sources.find((source) => source.path === state.activeSourcePath);
  if (!active || active.path !== request.path || active.hash !== request.sourceHash) return false;
  const batch = state.batches[request.path];
  return Boolean(
    batch &&
      batch.sourceHash === request.sourceHash &&
      batch.revision === request.revision &&
      batch.edits.length > 0,
  );
}

export function reducer(state: WorkbenchState, action: Action): WorkbenchState {
  switch (action.type) {
    case 'SCAN_START':
      if (state.applyInFlight) {
        return withNotice(state, 'error', '写入进行中，不能开始扫描。');
      }
      return { ...state, scanning: true, scanError: null };
    case 'SCAN_SUCCESS': {
      if (state.applyInFlight) {
        return withNotice(
          { ...state, scanning: false },
          'info',
          '写入进行中，已忽略这次扫描结果。',
        );
      }
      const snapshot = action.snapshot;
      let activePath = state.activeSourcePath;
      if (!activePath || !snapshot.sources.some((source) => source.path === activePath)) {
        activePath = snapshot.sources[0]?.path ?? null;
      }
      const activeSource = snapshot.sources.find((source) => source.path === activePath) ?? null;
      const selection = activeSource
        ? selectedExists(activeSource, state.selectedProviderId, state.selectedModelId)
        : { providerId: null, modelId: null };
      const nextBatches: Record<string, Batch> = {};
      let kept = 0;
      let dropped = 0;
      Object.entries(state.batches).forEach(([path, batch]) => {
        const nextSource = snapshot.sources.find((source) => source.path === path);
        if (nextSource && nextSource.hash === batch.sourceHash) {
          nextBatches[path] = batch;
          kept += 1;
        } else {
          dropped += 1;
        }
      });
      let next: WorkbenchState = {
        ...state,
        scanning: false,
        scanError: null,
        snapshot,
        activeSourcePath: activePath,
        selectedProviderId: selection.providerId,
        selectedModelId: selection.modelId,
        batches: nextBatches,
        preview: { status: 'idle' },
      };
      if (dropped > 0) {
        next = withNotice(
          next,
          'info',
          `重新扫描后，${dropped} 个草稿批次因配置源哈希变化或消失而被丢弃。`,
        );
      } else if (kept > 0) {
        next = withNotice(next, 'info', '重新扫描后保留了未应用草稿。');
      }
      return next;
    }
    case 'SCAN_ERROR':
      return { ...state, scanning: false, scanError: action.message };
    case 'LOAD_START':
      if (state.applyInFlight) {
        return withNotice(state, 'error', '写入进行中，不能载入配置源。');
      }
      return { ...state, scanning: true, scanError: null };
    case 'LOAD_ERROR':
      return withNotice(
        { ...state, scanning: false, scanError: null },
        'error',
        `载入失败：${action.message}`,
      );
    case 'SOURCE_ADDED': {
      if (state.applyInFlight) {
        return withNotice(state, 'error', '写入进行中，不能载入配置源。');
      }
      const existingBatch = state.batches[action.source.path];
      const keepBatch = Boolean(
        existingBatch && existingBatch.sourceHash === action.source.hash,
      );
      const batches = { ...state.batches };
      if (existingBatch && !keepBatch) {
        delete batches[action.source.path];
      }
      const baseSnapshot = state.snapshot ?? {
        sources: [],
        warnings: [],
        projectPath: null,
      };
      const sources = baseSnapshot.sources.filter((entry) => entry.path !== action.source.path);
      const snapshot = { ...baseSnapshot, sources: [...sources, action.source] };
      const selection = selectedExists(action.source, null, null);
      const conflict = Boolean(existingBatch && !keepBatch);
      return {
        ...state,
        scanning: false,
        scanError: null,
        snapshot,
        activeSourcePath: action.source.path,
        selectedProviderId: selection.providerId,
        selectedModelId: selection.modelId,
        batches,
        preview: { status: 'idle' },
        notice: {
          kind: conflict ? 'info' : 'success',
          text: conflict
            ? '已载入新文档；该文件的旧草稿因哈希变化已丢弃。'
            : '已载入配置源。',
          seq: state.noticeSeq + 1,
        },
        noticeSeq: state.noticeSeq + 1,
      };
    }
    case 'SOURCE_UPDATED': {
      if (!state.snapshot) return state;
      const exists = state.snapshot.sources.some((entry) => entry.path === action.source.path);
      const sources = exists
        ? state.snapshot.sources.map((entry) =>
            entry.path === action.source.path ? action.source : entry,
          )
        : [...state.snapshot.sources, action.source];
      const snapshot = { ...state.snapshot, sources };
      const batches = { ...state.batches };
      delete batches[action.source.path];
      const selection = selectedExists(action.source, state.selectedProviderId, state.selectedModelId);
      return {
        ...state,
        applyInFlight: false,
        scanning: false,
        snapshot,
        activeSourcePath: action.source.path,
        selectedProviderId: selection.providerId,
        selectedModelId: selection.modelId,
        batches,
        preview: {
          status: 'applied',
          message:
            action.reason === 'restore' ? '已恢复本进程创建的上一份备份。' : '变更已写入磁盘。',
          demo: false,
        },
      };
    }
    case 'SELECT_SOURCE': {
      if (state.applyInFlight) {
        return withNotice(state, 'error', '写入进行中，不能切换配置源。');
      }
      const source = state.snapshot?.sources.find((entry) => entry.path === action.path);
      if (!source) return state;
      if (source.path === state.activeSourcePath) return state;
      const selection = selectedExists(source, state.selectedProviderId, state.selectedModelId);
      return {
        ...state,
        activeSourcePath: source.path,
        selectedProviderId: selection.providerId,
        selectedModelId: selection.modelId,
        preview: { status: 'idle' },
      };
    }
    case 'SELECT_PROVIDER':
      return { ...state, selectedProviderId: action.providerId, selectedModelId: null };
    case 'SELECT_MODEL':
      return {
        ...state,
        selectedProviderId: action.providerId,
        selectedModelId: action.modelId,
      };
    case 'SET_VIEW':
      return { ...state, view: action.view };
    case 'SET_QUERY':
      return { ...state, query: action.query };
    case 'SET_DIALECT_FILTER':
      return { ...state, dialectFilter: action.dialect };
    case 'SET_DENSITY':
      return { ...state, density: action.density };
    case 'SET_THEME':
      return { ...state, theme: action.theme };
    case 'STAGE':
      return withFreshDraft(state, action.input);
    case 'UNSTAGE': {
      if (state.applyInFlight) {
        return withNotice(state, 'error', '写入进行中，草稿已冻结；请等待应用结果。');
      }
      if (state.preview.status === 'loading') {
        return withNotice(state, 'error', '预演进行中，暂不能撤销草稿。');
      }
      const batch = state.batches[action.sourcePath];
      if (!batch) return state;
      const edits = batch.edits.filter((draft) => draft.id !== action.draftId);
      const revision = state.draftRevision + 1;
      const nextBatches = { ...state.batches };
      if (edits.length === 0) {
        delete nextBatches[action.sourcePath];
      } else {
        nextBatches[action.sourcePath] = { ...batch, edits, revision };
      }
      return {
        ...state,
        batches: nextBatches,
        draftRevision: revision,
        preview: { status: 'idle' },
      };
    }
    case 'CLEAR_BATCH':
      return clearBatch(state, action.sourcePath);
    case 'DISCARD_ALL_DRAFTS': {
      if (state.applyInFlight) {
        return withNotice(state, 'error', '写入进行中，不能丢弃草稿。');
      }
      if (state.preview.status === 'loading') {
        return withNotice(state, 'error', '预演进行中，暂不能丢弃草稿。');
      }
      return withNotice(
        {
          ...state,
          batches: {},
          draftRevision: state.draftRevision + 1,
          preview: { status: 'idle' },
        },
        'info',
        '已丢弃全部未应用草稿。',
      );
    }
    case 'PREVIEW_START': {
      if (state.applyInFlight) {
        return withNotice(state, 'error', '写入进行中，不能重新预演。');
      }
      if (!previewRequestMatches(state, action.request)) {
        return withNotice(state, 'error', '草稿或配置源已变化，请重新预演。');
      }
      return {
        ...state,
        preview: { status: 'loading', demo: action.demo, request: action.request },
      };
    }
    case 'PREVIEW_RESULT': {
      if (state.preview.status !== 'loading' || !state.preview.request) {
        return state;
      }
      if (!previewRequestMatches(state, state.preview.request)) {
        return { ...state, preview: { status: 'idle' } };
      }
      return {
        ...state,
        preview: {
          status: 'ready',
          result: action.result,
          demo: action.demo,
          request: state.preview.request,
        },
      };
    }
    case 'PREVIEW_ERROR': {
      if (state.preview.status !== 'loading') return state;
      if (state.preview.request && !sameRequest(state.preview.request, action.request)) {
        return state;
      }
      if (!previewRequestMatches(state, action.request)) {
        return { ...state, preview: { status: 'idle' } };
      }
      return {
        ...state,
        preview: { status: 'error', message: action.message, request: action.request },
      };
    }
    case 'APPLY_START': {
      if (state.applyInFlight) return state;
      if (state.mode === 'demo') {
        return {
          ...state,
          applyInFlight: false,
          preview: {
            ...state.preview,
            status: 'blocked',
            message: DEMO_WRITE_BLOCKED,
          },
        };
      }
      const result = state.preview.result;
      const request = state.preview.request;
      const batch = state.activeSourcePath ? state.batches[state.activeSourcePath] : null;
      if (!result || state.preview.status !== 'ready' || !request) {
        return withNotice(state, 'error', '请先完成预演，再应用变更。');
      }
      if (
        result.path !== state.activeSourcePath ||
        !batch ||
        batch.edits.length === 0 ||
        !previewRequestMatches(state, request)
      ) {
        return withNotice(state, 'error', '预演目标与当前草稿不一致，不能应用。');
      }
      return {
        ...state,
        applyInFlight: true,
        preview: { ...state.preview, applyError: undefined },
      };
    }
    case 'APPLY_BLOCKED':
      return {
        ...state,
        applyInFlight: false,
        preview: { ...state.preview, status: 'blocked', message: action.message },
      };
    case 'APPLY_ERROR':
      return {
        ...state,
        applyInFlight: false,
        preview: { ...state.preview, status: 'ready', applyError: action.message },
      };
    case 'CATALOG_START':
      return { ...state, catalogLoading: true };
    case 'CATALOG_LOADED':
      return { ...state, catalogLoading: false, catalog: action.catalog };
    case 'CATALOG_ERROR':
      return {
        ...state,
        catalogLoading: false,
        notice: { kind: 'error', text: action.message, seq: state.noticeSeq + 1 },
        noticeSeq: state.noticeSeq + 1,
      };
    case 'NOTICE':
      return withNotice(state, action.kind, action.text);
    case 'DISMISS_NOTICE':
      return { ...state, notice: null };
    default:
      return state;
  }
}

export function activeSource(state: WorkbenchState): SourceDocument | null {
  if (!state.snapshot || !state.activeSourcePath) return null;
  return state.snapshot.sources.find((source) => source.path === state.activeSourcePath) ?? null;
}

export function batchFor(state: WorkbenchState, sourcePath: string | null): Batch | null {
  if (!sourcePath) return null;
  return state.batches[sourcePath] ?? null;
}

export function draftIndex(batch: Batch | null): Map<string, Draft> {
  const index = new Map<string, Draft>();
  batch?.edits.forEach((draft) => index.set(pathKey(draft.path), draft));
  return index;
}

export function draftForPath(batch: Batch | null, path: string[]): Draft | undefined {
  return draftIndex(batch).get(pathKey(path));
}

export function countModels(source: SourceDocument): number {
  return source.providers.reduce((total, provider) => total + provider.models.length, 0);
}

export function displayDialectFilter(source: SourceDocument): Dialect {
  return source.dialect;
}

export function isEditableSource(source: SourceDocument | null): boolean {
  return Boolean(source?.writable);
}

export function editsToApply(batch: Batch | null): Edit[] {
  if (!batch) return [];
  return batch.edits.map((draft) =>
    draft.op === 'set'
      ? { op: 'set', path: draft.path, value: draft.value }
      : { op: 'remove', path: draft.path },
  );
}

import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

/**
 * The single typed boundary to the Rust shell (see docs/IPC.md).
 * Command names are snake_case; DTO payloads are camelCase.
 */

export type Dialect = 'v1' | 'v2' | 'ambiguous' | 'mixed' | 'invalid';

export type CredentialStatus = 'reference' | 'inline' | 'none';

export interface ModelEntry {
  id: string;
  requestId: string | null;
  name: string | null;
  context: number | null;
  input: number | null;
  output: number | null;
  reasoning: unknown | null;
  variants: unknown | null;
}

export interface ProviderEntry {
  id: string;
  name: string | null;
  dialect: Dialect;
  baseUrl: string | null;
  credentialStatus: CredentialStatus;
  models: ModelEntry[];
}

export interface SourceDocument {
  path: string;
  hash: string;
  dialect: Dialect;
  writable: boolean;
  warnings: string[];
  providers: ProviderEntry[];
  defaultModel: string | null;
}

export interface WorkspaceSnapshot {
  sources: SourceDocument[];
  warnings: string[];
  projectPath: string | null;
}

export interface Edit {
  op: 'set' | 'remove';
  path: string[];
  value?: unknown;
}

export interface ChangePreview {
  previewId: string;
  path: string;
  diff: string;
  warnings: string[];
  editCount: number;
}

export interface CatalogResult {
  modelCount: number;
  fetchedAt: string;
  stale: boolean;
  warnings: string[];
}

export interface ModelCandidate {
  providerId: string;
  id: string;
  name: string;
  canonicalId: string | null;
  context: number | null;
  input: number | null;
  output: number | null;
  reasoning: unknown | null;
  score: number;
  matchReason: string;
}

export interface ProviderInventory {
  providerId: string;
  modelIds: string[];
  fetchedAt: string;
  warnings: string[];
}

/** Commands available to the bundled UI. */
export interface Backend {
  scanConfigs(projectPath: string | null): Promise<WorkspaceSnapshot>;
  loadConfig(path: string): Promise<SourceDocument>;
  previewChanges(path: string, expectedHash: string, edits: Edit[]): Promise<ChangePreview>;
  applyChanges(previewId: string): Promise<SourceDocument>;
  restoreBackup(path: string, expectedHash: string): Promise<SourceDocument>;
  fetchCatalog(): Promise<CatalogResult>;
  matchModels(query: string, providerId: string | null): Promise<ModelCandidate[]>;
  fetchProviderModels(path: string, providerId: string): Promise<ProviderInventory>;
}

export class IpcFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcFailure';
  }
}

const DIALECTS: readonly Dialect[] = ['v1', 'v2', 'ambiguous', 'mixed', 'invalid'];
const CREDENTIAL_STATUSES: readonly CredentialStatus[] = ['reference', 'inline', 'none'];

export const DEMO_WRITE_BLOCKED =
  '演示模式不会写入磁盘。请启动桌面应用，在那里预演并应用这次变更。';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Collapse backend failures into a short, single-line user-facing message. */
export function toSafeMessage(error: unknown): string {
  let raw: string;
  if (typeof error === 'string') {
    raw = error;
  } else if (error instanceof Error) {
    raw = error.message;
  } else if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    raw = typeof message === 'string' ? message : '';
  } else {
    raw = '';
  }
  if (!raw) {
    return '操作失败，未能获得可读的原因。';
  }
  const cleaned = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[已隐藏]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bounded = cleaned.length > 240 ? `${cleaned.slice(0, 237)}…` : cleaned;
  return bounded || '操作失败，未能获得可读的原因。';
}

function contractError(what: string): IpcFailure {
  return new IpcFailure(`配置数据格式异常（${what}），未继续读取。`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError(what);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, what: string): string {
  if (typeof value !== 'string') throw contractError(what);
  return value;
}

function nullableString(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw contractError(what);
  return value;
}

function nullableNumber(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw contractError(what);
  return value;
}

function stringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw contractError(what);
  }
  return value as string[];
}

function dialectValue(value: unknown, what: string): Dialect {
  if (typeof value !== 'string' || !DIALECTS.includes(value as Dialect)) {
    throw contractError(what);
  }
  return value as Dialect;
}

function credentialValue(value: unknown, what: string): CredentialStatus {
  if (typeof value !== 'string' || !CREDENTIAL_STATUSES.includes(value as CredentialStatus)) {
    throw contractError(what);
  }
  return value as CredentialStatus;
}

function normalizeModel(value: unknown, what: string): ModelEntry {
  const model = record(value, what);
  return {
    id: stringValue(model.id, `${what}.id`),
    requestId: nullableString(model.requestId, `${what}.requestId`),
    name: nullableString(model.name, `${what}.name`),
    context: nullableNumber(model.context, `${what}.context`),
    input: nullableNumber(model.input, `${what}.input`),
    output: nullableNumber(model.output, `${what}.output`),
    reasoning: model.reasoning === undefined ? null : model.reasoning,
    variants: model.variants === undefined ? null : model.variants,
  };
}

function normalizeProvider(value: unknown, what: string): ProviderEntry {
  const provider = record(value, what);
  if (!Array.isArray(provider.models)) throw contractError(`${what}.models`);
  return {
    id: stringValue(provider.id, `${what}.id`),
    name: nullableString(provider.name, `${what}.name`),
    dialect: dialectValue(provider.dialect, `${what}.dialect`),
    baseUrl: nullableString(provider.baseUrl, `${what}.baseUrl`),
    credentialStatus: credentialValue(provider.credentialStatus, `${what}.credentialStatus`),
    models: provider.models.map((model, index) => normalizeModel(model, `${what}.models[${index}]`)),
  };
}

export function normalizeSourceDocument(value: unknown): SourceDocument {
  const source = record(value, 'SourceDocument');
  if (!Array.isArray(source.providers)) throw contractError('SourceDocument.providers');
  return {
    path: stringValue(source.path, 'SourceDocument.path'),
    hash: stringValue(source.hash, 'SourceDocument.hash'),
    dialect: dialectValue(source.dialect, 'SourceDocument.dialect'),
    writable: source.writable === true,
    warnings: stringArray(source.warnings ?? [], 'SourceDocument.warnings'),
    providers: source.providers.map((provider, index) =>
      normalizeProvider(provider, `SourceDocument.providers[${index}]`),
    ),
    defaultModel: nullableString(source.defaultModel, 'SourceDocument.defaultModel'),
  };
}

export function normalizeSnapshot(value: unknown): WorkspaceSnapshot {
  const snapshot = record(value, 'WorkspaceSnapshot');
  if (!Array.isArray(snapshot.sources)) throw contractError('WorkspaceSnapshot.sources');
  return {
    sources: snapshot.sources.map((source) => normalizeSourceDocument(source)),
    warnings: stringArray(snapshot.warnings ?? [], 'WorkspaceSnapshot.warnings'),
    projectPath: nullableString(snapshot.projectPath, 'WorkspaceSnapshot.projectPath'),
  };
}

export function normalizeChangePreview(value: unknown): ChangePreview {
  const preview = record(value, 'ChangePreview');
  return {
    previewId: stringValue(preview.previewId, 'ChangePreview.previewId'),
    path: stringValue(preview.path, 'ChangePreview.path'),
    diff: stringValue(preview.diff, 'ChangePreview.diff'),
    warnings: stringArray(preview.warnings ?? [], 'ChangePreview.warnings'),
    editCount: nullableNumber(preview.editCount, 'ChangePreview.editCount') ?? 0,
  };
}

export function normalizeCatalogResult(value: unknown): CatalogResult {
  const catalog = record(value, 'CatalogResult');
  return {
    modelCount: nullableNumber(catalog.modelCount, 'CatalogResult.modelCount') ?? 0,
    fetchedAt: stringValue(catalog.fetchedAt, 'CatalogResult.fetchedAt'),
    stale: catalog.stale === true,
    warnings: stringArray(catalog.warnings ?? [], 'CatalogResult.warnings'),
  };
}

export function normalizeCandidate(value: unknown, what = 'ModelCandidate'): ModelCandidate {
  const candidate = record(value, what);
  const score = nullableNumber(candidate.score, `${what}.score`);
  return {
    providerId: stringValue(candidate.providerId, `${what}.providerId`),
    id: stringValue(candidate.id, `${what}.id`),
    name: stringValue(candidate.name, `${what}.name`),
    canonicalId: nullableString(candidate.canonicalId, `${what}.canonicalId`),
    context: nullableNumber(candidate.context, `${what}.context`),
    input: nullableNumber(candidate.input, `${what}.input`),
    output: nullableNumber(candidate.output, `${what}.output`),
    reasoning: candidate.reasoning === undefined ? null : candidate.reasoning,
    score: score ?? 0,
    matchReason: stringValue(candidate.matchReason, `${what}.matchReason`),
  };
}

export function normalizeInventory(value: unknown): ProviderInventory {
  const inventory = record(value, 'ProviderInventory');
  return {
    providerId: stringValue(inventory.providerId, 'ProviderInventory.providerId'),
    modelIds: stringArray(inventory.modelIds, 'ProviderInventory.modelIds'),
    fetchedAt: stringValue(inventory.fetchedAt, 'ProviderInventory.fetchedAt'),
    warnings: stringArray(inventory.warnings ?? [], 'ProviderInventory.warnings'),
  };
}

export type InvokeTransport = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

async function call<T>(
  transport: InvokeTransport,
  command: string,
  args: Record<string, unknown> | undefined,
  normalize: (raw: unknown) => T,
): Promise<T> {
  try {
    const raw = await transport(command, args);
    return normalize(raw);
  } catch (error) {
    throw new IpcFailure(toSafeMessage(error));
  }
}

/** Native client. `transport` is injectable so contract handling stays testable. */
export function createNativeBackend(transport: InvokeTransport = invoke): Backend {
  return {
    scanConfigs: (projectPath) =>
      call(transport, 'scan_configs', { projectPath }, normalizeSnapshot),
    loadConfig: (path) => call(transport, 'load_config', { path }, normalizeSourceDocument),
    previewChanges: (path, expectedHash, edits) =>
      call(transport, 'preview_changes', { path, expectedHash, edits }, normalizeChangePreview),
    applyChanges: (previewId) =>
      call(transport, 'apply_changes', { previewId }, normalizeSourceDocument),
    restoreBackup: (path, expectedHash) =>
      call(transport, 'restore_backup', { path, expectedHash }, normalizeSourceDocument),
    fetchCatalog: () => call(transport, 'fetch_catalog', undefined, normalizeCatalogResult),
    matchModels: (query, providerId) =>
      call(transport, 'match_models', { query, providerId }, (raw) => {
        if (!Array.isArray(raw)) throw contractError('ModelCandidate[]');
        return raw.map((entry, index) => normalizeCandidate(entry, `ModelCandidate[${index}]`));
      }),
    fetchProviderModels: (path, providerId) =>
      call(transport, 'fetch_provider_models', { path, providerId }, normalizeInventory),
  };
}

export const nativeBackend: Backend = createNativeBackend();

/** Native picker. The shell opens the dialog, registers the canonical path, then authorizes load_config. */
export async function pickConfigFile(): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw new IpcFailure('文件选择器仅在桌面应用中可用。');
  }
  try {
    const picked = await invoke('pick_config_path');
    if (picked === null || picked === undefined) return null;
    if (typeof picked !== 'string' || !picked.trim()) {
      throw new IpcFailure('文件选择器没有返回有效路径。');
    }
    return picked;
  } catch (error) {
    throw new IpcFailure(toSafeMessage(error));
  }
}

export async function pickProjectFolder(): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw new IpcFailure('目录选择器仅在桌面应用中可用。');
  }
  try {
    const picked = await openDialog({
      multiple: false,
      directory: true,
      title: '选择项目目录',
    });
    return typeof picked === 'string' ? picked : null;
  } catch (error) {
    throw new IpcFailure(toSafeMessage(error));
  }
}

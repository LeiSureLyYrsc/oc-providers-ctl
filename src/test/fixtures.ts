import type {
  ChangePreview,
  ModelCandidate,
  SourceDocument,
  WorkspaceSnapshot,
} from '../ipc';

/**
 * Contract fixture mirroring a real backend V2 DTO:
 * `providers[].models` is an object map on disk; the DTO exposes it as an ordered
 * ModelEntry[] whose `id` is the map key. `requestId` mirrors optional `modelID`.
 */
export const V2_NATIVE_SOURCE: SourceDocument = {
  path: 'C:\\Users\\demo\\AppData\\Roaming\\opencode\\opencode.jsonc',
  hash: '9f2c1a7b4e6d8035a1c9e2f4b7d06a38',
  dialect: 'v2',
  writable: true,
  warnings: [],
  defaultModel: 'gateway/upstream/coder',
  providers: [
    {
      id: 'gateway',
      name: 'Gateway',
      dialect: 'v2',
      baseUrl: 'https://gateway.example/v1',
      credentialStatus: 'reference',
      models: [
        {
          id: 'upstream/coder',
          requestId: 'vendor-request-id-42',
          name: 'Upstream Coder',
          context: 200000,
          input: 180000,
          output: 32000,
          reasoning: {
            supported: true,
            toggle: true,
            effort: ['low', 'high'],
            budget: { min: 0, max: 8192 },
          },
          variants: [{ id: 'fast', name: '快速' }],
        },
        {
          id: 'plain.model',
          requestId: null,
          name: null,
          context: 131072,
          input: null,
          output: 8192,
          reasoning: { supported: false },
          variants: null,
        },
      ],
    },
  ],
};

export const V1_NATIVE_SOURCE: SourceDocument = {
  path: 'C:\\Users\\demo\\.config\\opencode\\opencode.json',
  hash: '11223344556677889900aabbccddeeff',
  dialect: 'v1',
  writable: true,
  warnings: [],
  defaultModel: 'zhipu/glm-4.6',
  providers: [
    {
      id: 'zhipu',
      name: '智谱 GLM',
      dialect: 'v1',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      credentialStatus: 'reference',
      models: [
        {
          id: 'glm-4.6',
          requestId: null,
          name: 'GLM-4.6',
          context: 200000,
          input: null,
          output: 131072,
          reasoning: true,
          variants: { high: { reasoning: true }, low: { reasoning: false } },
        },
      ],
    },
  ],
};

export const SECOND_SOURCE: SourceDocument = {
  path: 'C:\\Users\\demo\\.config\\opencode\\second.jsonc',
  hash: 'ffeeddccbbaa99887766554433221100',
  dialect: 'v1',
  writable: true,
  warnings: [],
  defaultModel: null,
  providers: [],
};

export function snapshotOf(sources: SourceDocument[], projectPath: string | null = null): WorkspaceSnapshot {
  return { sources, warnings: [], projectPath };
}

export function makePreview(path: string, editCount = 1): ChangePreview {
  return {
    previewId: 'preview-1',
    path,
    diff: '~ limit.context\n- 200000\n+ 262144',
    warnings: [],
    editCount,
  };
}

export function makeCandidate(overrides: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    providerId: 'gateway',
    id: 'upstream/coder',
    name: 'Upstream Coder',
    canonicalId: 'gateway/upstream/coder',
    context: 262144,
    input: 180000,
    output: 32768,
    reasoning: {
      supported: true,
      toggle: true,
      effort: ['low', 'high'],
      budget: { min: 0, max: 16384 },
    },
    score: 0.97,
    matchReason: '标识完全匹配 · 目录缓存',
    ...overrides,
  };
}

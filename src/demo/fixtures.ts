import type {
  CatalogResult,
  ModelCandidate,
  ProviderInventory,
  SourceDocument,
  WorkspaceSnapshot,
} from '../ipc';

/**
 * Deterministic, clearly fictitious demo data for browser preview.
 * No real user paths, credentials, or network results are embedded here.
 */

export const DEMO_PROJECT_PATH = 'C:\\demo\\work\\acme-gateway';

export const DEMO_PATHS = {
  globalV1: 'C:\\demo\\home\\.config\\opencode\\opencode.json',
  projectV2: 'C:\\demo\\work\\acme-gateway\\opencode.jsonc',
  mixed: 'C:\\demo\\home\\.config\\opencode\\opencode.jsonc',
  legacy: 'C:\\demo\\home\\.config\\opencode\\legacy.jsonc',
} as const;

const GLOBAL_V1: SourceDocument = {
  path: DEMO_PATHS.globalV1,
  hash: '8f3a1c47d2b95e60871c4a5d3e9f0b26',
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
          variants: null,
        },
        {
          id: 'glm-4.5-air',
          requestId: null,
          name: 'GLM-4.5 Air',
          context: 131072,
          input: null,
          output: 98304,
          reasoning: true,
          variants: { low: { reasoning: false }, high: { reasoning: true } },
        },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      dialect: 'v1',
      baseUrl: 'https://api.deepseek.com/v1',
      credentialStatus: 'reference',
      models: [
        {
          id: 'deepseek-chat',
          requestId: null,
          name: 'DeepSeek Chat',
          context: 131072,
          input: null,
          output: 8192,
          reasoning: false,
          variants: null,
        },
        {
          id: 'deepseek-reasoner',
          requestId: null,
          name: 'DeepSeek Reasoner',
          context: 131072,
          input: null,
          output: 65536,
          reasoning: true,
          variants: null,
        },
      ],
    },
    {
      id: 'lm-studio',
      name: null,
      dialect: 'v1',
      baseUrl: null,
      credentialStatus: 'none',
      models: [
        {
          id: 'qwen3-4b',
          requestId: null,
          name: null,
          context: null,
          input: null,
          output: null,
          reasoning: null,
          variants: null,
        },
      ],
    },
  ],
};

const PROJECT_V2: SourceDocument = {
  path: DEMO_PATHS.projectV2,
  hash: '1d7e4b0a9c3f58216dae07b4f9c2e358',
  dialect: 'v2',
  writable: true,
  warnings: [],
  defaultModel: 'moonshot/kimi-k2-0905-preview',
  providers: [
    {
      id: 'moonshot',
      name: 'Moonshot Kimi',
      dialect: 'v2',
      baseUrl: 'https://api.moonshot.cn/v1',
      credentialStatus: 'reference',
      models: [
        {
          id: 'kimi-k2-0905-preview',
          requestId: 'kimi-k2-preview-0905',
          name: 'Kimi K2',
          context: 262144,
          input: 262144,
          output: 16384,
          reasoning: {
            supported: true,
            toggle: true,
            effort: ['low', 'high'],
            budget: { min: 0, max: 16384 },
          },
          variants: [
            { id: 'thinking', name: '思考' },
            { id: 'fast' },
          ],
        },
        {
          id: 'kimi-k2-turbo-preview',
          requestId: null,
          name: 'Kimi K2 Turbo',
          context: 262144,
          input: null,
          output: 32768,
          reasoning: { supported: false },
          variants: null,
        },
        {
          id: 'kimi-k2-thinking',
          requestId: 'kimi-k2-thinking-0905',
          name: 'Kimi K2 Thinking',
          context: 262144,
          input: null,
          output: 32768,
          reasoning: {
            supported: true,
            effort: ['low', 'medium', 'high'],
            budget: { min: 0, max: 32768 },
          },
          variants: null,
        },
      ],
    },
    {
      id: 'local-lm',
      name: '局域网推理',
      dialect: 'v2',
      baseUrl: 'http://127.0.0.1:11434/v1',
      credentialStatus: 'inline',
      models: [
        {
          id: 'qwen3-30b-a3b',
          requestId: null,
          name: 'Qwen3 30B A3B',
          context: 40960,
          input: null,
          output: 8192,
          reasoning: { supported: true, toggle: false },
          variants: null,
        },
      ],
    },
  ],
};

const MIXED: SourceDocument = {
  path: DEMO_PATHS.mixed,
  hash: '6b2c9f40d81a3e5760d2b8a41c9e7f05',
  dialect: 'mixed',
  writable: true,
  warnings: [
    '顶层同时存在 provider（V1）与 providers（V2）。新建提供方必须明确目标方言。',
  ],
  defaultModel: null,
  providers: [
    {
      id: 'azure-foundry',
      name: 'Azure Foundry',
      dialect: 'v1',
      baseUrl: 'https://example-resource.openai.azure.com/openai/v1',
      credentialStatus: 'reference',
      models: [
        {
          id: 'gpt-5-mini',
          requestId: null,
          name: 'GPT-5 mini',
          context: 400000,
          input: 272000,
          output: 128000,
          reasoning: true,
          variants: null,
        },
        {
          id: 'gpt-5-nano',
          requestId: null,
          name: 'GPT-5 nano',
          context: 400000,
          input: 272000,
          output: 128000,
          reasoning: false,
          variants: null,
        },
      ],
    },
    {
      id: 'ollama-cloud',
      name: 'Ollama 云',
      dialect: 'v2',
      baseUrl: 'https://ollama.com/v1',
      credentialStatus: 'reference',
      models: [
        {
          id: 'qwen3-coder-480b',
          requestId: null,
          name: 'Qwen3 Coder 480B',
          context: 262144,
          input: null,
          output: 65536,
          reasoning: { supported: true, effort: ['low', 'high'] },
          variants: null,
        },
      ],
    },
  ],
};

const LEGACY: SourceDocument = {
  path: DEMO_PATHS.legacy,
  hash: 'c04d7a1e5f92b36820ac5e1d77b9f4a8',
  dialect: 'invalid',
  writable: false,
  warnings: [
    '提供方 legacy 的模型列表同时出现对象键与数组，无法安全定位。此文件以只读方式载入。',
  ],
  defaultModel: null,
  providers: [
    {
      id: 'legacy',
      name: 'Legacy Gateway',
      dialect: 'invalid',
      baseUrl: null,
      credentialStatus: 'inline',
      models: [
        {
          id: 'gpt-4o-mini',
          requestId: null,
          name: null,
          context: null,
          input: null,
          output: null,
          reasoning: null,
          variants: null,
        },
      ],
    },
  ],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function demoScan(projectPath: string | null): WorkspaceSnapshot {
  const projectMatches =
    Boolean(projectPath) && normalizePath(projectPath as string) === normalizePath(DEMO_PROJECT_PATH);
  const sources = projectMatches
    ? [GLOBAL_V1, PROJECT_V2, MIXED, LEGACY]
    : [GLOBAL_V1, MIXED, LEGACY];
  return {
    sources: clone(sources),
    warnings:
      projectPath && !projectMatches
        ? [`演示数据只覆盖虚构项目 ${DEMO_PROJECT_PATH}；已返回全局配置源。`]
        : [],
    projectPath: projectPath ?? null,
  };
}

export function demoLoad(path: string): SourceDocument {
  const wanted = normalizePath(path);
  const source = [GLOBAL_V1, PROJECT_V2, MIXED, LEGACY].find(
    (entry) => normalizePath(entry.path) === wanted,
  );
  if (!source) {
    throw new Error(
      '演示模式中没有这个配置源。可载入 C:\\demo\\home\\.config\\opencode\\opencode.json 或使用「扫描全局」。',
    );
  }
  return clone(source);
}

export const DEMO_CATALOG: CatalogResult = {
  modelCount: 24,
  fetchedAt: '2026-11-17T09:40:00Z',
  stale: false,
  warnings: [],
};

export const DEMO_CANDIDATES: ModelCandidate[] = [
  {
    providerId: 'moonshot',
    id: 'kimi-k2-0905-preview',
    name: 'Kimi K2',
    canonicalId: 'moonshot/kimi-k2-0905-preview',
    context: 262144,
    input: 262144,
    output: 16384,
    reasoning: { supported: true, toggle: true, effort: ['low', 'high'], budget: { min: 0, max: 16384 } },
    score: 0.98,
    matchReason: '标识完全匹配',
  },
  {
    providerId: 'moonshot',
    id: 'kimi-k2-turbo-preview',
    name: 'Kimi K2 Turbo',
    canonicalId: 'moonshot/kimi-k2-turbo-preview',
    context: 262144,
    input: null,
    output: 32768,
    reasoning: { supported: false },
    score: 0.91,
    matchReason: '标识前缀匹配',
  },
  {
    providerId: 'moonshot',
    id: 'kimi-k2-thinking',
    name: 'Kimi K2 Thinking',
    canonicalId: 'moonshot/kimi-k2-thinking',
    context: 262144,
    input: null,
    output: 32768,
    reasoning: { supported: true, effort: ['low', 'medium', 'high'], budget: { min: 0, max: 32768 } },
    score: 0.86,
    matchReason: '标识片段匹配',
  },
  {
    providerId: 'zhipu',
    id: 'glm-4.6',
    name: 'GLM-4.6',
    canonicalId: 'zhipu/glm-4.6',
    context: 200000,
    input: null,
    output: 131072,
    reasoning: { supported: true, toggle: true },
    score: 0.97,
    matchReason: '标识完全匹配',
  },
  {
    providerId: 'zhipu',
    id: 'glm-4.6-air',
    name: 'GLM-4.6 Air',
    canonicalId: 'zhipu/glm-4.6-air',
    context: 131072,
    input: null,
    output: 65536,
    reasoning: { supported: true },
    score: 0.82,
    matchReason: '名称前缀匹配',
  },
  {
    providerId: 'deepseek',
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    canonicalId: 'deepseek/deepseek-chat',
    context: 131072,
    input: null,
    output: 8192,
    reasoning: { supported: false },
    score: 0.95,
    matchReason: '标识完全匹配',
  },
  {
    providerId: 'deepseek',
    id: 'deepseek-v3.2',
    name: 'DeepSeek V3.2',
    canonicalId: 'deepseek/deepseek-v3.2',
    context: 163840,
    input: null,
    output: 32768,
    reasoning: { supported: true, toggle: true, effort: ['low', 'high'], budget: { min: 0, max: 16384 } },
    score: 0.79,
    matchReason: '名称片段匹配',
  },
  {
    providerId: 'ollama-cloud',
    id: 'qwen3-coder-480b',
    name: 'Qwen3 Coder 480B',
    canonicalId: 'ollama/qwen3-coder-480b',
    context: 262144,
    input: null,
    output: 65536,
    reasoning: { supported: true, effort: ['low', 'high'] },
    score: 0.93,
    matchReason: '标识完全匹配',
  },
  {
    providerId: 'azure-foundry',
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    canonicalId: 'azure/gpt-5-mini',
    context: 400000,
    input: 272000,
    output: 128000,
    reasoning: { supported: true, toggle: true, budget: { min: 0, max: 128000 } },
    score: 0.9,
    matchReason: '标识完全匹配',
  },
  {
    providerId: 'local-lm',
    id: 'qwen3-30b-a3b',
    name: 'Qwen3 30B A3B',
    canonicalId: 'local/qwen3-30b-a3b',
    context: 40960,
    input: null,
    output: 8192,
    reasoning: { supported: true },
    score: 0.76,
    matchReason: '标识完全匹配',
  },
];

export const DEMO_INVENTORIES: Record<string, ProviderInventory> = {
  zhipu: {
    providerId: 'zhipu',
    modelIds: ['glm-4.6', 'glm-4.5-air', 'glm-4-plus', 'glm-4-air-250414'],
    fetchedAt: '2026-11-17T10:05:00Z',
    warnings: [],
  },
  deepseek: {
    providerId: 'deepseek',
    modelIds: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2'],
    fetchedAt: '2026-11-17T10:05:00Z',
    warnings: [],
  },
  moonshot: {
    providerId: 'moonshot',
    modelIds: [
      'kimi-k2-0905-preview',
      'kimi-k2-turbo-preview',
      'kimi-k2-thinking',
      'moonshot-v1-128k',
      'moonshot-v1-32k',
    ],
    fetchedAt: '2026-11-17T10:05:00Z',
    warnings: [],
  },
  'local-lm': {
    providerId: 'local-lm',
    modelIds: ['qwen3-30b-a3b', 'qwen3-8b', 'qwen2.5-coder-32b'],
    fetchedAt: '2026-11-17T10:05:00Z',
    warnings: [],
  },
  'azure-foundry': {
    providerId: 'azure-foundry',
    modelIds: ['gpt-5-mini', 'gpt-5-nano', 'text-embedding-3-large'],
    fetchedAt: '2026-11-17T10:05:00Z',
    warnings: [],
  },
  'ollama-cloud': {
    providerId: 'ollama-cloud',
    modelIds: ['qwen3-coder-480b', 'deepseek-v3.2', 'kimi-k2:1t'],
    fetchedAt: '2026-11-17T10:05:00Z',
    warnings: [],
  },
  'lm-studio': {
    providerId: 'lm-studio',
    modelIds: ['qwen3-4b', 'qwen3-1.7b', 'gemma3-4b'],
    fetchedAt: '2026-11-17T10:05:00Z',
    warnings: [],
  },
};

export function demoMatch(query: string, providerId: string | null): ModelCandidate[] {
  const needle = query.trim().toLowerCase();
  const scoped = DEMO_CANDIDATES.filter(
    (candidate) => !providerId || candidate.providerId === providerId,
  );
  const matches = scoped
    .filter((candidate) => {
      if (!needle) return true;
      return (
        candidate.id.toLowerCase().includes(needle) ||
        candidate.name.toLowerCase().includes(needle) ||
        (candidate.canonicalId ?? '').toLowerCase().includes(needle)
      );
    })
    .map((candidate) => ({
      ...candidate,
      matchReason: !needle
        ? '提供方范围 · 本地目录'
        : candidate.id.toLowerCase() === needle
          ? '标识完全匹配'
          : candidate.name.toLowerCase() === needle
            ? '名称完全匹配'
            : candidate.id.toLowerCase().startsWith(needle)
              ? '标识前缀匹配'
              : '标识或名称片段匹配',
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  return clone(matches);
}

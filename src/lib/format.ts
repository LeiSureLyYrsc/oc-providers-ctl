import type { CredentialStatus, Dialect, ProviderEntry, SourceDocument } from '../ipc';

const TOKEN_FORMAT = new Intl.NumberFormat('en-US');

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return TOKEN_FORMAT.format(value);
}

export function compactValue(value: unknown, maxLength = 88): string {
  if (value === undefined) return '未设置';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return '无法显示';
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  } catch {
    return '无法显示';
  }
}

export function shortHash(hash: string, length = 8): string {
  if (!hash) return '—';
  return hash.length > length ? hash.slice(0, length) : hash;
}

/** Show the backend-provided timestamp as a stable UTC label; never invent freshness. */
export function formatTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    value,
  );
  if (!match) return value.length > 32 ? `${value.slice(0, 32)}…` : value;
  const zone = match[3] === 'Z' || !match[3] ? 'Z' : match[3];
  return `${match[1]} ${match[2]} ${zone}`;
}

export const DIALECT_META: Record<Dialect, { label: string; detail: string }> = {
  v1: { label: 'V1', detail: 'provider' },
  v2: { label: 'V2', detail: 'providers' },
  ambiguous: { label: '待定', detail: '需明确方言' },
  mixed: { label: '并存', detail: 'V1 + V2' },
  invalid: { label: '无效', detail: '只读结构' },
};

export function dialectLabel(dialect: Dialect): string {
  return DIALECT_META[dialect]?.label ?? dialect;
}

export function credentialLabel(status: CredentialStatus): string {
  switch (status) {
    case 'reference':
      return '外部引用';
    case 'inline':
      return '内联凭据';
    case 'none':
      return '未设置';
  }
}

export function credentialHint(status: CredentialStatus): string {
  switch (status) {
    case 'reference':
      return '界面不接收、不显示、不修改具体值；手动拉取清单时仅由后端解析已有凭证。';
    case 'inline':
      return '配置中内联了凭据。界面不接收、不显示、不修改具体值；手动拉取清单时仅由后端解析已有凭证。';
    case 'none':
      return '未检测到显式凭据；界面不判断认证是否另有来源。';
  }
}

export function providerWritable(provider: ProviderEntry, source: SourceDocument): boolean {
  return source.writable && (provider.dialect === 'v1' || provider.dialect === 'v2');
}

export function providerDialect(provider: ProviderEntry, source: SourceDocument): Dialect {
  return provider.dialect === 'ambiguous' ? source.dialect : provider.dialect;
}

export function sourceScope(path: string, projectPath: string | null): '项目内' | '项目外' {
  if (!projectPath) return '项目外';
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const source = normalize(path);
  const project = normalize(projectPath);
  if (!project) return '项目外';
  return source === project || source.startsWith(`${project}/`) ? '项目内' : '项目外';
}

export function isModelDefault(source: SourceDocument, providerId: string, modelId: string): boolean {
  return source.defaultModel === `${providerId}/${modelId}`;
}

export function variantSummary(value: unknown, dialect: Dialect): string {
  if (value === null || value === undefined) return '—';
  if (dialect === 'v1') {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const count = Object.keys(value).length;
      return count === 0 ? '空对象' : `${count} 个变体`;
    }
    return '结构未知';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '空数组' : `${value.length} 项`;
  }
  return '结构未知';
}

/** Defense in depth: previews crossing the boundary never surface credential values. */
export function maskSecretsInDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  return lines
    .map((line) => {
      const secretLine =
        /(api[-_]?key|apikey|authorization|password|secret|access[-_]?token|refresh[-_]?token|client[-_]?secret)/i.test(
          line,
        );
      const withoutBearer = line.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]');
      if (!secretLine) return withoutBearer.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[已隐藏]');
      return withoutBearer.replace(/([:=]\s*)(.+)$/, (_match, prefix: string) => `${prefix}[已隐藏]`);
    })
    .join('\n');
}

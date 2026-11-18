import type { ReactNode } from 'react';
import type { CredentialStatus, Dialect } from '../ipc';
import type { DraftOrigin } from '../lib/store';
import { DIALECT_META } from '../lib/format';

export type BadgeTone =
  | 'dialect-v1'
  | 'dialect-v2'
  | 'dialect-ambiguous'
  | 'dialect-mixed'
  | 'dialect-invalid'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'info'
  | 'muted'
  | 'accent'
  | 'read'
  | 'draft'
  | 'suggestion'
  | 'inventory';

interface BadgeProps {
  tone: BadgeTone;
  children: ReactNode;
  dot?: boolean;
  title?: string;
  className?: string;
}

export function Badge({ tone, children, dot, title, className }: BadgeProps) {
  return (
    <span
      className={`badge tone-${tone}${className ? ` ${className}` : ''}`}
      data-tone={tone}
      title={title}
    >
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function DialectBadge({ dialect }: { dialect: Dialect }) {
  const meta = DIALECT_META[dialect];
  return (
    <Badge
      tone={
        dialect === 'v1'
          ? 'dialect-v1'
          : dialect === 'v2'
            ? 'dialect-v2'
            : dialect === 'invalid'
              ? 'dialect-invalid'
              : dialect === 'mixed'
                ? 'dialect-mixed'
                : 'dialect-ambiguous'
      }
      title={`${meta.label} · ${meta.detail}`}
      className="dialect-badge"
    >
      {meta.label}
      <span className="dialect-detail">{meta.detail}</span>
    </Badge>
  );
}

const credentialTone: Record<CredentialStatus, BadgeTone> = {
  reference: 'read',
  inline: 'muted',
  none: 'muted',
};

export function CredentialBadge({ status }: { status: CredentialStatus }) {
  const text = status === 'reference' ? '外部引用' : status === 'inline' ? '内联凭据' : '无凭据';
  return (
    <Badge tone={credentialTone[status]} title="凭据状态；本界面不显示具体值">
      {status === 'inline' ? <span className="cred-inline-mark" aria-hidden="true" /> : null}
      {text}
    </Badge>
  );
}

const ORIGIN_META: Record<DraftOrigin | 'read', { label: string; tone: BadgeTone }> = {
  read: { label: '读取', tone: 'read' },
  suggestion: { label: '建议', tone: 'suggestion' },
  inventory: { label: '清单', tone: 'inventory' },
  manual: { label: '草稿', tone: 'draft' },
};

export function ProvenanceTag({ origin }: { origin: DraftOrigin | 'read' }) {
  const meta = ORIGIN_META[origin];
  return (
    <Badge tone={meta.tone} className="prov-tag">
      <span className="prov-dot" aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: 'error' | 'warning' | 'info' }) {
  if (severity === 'error') return <Badge tone="danger" dot>错误</Badge>;
  if (severity === 'warning') return <Badge tone="warn" dot>提示</Badge>;
  return <Badge tone="info" dot>信息</Badge>;
}

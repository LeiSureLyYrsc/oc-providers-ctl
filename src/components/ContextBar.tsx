import type { SourceDocument } from '../ipc';
import { isModelDefault, sourceScope, shortHash } from '../lib/format';
import { Badge, DialectBadge } from './Badge';
import { Icon } from './Icon';

interface ContextBarProps {
  source: SourceDocument | null;
  sources: SourceDocument[];
  projectPath: string | null;
  onSelect: (path: string) => void;
}

export function ContextBar({ source, sources, projectPath, onSelect }: ContextBarProps) {
  if (!source) {
    return (
      <div className="contextbar contextbar-empty">
        <span className="eyebrow">CONTEXT / 当前配置源</span>
        <span className="muted small">未选择配置源。扫描或载入后会显示文件、方言与哈希。</span>
      </div>
    );
  }

  const modelCount = source.providers.reduce((total, provider) => total + provider.models.length, 0);
  const defaultModel = source.defaultModel;
  const defaultExists = Boolean(
    defaultModel &&
      source.providers.some((provider) =>
        provider.models.some((model) => isModelDefault(source, provider.id, model.id)),
      ),
  );

  return (
    <div className="contextbar">
      <label className="source-select-wrap">
        <span className="eyebrow">SOURCE / 当前配置源</span>
        <select
          value={source.path}
          onChange={(event) => onSelect(event.target.value)}
          aria-label="选择当前配置源"
          className="source-select mono"
        >
          {sources.map((entry) => (
            <option key={entry.path} value={entry.path}>
              {entry.path}
            </option>
          ))}
        </select>
      </label>
      <div className="context-chips">
        <DialectBadge dialect={source.dialect} />
        <Badge tone={source.writable ? 'ok' : 'muted'} dot={source.writable}>
          {source.writable ? '可写' : '只读'}
        </Badge>
        <span className="context-hash mono" title={source.hash}>
          {shortHash(source.hash, 10)}
        </span>
        <span className="context-count mono">
          {source.providers.length} 提供方 · {modelCount} 模型
        </span>
        <Badge tone="muted">{sourceScope(source.path, projectPath)}</Badge>
        {source.warnings.length > 0 ? (
          <span className="warn-count" title={source.warnings.join('\n')}>
            <Icon name="warning" size={12} />
            {source.warnings.length}
          </span>
        ) : null}
      </div>
      <div className="context-default" title={defaultModel ?? '顶层未声明默认模型'}>
        <span className="eyebrow">DEFAULT</span>
        <span className={defaultExists ? 'mono context-default-value' : 'mono context-default-value is-missing'}>
          {defaultModel ?? '未声明'}
        </span>
      </div>
    </div>
  );
}

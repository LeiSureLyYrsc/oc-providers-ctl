import type { CatalogResult } from '../ipc';
import type { Density, Mode, Theme } from '../lib/store';
import { formatTimestamp } from '../lib/format';
import { Badge } from './Badge';
import { Icon } from './Icon';

interface TopBarProps {
  mode: Mode;
  theme: Theme;
  density: Density;
  catalog: CatalogResult | null;
  catalogLoading: boolean;
  onTheme: () => void;
  onDensity: () => void;
  onRefreshCatalog: () => void;
  onShortcuts: () => void;
}

export function TopBar({
  mode,
  theme,
  density,
  catalog,
  catalogLoading,
  onTheme,
  onDensity,
  onRefreshCatalog,
  onShortcuts,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <b />
        </span>
        <div className="brand-text">
          <span className="brand-name">配置血统台</span>
          <span className="brand-sub mono">OPENCODE · PROVIDERS</span>
        </div>
      </div>

      <div className="mode-chip">
        {mode === 'demo' ? (
          <>
            <Badge tone="suggestion" dot>
              演示数据
            </Badge>
            <span className="muted tiny">浏览器预览 · 不写盘</span>
          </>
        ) : (
          <>
            <Badge tone="ok" dot>
              桌面模式
            </Badge>
            <span className="muted tiny">本地文件 · 显式写入</span>
          </>
        )}
      </div>

      <div className="topbar-spacer" />

      <div className="catalog-chip" title={catalog ? `目录缓存 ${catalog.fetchedAt}` : '模型目录尚未载入'}>
        <span className="eyebrow">CATALOG / 目录</span>
        {catalog ? (
          <>
            <span className="mono catalog-count">{catalog.modelCount}</span>
            <span className="muted tiny">{formatTimestamp(catalog.fetchedAt)}</span>
            {catalog.stale ? <Badge tone="warn">可能过期</Badge> : <Badge tone="ok">缓存</Badge>}
          </>
        ) : (
          <span className="muted tiny">{catalogLoading ? '载入中…' : '未载入'}</span>
        )}
        <button
          type="button"
          className="icon-btn icon-btn-small"
          onClick={onRefreshCatalog}
          disabled={catalogLoading}
          aria-label="刷新模型目录"
          title="刷新本地模型目录（会发起一次目录请求）"
        >
          <Icon name="refresh" size={13} className={catalogLoading ? 'is-spinning' : undefined} />
        </button>
      </div>

      <div className="topbar-tools">
        <button
          type="button"
          className="tool-btn"
          onClick={onDensity}
          aria-pressed={density === 'compact'}
          aria-label={`切换表格行密度，当前${density === 'compact' ? '紧凑' : '舒适'}`}
          title="切换紧凑 / 舒适行高"
        >
          <Icon name="rows" size={15} />
          <span>{density === 'compact' ? '紧凑' : '舒适'}</span>
        </button>
        <button
          type="button"
          className="tool-btn tool-btn-icon"
          onClick={onTheme}
          aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          title={theme === 'dark' ? '浅色主题' : '深色主题'}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
        </button>
        <button
          type="button"
          className="tool-btn tool-btn-icon"
          onClick={onShortcuts}
          aria-label="查看键盘操作"
          title="键盘操作"
        >
          <Icon name="keyboard" size={16} />
        </button>
      </div>
    </header>
  );
}

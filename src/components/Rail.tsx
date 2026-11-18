import type { WorkbenchState, View } from '../lib/store';
import { workspaceStats } from '../lib/checks';
import { Icon } from './Icon';

const NAV: Array<{ view: View; label: string; eyebrow: string; key: string }> = [
  { view: 'overview', label: '总览', eyebrow: 'OVERVIEW', key: '1' },
  { view: 'providers', label: '提供方', eyebrow: 'PROVIDERS', key: '2' },
  { view: 'models', label: '模型', eyebrow: 'MODELS', key: '3' },
  { view: 'sources', label: '配置源', eyebrow: 'SOURCES', key: '4' },
  { view: 'checks', label: '检查', eyebrow: 'CHECKS', key: '5' },
];

interface RailProps {
  state: WorkbenchState;
  onView: (view: View) => void;
}

export function Rail({ state, onView }: RailProps) {
  const stats = workspaceStats(state);
  const counts: Record<View, number | null> = {
    overview: null,
    providers: stats.providers,
    models: stats.models,
    sources: stats.sources,
    checks: stats.actionable,
  };
  const project = state.snapshot?.projectPath;

  return (
    <nav className="rail" aria-label="工作台视图">
      <div className="rail-section">
        <span className="rail-label mono">VIEWS / 工作台</span>
        <ul className="rail-list">
          {NAV.map((item) => (
            <li key={item.view}>
              <button
                type="button"
                className={state.view === item.view ? 'rail-item is-active' : 'rail-item'}
                aria-current={state.view === item.view ? 'page' : undefined}
                onClick={() => onView(item.view)}
              >
                <span className="rail-key mono">{item.key}</span>
                <span className="rail-item-text">
                  <span className="rail-name">{item.label}</span>
                  <span className="rail-eyebrow mono">{item.eyebrow}</span>
                </span>
                {counts[item.view] !== null ? (
                  <span className="rail-count mono">{String(counts[item.view]).padStart(2, '0')}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="rail-bottom">
        <div className="rail-scope">
          <span className="rail-label mono">SCOPE / 范围</span>
          <span className="rail-scope-value">
            <Icon name={project ? 'folder' : 'scan'} size={13} />
            {project ? '项目 + 全局' : '全局'}
          </span>
          <span className="rail-scope-path mono" title={project ?? '未指定项目目录'}>
            {project ?? '未指定项目目录'}
          </span>
        </div>
        <div className="rail-legend" aria-label="数据来源图例">
          <span className="rail-label mono">LEGEND / 来源</span>
          <span className="legend-item" data-tone="read"><i />读取</span>
          <span className="legend-item" data-tone="suggestion"><i />建议</span>
          <span className="legend-item" data-tone="draft"><i />草稿</span>
        </div>
        <div className="rail-status mono">
          <span>{stats.writes} 可写</span>
          <span className="rail-dot" aria-hidden="true" />
          <span>{Object.values(state.batches).reduce((total, batch) => total + batch.edits.length, 0)} 草稿</span>
        </div>
      </div>
    </nav>
  );
}

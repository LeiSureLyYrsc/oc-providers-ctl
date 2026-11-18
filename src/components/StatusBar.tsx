import type { WorkbenchState } from '../lib/store';
import { workspaceStats } from '../lib/checks';
import { shortHash } from '../lib/format';
import { Badge } from './Badge';

interface StatusBarProps {
  state: WorkbenchState;
}

export function StatusBar({ state }: StatusBarProps) {
  const stats = workspaceStats(state);
  const draftCount = Object.values(state.batches).reduce(
    (total, batch) => total + batch.edits.length,
    0,
  );
  const source = state.snapshot?.sources.find((entry) => entry.path === state.activeSourcePath);

  return (
    <footer className="statusbar">
      <div className="status-counts mono">
        <span>{stats.sources} SOURCE</span>
        <span>{stats.providers} PROVIDER</span>
        <span>{stats.models} MODEL</span>
        <span>{stats.writes} WRITABLE</span>
      </div>
      {source ? (
        <div className="status-source mono" title={source.path}>
          <span>{shortHash(source.hash, 8)}</span>
          <span className="status-sep">/</span>
          <span className="status-path">{source.path}</span>
        </div>
      ) : (
        <div className="status-source muted">未载入配置源</div>
      )}
      <div className="status-right">
        {state.scanning ? <span className="status-busy">扫描中…</span> : null}
        {draftCount > 0 ? <Badge tone="draft">{draftCount} 草稿</Badge> : <span className="muted tiny">无草稿</span>}
        {state.mode === 'demo' ? (
          <span className="status-mode">演示 · 不写盘</span>
        ) : (
          <span className="status-mode">桌面 · 哈希校验写入</span>
        )}
        <span className="status-keys mono">Alt 1–5 · / · j k</span>
      </div>
    </footer>
  );
}

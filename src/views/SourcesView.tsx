import type { SourceDocument } from '../ipc';
import { dialectLabel, sourceScope, shortHash } from '../lib/format';
import type { DialectFilter, WorkbenchState } from '../lib/store';
import { batchFor } from '../lib/store';
import { DataTable, PaneHeader } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { Badge, DialectBadge } from '../components/Badge';
import { DraftCount } from '../components/TableCells';
import { DialectFilterChips } from '../components/Filters';
import { Icon } from '../components/Icon';

interface SourceRow {
  source: SourceDocument;
  draftCount: number;
}

interface SourcesViewProps {
  state: WorkbenchState;
  projectPath: string | null;
  onQuery: (value: string) => void;
  onDialectFilter: (value: DialectFilter) => void;
  onSelect: (path: string) => void;
}

export function SourcesView({
  state,
  projectPath,
  onQuery,
  onDialectFilter,
  onSelect,
}: SourcesViewProps) {
  const query = state.query.trim().toLowerCase();
  const rows: SourceRow[] = (state.snapshot?.sources ?? [])
    .filter((source) => {
      if (state.dialectFilter !== 'all' && source.dialect !== state.dialectFilter) return false;
      if (!query) return true;
      return (
        source.path.toLowerCase().includes(query) ||
        (source.defaultModel ?? '').toLowerCase().includes(query) ||
        dialectLabel(source.dialect).toLowerCase().includes(query)
      );
    })
    .map((source) => ({
      source,
      draftCount: batchFor(state, source.path)?.edits.length ?? 0,
    }));

  const scopedProject = state.snapshot?.projectPath ?? projectPath;

  const columns: Column<SourceRow>[] = [
    {
      key: 'path',
      label: '配置源',
      hint: 'PATH',
      mono: true,
      render: (row) => (
        <span className="source-path-cell">
          <span className="mono">{row.source.path}</span>
          {row.source.writable ? null : <Icon name="lock" size={11} />}
        </span>
      ),
    },
    {
      key: 'scope',
      label: '范围',
      hint: 'SCOPE',
      width: '82px',
      render: (row) => (
        <Badge tone={sourceScope(row.source.path, scopedProject) === '项目内' ? 'accent' : 'muted'}>
          {sourceScope(row.source.path, scopedProject)}
        </Badge>
      ),
    },
    {
      key: 'dialect',
      label: '方言',
      hint: 'DIALECT',
      width: '94px',
      render: (row) => <DialectBadge dialect={row.source.dialect} />,
    },
    {
      key: 'writable',
      label: '写入',
      hint: 'WRITABLE',
      width: '72px',
      render: (row) => (
        <Badge tone={row.source.writable ? 'ok' : 'muted'} dot={row.source.writable}>
          {row.source.writable ? '可写' : '只读'}
        </Badge>
      ),
    },
    {
      key: 'providers',
      label: '提供方',
      hint: 'PROVIDERS',
      width: '78px',
      align: 'right',
      mono: true,
      render: (row) => (
        <span className="numeric-cell">{row.source.providers.length}</span>
      ),
    },
    {
      key: 'models',
      label: '模型',
      hint: 'MODELS',
      width: '64px',
      align: 'right',
      mono: true,
      render: (row) => (
        <span className="numeric-cell">
          {row.source.providers.reduce((total, provider) => total + provider.models.length, 0)}
        </span>
      ),
    },
    {
      key: 'default',
      label: '默认模型',
      hint: 'DEFAULT',
      mono: true,
      className: 'col-optional',
      render: (row) =>
        row.source.defaultModel ? (
          <span className="mono">{row.source.defaultModel}</span>
        ) : (
          <span className="muted tiny">未声明</span>
        ),
    },
    {
      key: 'hash',
      label: '哈希',
      hint: 'HASH',
      width: '92px',
      mono: true,
      className: 'col-optional',
      render: (row) => <span className="muted mono">{shortHash(row.source.hash, 8)}</span>,
    },
    {
      key: 'warnings',
      label: '告警',
      hint: 'WARN',
      width: '68px',
      align: 'right',
      render: (row) =>
        row.source.warnings.length > 0 ? (
          <span className="warn-count">{row.source.warnings.length}</span>
        ) : (
          <span className="muted tiny">0</span>
        ),
    },
    {
      key: 'drafts',
      label: '草稿',
      hint: 'DRAFT',
      width: '58px',
      align: 'right',
      render: (row) => <DraftCount count={row.draftCount} />,
    },
  ];

  return (
    <div className="pane">
      <PaneHeader
        title="配置源"
        eyebrow="SOURCES / 配置源"
        count={rows.length}
        query={state.query}
        onQuery={onQuery}
        searchPlaceholder="筛选路径、默认模型或方言"
      >
        <DialectFilterChips value={state.dialectFilter} onChange={onDialectFilter} />
      </PaneHeader>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.source.path}
        selectedKey={state.activeSourcePath}
        onSelect={(row) => onSelect(row.source.path)}
        density={state.density}
        label="配置源列表"
        empty={
          <div className="empty-state">
            <Icon name="file" size={22} />
            <h3>没有配置源</h3>
            <p>扫描全局、扫描项目，或用显式路径载入 JSON / JSONC。</p>
          </div>
        }
      />
    </div>
  );
}

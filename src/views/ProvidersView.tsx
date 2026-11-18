import type { ProviderEntry, SourceDocument } from '../ipc';
import type { DialectFilter, WorkbenchState } from '../lib/store';
import { batchFor, draftIndex } from '../lib/store';
import {
  isConcreteDialect,
  pathStartsWith,
  providerLeafPath,
  providerRoot,
} from '../lib/paths';
import { DataTable, PaneHeader } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { DialectBadge, CredentialBadge } from '../components/Badge';
import { CellValue, DraftCount } from '../components/TableCells';
import { DialectFilterChips } from '../components/Filters';
import { Icon } from '../components/Icon';

interface ProviderRow {
  key: string;
  provider: ProviderEntry;
  draftCount: number;
}

interface ProvidersViewProps {
  state: WorkbenchState;
  source: SourceDocument | null;
  onQuery: (value: string) => void;
  onDialectFilter: (value: DialectFilter) => void;
  onSelect: (providerId: string) => void;
  onNewProvider: () => void;
}

export function ProvidersView({
  state,
  source,
  onQuery,
  onDialectFilter,
  onSelect,
  onNewProvider,
}: ProvidersViewProps) {
  const batch = batchFor(state, source?.path ?? null);
  const index = draftIndex(batch);
  const query = state.query.trim().toLowerCase();

  const rows: ProviderRow[] = (source?.providers ?? [])
    .filter((provider) => {
      if (state.dialectFilter !== 'all' && provider.dialect !== state.dialectFilter) return false;
      if (!query) return true;
      return (
        provider.id.toLowerCase().includes(query) ||
        (provider.name ?? '').toLowerCase().includes(query) ||
        (provider.baseUrl ?? '').toLowerCase().includes(query)
      );
    })
    .map((provider) => {
      const concrete = isConcreteDialect(provider.dialect) ? provider.dialect : null;
      const root = concrete ? providerRoot(concrete, provider.id) : null;
      const draftCount = root
        ? batch?.edits.filter((draft) => pathStartsWith(draft.path, root)).length ?? 0
        : 0;
      return { key: provider.id, provider, draftCount };
    });

  const columns: Column<ProviderRow>[] = [
    {
      key: 'dialect',
      label: '方言',
      hint: 'DIALECT',
      width: '94px',
      render: (row) => <DialectBadge dialect={row.provider.dialect} />,
    },
    {
      key: 'id',
      label: '标识',
      hint: 'PROVIDER',
      mono: true,
      render: (row) => (
        <span className="id-cell">
          <span className="mono">{row.provider.id}</span>
          {!source?.writable || !isConcreteDialect(row.provider.dialect) ? (
            <Icon name="lock" size={11} />
          ) : null}
          {row.draftCount > 0 ? <i className="draft-dot" title="存在未应用草稿" /> : null}
        </span>
      ),
    },
    {
      key: 'name',
      label: '名称',
      hint: 'NAME',
      render: (row) => {
        const concrete = isConcreteDialect(row.provider.dialect) ? row.provider.dialect : null;
        const path = concrete ? providerLeafPath(concrete, row.provider.id, 'name') : null;
        const draft = path ? index.get(JSON.stringify(path)) : undefined;
        return <CellValue current={row.provider.name} draft={draft} />;
      },
    },
    {
      key: 'base',
      label: '基础地址',
      hint: 'BASE URL',
      mono: true,
      render: (row) => {
        const concrete = isConcreteDialect(row.provider.dialect) ? row.provider.dialect : null;
        const path = concrete ? providerLeafPath(concrete, row.provider.id, 'baseUrl') : null;
        const draft = path ? index.get(JSON.stringify(path)) : undefined;
        return <CellValue current={row.provider.baseUrl} draft={draft} mono />;
      },
    },
    {
      key: 'models',
      label: '模型',
      hint: 'MODELS',
      width: '66px',
      align: 'right',
      mono: true,
      render: (row) => <span className="numeric-cell">{row.provider.models.length}</span>,
    },
    {
      key: 'credential',
      label: '凭据',
      hint: 'CREDENTIAL',
      width: '118px',
      render: (row) => (
        <CredentialBadge status={row.provider.credentialStatus} />
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

  const newDisabled = !source?.writable || source.dialect === 'invalid';

  return (
    <div className="pane">
      <PaneHeader
        title="提供方"
        eyebrow="PROVIDERS / 提供方"
        count={rows.length}
        query={state.query}
        onQuery={onQuery}
        searchPlaceholder="筛选标识、名称或基础地址"
        primaryAction={
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={onNewProvider}
            disabled={newDisabled}
            title={
              newDisabled
                ? '当前配置源不可写或结构无效，不能新建提供方'
                : '新建一个提供方条目草稿'
            }
          >
            <Icon name="plus" size={13} />
            新建提供方
          </button>
        }
      >
        <DialectFilterChips value={state.dialectFilter} onChange={onDialectFilter} />
      </PaneHeader>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.key}
        selectedKey={state.selectedProviderId}
        onSelect={(row) => onSelect(row.provider.id)}
        density={state.density}
        label="提供方列表"
        empty={
          !source ? (
            <div className="empty-state">
              <Icon name="file" size={22} />
              <h3>尚未选择配置源</h3>
              <p>先在顶部选择配置源，或扫描全局 / 项目。</p>
            </div>
          ) : source.providers.length === 0 ? (
            <div className="empty-state">
              <Icon name="rows" size={22} />
              <h3>这个配置源里没有提供方</h3>
              <p>可以新建提供方，或换一个配置源。</p>
            </div>
          ) : (
            <div className="empty-state">
              <Icon name="search" size={22} />
              <h3>没有匹配的提供方</h3>
              <p>清除筛选或切换方言后重试。</p>
            </div>
          )
        }
      />
    </div>
  );
}

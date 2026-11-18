import type { ModelEntry, ProviderEntry, SourceDocument } from '../ipc';
import { isModelDefault, variantSummary } from '../lib/format';
import { describeReasoning } from '../lib/reasoning';
import type { DialectFilter, WorkbenchState } from '../lib/store';
import { batchFor, draftIndex } from '../lib/store';
import {
  isConcreteDialect,
  locateModel,
  modelLeafPath,
  modelRoot,
  pathStartsWith,
} from '../lib/paths';
import { DataTable, PaneHeader } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { Badge, DialectBadge } from '../components/Badge';
import { CellValue, DraftCount } from '../components/TableCells';
import { DialectFilterChips } from '../components/Filters';
import { Icon } from '../components/Icon';

interface ModelRow {
  key: string;
  provider: ProviderEntry;
  model: ModelEntry;
  draftCount: number;
}

interface ModelsViewProps {
  state: WorkbenchState;
  source: SourceDocument | null;
  providerFilter: string;
  onProviderFilter: (value: string) => void;
  onQuery: (value: string) => void;
  onDialectFilter: (value: DialectFilter) => void;
  onSelect: (providerId: string, modelId: string) => void;
  onNewModel: (provider: ProviderEntry | null) => void;
}

export function ModelsView({
  state,
  source,
  providerFilter,
  onProviderFilter,
  onQuery,
  onDialectFilter,
  onSelect,
  onNewModel,
}: ModelsViewProps) {
  const batch = batchFor(state, source?.path ?? null);
  const index = draftIndex(batch);
  const query = state.query.trim().toLowerCase();
  const providers = source?.providers ?? [];

  const rows: ModelRow[] = providers
    .filter((provider) => providerFilter === 'all' || provider.id === providerFilter)
    .flatMap((provider) =>
      provider.models
        .filter((model) => {
          if (state.dialectFilter !== 'all' && provider.dialect !== state.dialectFilter) return false;
          if (!query) return true;
          return (
            model.id.toLowerCase().includes(query) ||
            (model.name ?? '').toLowerCase().includes(query) ||
            (model.requestId ?? '').toLowerCase().includes(query) ||
            provider.id.toLowerCase().includes(query)
          );
        })
        .map((model) => {
          const concrete = isConcreteDialect(provider.dialect) ? provider.dialect : null;
          const root = concrete ? modelRoot(concrete, locateModel(provider, model)) : null;
          const draftCount = root
            ? batch?.edits.filter((draft) => pathStartsWith(draft.path, root)).length ?? 0
            : 0;
          return {
            key: `${provider.id}::${model.id}`,
            provider,
            model,
            draftCount,
          };
        }),
    );

  const fieldsFor = (row: ModelRow) => {
    const concrete = isConcreteDialect(row.provider.dialect) ? row.provider.dialect : null;
    if (!concrete) return null;
    const locator = locateModel(row.provider, row.model);
    const path = (leaf: 'name' | 'context' | 'input' | 'output' | 'reasoning' | 'variants') =>
      modelLeafPath(concrete, locator, leaf);
    return { concrete, locator, path };
  };

  const selectedProvider =
    providers.find((provider) => provider.id === state.selectedProviderId) ?? null;
  const filterProvider =
    providerFilter !== 'all' ? providers.find((provider) => provider.id === providerFilter) ?? null : null;
  const createTarget = selectedProvider ?? filterProvider;
  const createAllowed = Boolean(
    createTarget &&
      isConcreteDialect(createTarget.dialect) &&
      source?.writable,
  );

  const columns: Column<ModelRow>[] = [
    {
      key: 'id',
      label: '模型',
      hint: 'MODEL ID',
      mono: true,
      cssClass: 'model-id',
      render: (row) => (
        <span className="id-cell">
          <span className="mono model-id">{row.model.id}</span>
          {source && isModelDefault(source, row.provider.id, row.model.id) ? (
            <Badge tone="accent">默认</Badge>
          ) : null}
          {row.draftCount > 0 ? <i className="draft-dot" title="存在未应用草稿" /> : null}
        </span>
      ),
    },
    {
      key: 'name',
      label: '名称',
      hint: 'NAME',
      cssClass: 'model-name',
      render: (row) => {
        const paths = fieldsFor(row);
        const draft = paths ? index.get(JSON.stringify(paths.path('name'))) : undefined;
        return <CellValue current={row.model.name} draft={draft} />;
      },
    },
    {
      key: 'request',
      label: '请求 ID',
      hint: 'REQUEST ID',
      className: 'col-optional',
      mono: true,
      render: (row) =>
        row.model.requestId ? (
          <span className="muted mono">{row.model.requestId}</span>
        ) : (
          <span className="muted tiny">未设置 · 只读</span>
        ),
    },
    {
      key: 'provider',
      label: '提供方',
      hint: 'PROVIDER / DIALECT',
      cssClass: 'model-provider',
      render: (row) => (
        <span className="provider-cell">
          <span className="mono">{row.provider.id}</span>
          <DialectBadge dialect={row.provider.dialect} />
        </span>
      ),
    },
    {
      key: 'context',
      label: '上下文',
      hint: 'CONTEXT',
      align: 'right',
      mono: true,
      render: (row) => {
        const paths = fieldsFor(row);
        const draft = paths ? index.get(JSON.stringify(paths.path('context'))) : undefined;
        return <CellValue current={row.model.context} draft={draft} />;
      },
    },
    {
      key: 'input',
      label: '输入',
      hint: 'INPUT',
      align: 'right',
      mono: true,
      render: (row) => {
        const paths = fieldsFor(row);
        const draft = paths ? index.get(JSON.stringify(paths.path('input'))) : undefined;
        return <CellValue current={row.model.input} draft={draft} />;
      },
    },
    {
      key: 'output',
      label: '输出',
      hint: 'OUTPUT',
      align: 'right',
      mono: true,
      render: (row) => {
        const paths = fieldsFor(row);
        const draft = paths ? index.get(JSON.stringify(paths.path('output'))) : undefined;
        return <CellValue current={row.model.output} draft={draft} />;
      },
    },
    {
      key: 'reasoning',
      label: '推理',
      hint: 'REASONING',
      className: 'col-optional',
      render: (row) => {
        const paths = fieldsFor(row);
        const draft = paths ? index.get(JSON.stringify(paths.path('reasoning'))) : undefined;
        return (
          <CellValue
            current={describeReasoning(row.model.reasoning)}
            draft={draft}
            format={(value) => describeReasoning(value)}
          />
        );
      },
    },
    {
      key: 'variants',
      label: '变体',
      hint: 'VARIANTS',
      className: 'col-optional',
      render: (row) => {
        const paths = fieldsFor(row);
        const dialect = paths?.concrete ?? 'v1';
        const draft = paths ? index.get(JSON.stringify(paths.path('variants'))) : undefined;
        return (
          <CellValue
            current={variantSummary(row.model.variants, dialect)}
            draft={draft}
            format={(value) => variantSummary(value, dialect)}
          />
        );
      },
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
        title="模型"
        eyebrow="MODELS / 模型"
        count={rows.length}
        query={state.query}
        onQuery={onQuery}
        searchPlaceholder="筛选模型、名称、请求 ID 或提供方"
        primaryAction={
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() => onNewModel(createTarget)}
            disabled={!createAllowed}
            title={
              createAllowed
                ? `在 ${createTarget?.id} 下新建模型草稿`
                : '先选择一个可写、方言明确的目标提供方'
            }
          >
            <Icon name="plus" size={13} />
            新建模型
          </button>
        }
      >
        <select
          className="provider-select mono"
          value={providerFilter}
          onChange={(event) => onProviderFilter(event.target.value)}
          aria-label="按提供方筛选"
        >
          <option value="all">全部提供方</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.id}
            </option>
          ))}
        </select>
        <DialectFilterChips value={state.dialectFilter} onChange={onDialectFilter} />
      </PaneHeader>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.key}
        selectedKey={
          state.selectedProviderId && state.selectedModelId
            ? `${state.selectedProviderId}::${state.selectedModelId}`
            : null
        }
        onSelect={(row) => onSelect(row.provider.id, row.model.id)}
        density={state.density}
        label="模型列表"
        empty={
          !source ? (
            <div className="empty-state">
              <Icon name="file" size={22} />
              <h3>尚未选择配置源</h3>
              <p>先扫描或载入一个配置源。</p>
            </div>
          ) : providers.length === 0 ? (
            <div className="empty-state">
              <Icon name="rows" size={22} />
              <h3>没有提供方</h3>
              <p>先创建一个提供方，再添加模型。</p>
            </div>
          ) : (
            <div className="empty-state">
              <Icon name="search" size={22} />
              <h3>没有匹配的模型</h3>
              <p>清除筛选，或切换提供方 / 方言。</p>
            </div>
          )
        }
      />
    </div>
  );
}

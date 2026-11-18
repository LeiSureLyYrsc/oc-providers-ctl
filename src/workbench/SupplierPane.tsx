import type { SourceDocument } from '../ipc';
import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon';

interface SupplierPaneProps {
  source: SourceDocument | null;
  providers: SourceDocument['providers'];
  selectedId: string | null;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  addDisabled: boolean;
  editedPaths: Set<string>;
}

function hasProviderDraft(editedPaths: Set<string>, providerId: string): boolean {
  for (const key of editedPaths) {
    const parsed = JSON.parse(key) as string[];
    if (parsed[1] === providerId && parsed[0] !== 'model') return true;
  }
  return false;
}

export function SupplierPane({
  source,
  providers,
  selectedId,
  query,
  onQuery,
  onSelect,
  onAdd,
  addDisabled,
  editedPaths,
}: SupplierPaneProps) {
  const needle = query.trim().toLowerCase();
  const filtered = providers.filter((provider) => {
    if (!needle) return true;
    return (
      provider.id.toLowerCase().includes(needle) ||
      (provider.name ?? '').toLowerCase().includes(needle)
    );
  });
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  return (
    <section className="pane pane-left" aria-label="供应商">
      <div className="pane-head">
        <h2>供应商</h2>
        <span className="count">{providers.length}</span>
        <div className="head-actions">
          <button
            type="button"
            className="btn btn-filled btn-small"
            onClick={onAdd}
            disabled={addDisabled}
            title={addDisabled ? (source ? '这个文件是只读的' : '先选择配置文件') : '添加供应商'}
          >
            <Icon name="add" size={18} />
            添加
          </button>
        </div>
      </div>

      <label className="search">
        <Icon name="search" size={18} />
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索供应商或模型"
          aria-label="搜索供应商或模型"
        />
      </label>

      <div className="pane-scroll">
        {!source ? (
          <p className="list-empty">先选择一个配置文件。</p>
        ) : providers.length === 0 ? (
          <p className="list-empty">还没有供应商，点「添加」开始。</p>
        ) : filtered.length === 0 ? (
          <p className="list-empty">没有匹配的供应商。</p>
        ) : (
          <ul className="supplier-list">
            {filtered.map((provider) => {
              const selected = provider.id === selectedId;
              const edited = hasProviderDraft(editedPaths, provider.id);
              return (
                <li key={provider.id}>
                  <button
                    type="button"
                    className="supplier-row"
                    aria-current={selected}
                    ref={selected ? selectedRef : null}
                    onClick={() => onSelect(provider.id)}
                  >
                    <span className="avatar" aria-hidden="true">
                      {provider.id.slice(0, 1)}
                    </span>
                    <span className="row-main">
                      <span className="row-title">{provider.name || provider.id}</span>
                      <span className="row-sub">
                        {provider.id} · {provider.models.length} 个模型
                        {provider.dialect === 'invalid' ? ' · 只读' : ''}
                      </span>
                    </span>
                    {edited ? (
                      <span className="row-badge" title="这个供应商有未保存的修改">
                        <Icon name="edit" size={18} />
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

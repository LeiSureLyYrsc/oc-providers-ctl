import { useEffect, useRef, useState } from 'react';
import type { CatalogResult, ModelCandidate, ModelEntry, ProviderEntry } from '../ipc';
import { formatTimestamp } from '../lib/format';
import { describeReasoning } from '../lib/reasoning';
import { toSafeMessage } from '../ipc';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

interface SuggestionDialogProps {
  open: boolean;
  provider: ProviderEntry;
  model: ModelEntry | null;
  catalog: CatalogResult | null;
  catalogLoading: boolean;
  onRefreshCatalog: () => Promise<CatalogResult | null>;
  onClose: () => void;
  onSearch: (query: string) => Promise<ModelCandidate[]>;
  onAdopt: (candidate: ModelCandidate, includeReasoning: boolean) => void;
}

export function SuggestionDialog({
  open,
  provider,
  model,
  catalog,
  catalogLoading,
  onRefreshCatalog,
  onClose,
  onSearch,
  onAdopt,
}: SuggestionDialogProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ModelCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeReasoning, setIncludeReasoning] = useState(true);
  const seq = useRef(0);

  async function search(text: string): Promise<void> {
    const current = seq.current + 1;
    seq.current = current;
    setSearching(true);
    setError(null);
    try {
      const results = await onSearch(text);
      if (seq.current === current) setItems(results);
    } catch (failure) {
      if (seq.current === current) {
        setItems([]);
        setError(toSafeMessage(failure));
      }
    } finally {
      if (seq.current === current) setSearching(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const initial = model?.id ?? '';
    setQuery(initial);
    setItems([]);
    setError(null);
    // Search against whatever cache already exists; loading the catalog is a separate action.
    void search(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider.id, model?.id]);

  if (!open) return null;

  async function refresh(): Promise<void> {
    setError(null);
    const result = await onRefreshCatalog();
    if (result) await search(query);
    else setError('模型目录刷新失败。');
  }

  return (
    <Dialog
      open
      title="从模型目录查找"
      subtitle={model ? model.id : provider.id}
      onClose={onClose}
      wide
      actions={
        <>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginRight: 'auto' }}
          >
            <input
              type="checkbox"
              checked={includeReasoning}
              onChange={(event) => setIncludeReasoning(event.target.checked)}
            />
            同时补充推理信息
          </label>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <form
        className="input-row"
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
      >
        <input
          className="input mono"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入模型 ID"
          aria-label="搜索模型"
          data-autofocus
        />
        <button type="submit" className="btn btn-tonal" disabled={searching}>
          查找
        </button>
      </form>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 10,
          flexWrap: 'wrap',
          fontSize: 14,
          color: 'var(--on-surface-3)',
        }}
      >
        {catalog ? (
          <span>
            目录：{catalog.modelCount} 个模型 · {formatTimestamp(catalog.fetchedAt)}
            {catalog.stale ? ' · 可能过期' : ''}
          </span>
        ) : (
          <span>还没有载入模型目录。</span>
        )}
        <button
          type="button"
          className="text-btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => void refresh()}
          disabled={catalogLoading}
        >
          {catalogLoading ? '正在刷新…' : '更新目录'}
        </button>
      </div>

      {error ? <div className="dialog-error">{error}</div> : null}

      <div style={{ marginTop: 10 }}>
        {searching ? (
          <div className="loading">
            <span className="spinner" aria-hidden="true" />
            正在查找…
          </div>
        ) : items.length === 0 ? (
          <p className="list-empty">
            {catalog ? '没有找到匹配的模型，可以直接手动填写。' : '先更新目录，再查找模型。'}
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((candidate, index) => (
              <li
                key={`${candidate.providerId}:${candidate.id}:${index}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 0',
                  borderBottom: '1px solid var(--outline-variant)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 15 }}>
                    {candidate.id}
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--on-surface-3)' }}>
                    {candidate.name} · {describeReasoning(candidate.reasoning)}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--on-surface-3)' }}>
                    {candidate.matchReason}
                    {candidate.providerId !== provider.id ? ' · 来自其他供应商的目录，请核对' : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-tonal btn-small"
                  onClick={() => onAdopt(candidate, includeReasoning)}
                >
                  使用
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="inline-note">
        <Icon name="warning" size={18} />
        只会补充名称、长度和推理信息，不会改动模型 ID。
      </p>
    </Dialog>
  );
}

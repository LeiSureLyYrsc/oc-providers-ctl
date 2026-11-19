import { useEffect, useRef, useState } from 'react';
import type { CatalogResult, ModelCandidate } from '../ipc';
import { toSafeMessage } from '../ipc';
import { formatTimestamp } from '../lib/format';
import {
  defaultAdoptionSelection,
  describeCandidateFields,
  type AdoptionBaseline,
  type AdoptionSelection,
  type CandidateFieldRow,
} from '../lib/adoption';
import type { ConcreteDialect } from '../lib/paths';
import { Icon } from './Icon';

export interface CandidatePickerProps {
  providerId: string;
  dialect: ConcreteDialect;
  /** Model being completed. `null` while adding a new model. */
  baseline: AdoptionBaseline | null;
  /** Pre-fills the search box; the request id is preferred when present. */
  initialQuery: string;
  catalog: CatalogResult | null;
  catalogLoading: boolean;
  onRefreshCatalog: () => Promise<CatalogResult | null>;
  onSearch: (query: string) => Promise<ModelCandidate[]>;
  /** Field-level fill. Editing panes only write their form state. */
  onAdopt: (candidate: ModelCandidate, selection: AdoptionSelection) => void;
  /** False on read-only files: browsing works, staging does not. */
  allowAdopt?: boolean;
  /** Shown when the picker is used outside a dialog. */
  compact?: boolean;
}

function candidateKey(candidate: ModelCandidate): string {
  return `${candidate.providerId}:${candidate.id}`;
}

export function CandidatePicker({
  providerId,
  dialect,
  baseline,
  initialQuery,
  catalog,
  catalogLoading,
  onRefreshCatalog,
  onSearch,
  onAdopt,
  allowAdopt = true,
  compact,
}: CandidatePickerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<ModelCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selection, setSelection] = useState<AdoptionSelection | null>(null);
  const seq = useRef(0);

  async function search(text: string): Promise<void> {
    const current = seq.current + 1;
    seq.current = current;
    setSearching(true);
    setError(null);
    try {
      const results = await onSearch(text);
      if (seq.current !== current) return;
      setItems(results);
      const first = results[0];
      setExpanded(first ? candidateKey(first) : null);
      setSelection(
        first && baseline ? defaultAdoptionSelection(describeCandidateFields(dialect, baseline, first)) : null,
      );
    } catch (failure) {
      if (seq.current !== current) return;
      setItems([]);
      setExpanded(null);
      setSelection(null);
      setError(toSafeMessage(failure));
    } finally {
      if (seq.current === current) setSearching(false);
    }
  }

  useEffect(() => {
    setQuery(initialQuery);
    setItems([]);
    setSelection(null);
    setExpanded(null);
    setError(null);
    void search(initialQuery);
    // Re-query only when the target model or provider changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, initialQuery]);

  useEffect(() => {
    // Drop any in-flight result as soon as the target changes or the pane closes.
    return () => {
      seq.current += 1;
    };
  }, [providerId, initialQuery]);

  async function refresh(): Promise<void> {
    setError(null);
    const result = await onRefreshCatalog();
    if (result) await search(query);
    else setError('模型目录刷新失败。');
  }

  function expand(candidate: ModelCandidate): void {
    const key = candidateKey(candidate);
    setExpanded(key);
    setSelection(
      baseline ? defaultAdoptionSelection(describeCandidateFields(dialect, baseline, candidate)) : null,
    );
  }

  function toggle(row: CandidateFieldRow): void {
    if (row.status === 'unavailable') return;
    setSelection((current) => {
      if (!current) return current;
      return { ...current, [row.key]: !current[row.key] };
    });
  }

  const active = items.find((candidate) => candidateKey(candidate) === expanded) ?? null;
  const rows = active && baseline ? describeCandidateFields(dialect, baseline, active) : [];
  const selectedCount = selection
    ? Object.values(selection).filter(Boolean).length
    : 0;

  return (
    <div className={compact ? 'candidate-picker is-compact' : 'candidate-picker'}>
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
          placeholder="输入模型 ID 或名称"
          aria-label="搜索模型"
          data-autofocus={compact ? undefined : true}
          spellCheck={false}
        />
        <button type="submit" className="btn btn-tonal" disabled={searching}>
          查找
        </button>
      </form>

      <div className="catalog-strip">
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

      <div className="candidate-list">
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
          <ul>
            {items.map((candidate) => {
              const key = candidateKey(candidate);
              const isOpen = key === expanded;
              return (
                <li key={key} className="candidate-item" data-open={isOpen}>
                  <button
                    type="button"
                    className="candidate-head"
                    aria-expanded={isOpen}
                    onClick={() => expand(candidate)}
                  >
                    <span className="candidate-main">
                      <span className="mono candidate-id">{candidate.id}</span>
                      <span className="candidate-sub">
                        {candidate.name || '未提供名称'}
                      </span>
                      <span className="candidate-source">
                        来源 providerId：{candidate.providerId} · 公共模型目录（models.dev 缓存） ·{' '}
                        {candidate.matchReason}
                      </span>
                      <span className="candidate-source">
                        {candidate.providerId !== providerId
                          ? '和你当前的供应商不是同一家，请核对是否同名模型。'
                          : '目录条目，未在运行时验证。'}
                      </span>
                    </span>
                  </button>

                  {isOpen && rows.length > 0 && selection ? (
                    <div className="candidate-fields">
                      {rows.map((row) => (
                        <div className="candidate-field" key={row.key} data-status={row.status}>
                          <span className="candidate-field-label">{row.label}</span>
                          <span className="candidate-field-value">
                            <span className="candidate-current">{row.current}</span>
                            <Icon name="arrow" size={16} />
                            <span className="candidate-proposed">{row.proposed}</span>
                          </span>
                          {row.status === 'unavailable' ? (
                            <span className="candidate-field-action">目录未提供</span>
                          ) : row.status === 'same' ? (
                            <span className="candidate-field-action">相同</span>
                          ) : (
                            <label className="candidate-field-action">
                              <input
                                type="checkbox"
                                checked={selection[row.key]}
                                onChange={() => toggle(row)}
                                aria-label={`${row.currentEmpty ? '填入' : '覆盖'}${row.label}`}
                              />
                              {row.currentEmpty ? '填入' : '覆盖'}
                            </label>
                          )}
                          {row.note ? <span className="candidate-field-note">{row.note}</span> : null}
                        </div>
                      ))}
                      <div className="candidate-fields-foot">
                        <span>
                          {allowAdopt
                            ? '只写入勾选的字段；请求 ID 和变体不会被改动。'
                            : '这个文件是只读的：可以查询，但不能写入。'}
                        </span>
                        <button
                          type="button"
                          className="btn btn-filled btn-small"
                          disabled={!allowAdopt || selectedCount === 0}
                          onClick={() => {
                            if (active) onAdopt(active, selection);
                          }}
                        >
                          填入所选{selectedCount > 0 ? `（${selectedCount}）` : ''}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {isOpen && rows.length === 0 ? (
                    <p className="candidate-fields-empty">
                      添加模型时先填模型 ID，保存后可以按字段补齐资料。
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="inline-note">
        <Icon name="warning" size={18} />
        资料来自公共模型目录，只代表声明的能力，不代表实际请求设置。
      </p>
    </div>
  );
}

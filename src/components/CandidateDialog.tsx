import { useEffect, useRef, useState } from 'react';
import type { CatalogResult, ModelCandidate, ModelEntry, ProviderEntry } from '../ipc';
import type { ConcreteDialect } from '../lib/paths';
import { formatTokens } from '../lib/format';
import { describeReasoning } from '../lib/reasoning';
import { Modal } from './Modal';
import { Badge } from './Badge';
import { Icon } from './Icon';

interface CandidateDialogProps {
  open: boolean;
  provider: ProviderEntry;
  targetModel: ModelEntry | null;
  dialect: ConcreteDialect;
  catalog: CatalogResult | null;
  demo: boolean;
  onClose: () => void;
  onSearch: (query: string) => Promise<ModelCandidate[]>;
  onRefreshCatalog: () => Promise<void>;
  onAdopt: (candidate: ModelCandidate, includeReasoning: boolean) => void;
}

export function CandidateDialog({
  open,
  provider,
  targetModel,
  dialect,
  catalog,
  demo,
  onClose,
  onSearch,
  onRefreshCatalog,
  onAdopt,
}: CandidateDialogProps) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ModelCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeReasoning, setIncludeReasoning] = useState(true);
  const requestSeq = useRef(0);

  const runSearch = async (nextQuery: string) => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoading(true);
    setError(null);
    try {
      const result = await onSearch(nextQuery);
      if (requestSeq.current === seq) setItems(result);
    } catch (failure) {
      if (requestSeq.current === seq) {
        setItems([]);
        setError(failure instanceof Error ? failure.message : '检索失败。');
      }
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setItems([]);
    setError(null);
    if (catalog) {
      void runSearch('');
    }
    // Search runs once per opening; the parent owns the IPC call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalog !== null]);

  const targetExisting = targetModel;

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="CATALOG MATCH / 本地候选"
      title="用目录建议补充模型元数据"
      width="wide"
      footer={
        <>
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeReasoning}
              onChange={(event) => setIncludeReasoning(event.target.checked)}
            />
            <span>
              同时采用推理标记
              <span className="muted small">
                　{dialect === 'v1' ? 'V1 仅写 supported 布尔值' : 'V2 写归一化对象'}
              </span>
            </span>
          </label>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <p className="dialog-intro">
        只采用名称（当前为空时）、上下文、输入与输出上限
        {includeReasoning ? '，以及归一化推理标记' : ''}。不会写入 requestId，也不会创建或覆盖变体。
      </p>
      <p className="adoption-note">
        {dialect === 'v1'
          ? 'V1 只取 supported 布尔值；归一化对象中的 toggle / effort / budget 不会自动转换或展开写入。'
          : 'V2 原样保留归一化对象；effort 与 budget 只是目录元数据，不代表转换后的运行参数。'}
        推理建议不是能力证明，也不会改写请求 ID。
      </p>
      <form
        className="candidate-search"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(query);
        }}
      >
        <label className="search-box search-box-wide">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`在本地目录中检索（范围：${provider.id}）`}
            aria-label="目录检索"
            data-autofocus
          />
        </label>
        <button type="submit" className="btn" disabled={loading}>
          {loading ? '检索中…' : '检索'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            void onRefreshCatalog();
          }}
          disabled={loading}
        >
          <Icon name="refresh" size={14} />
          刷新目录
        </button>
      </form>

      {!catalog ? (
        <div className="dialog-empty">
          本地目录尚未载入。刷新目录后才能按标识检索候选。
        </div>
      ) : error ? (
        <div className="dialog-error">{error}</div>
      ) : loading ? (
        <div className="dialog-empty">正在检索本地目录…</div>
      ) : items.length === 0 ? (
        <div className="dialog-empty">
          {catalog
            ? '没有匹配候选。可以改用完整标识，或直接手动填写元数据。'
            : '先刷新目录。'}
        </div>
      ) : (
        <ul className="candidate-list" aria-label="候选模型">
          {items.map((candidate, index) => {
            const crossProvider = candidate.providerId !== provider.id;
            return (
              <li key={`${candidate.providerId}:${candidate.id}:${index}`} className="candidate-row">
                <div className="candidate-main">
                  <div className="candidate-id-line">
                    <span className="mono candidate-id">{candidate.id}</span>
                    <Badge tone={crossProvider ? 'warn' : 'ok'} dot={!crossProvider}>
                      {crossProvider ? '跨提供方' : '同提供方'}
                    </Badge>
                    {candidate.canonicalId ? (
                      <span className="mono muted tiny">{candidate.canonicalId}</span>
                    ) : null}
                  </div>
                  <div className="candidate-meta">
                    <span>{candidate.name}</span>
                    <span className="sep">·</span>
                    <span className="mono">ctx {formatTokens(candidate.context)}</span>
                    <span className="sep">·</span>
                    <span className="mono">out {formatTokens(candidate.output)}</span>
                    <span className="sep">·</span>
                    <span>{describeReasoning(candidate.reasoning)}</span>
                  </div>
                  <div className="candidate-reason">
                    <span className="reason-label">匹配原因</span>
                    <span>{candidate.matchReason}</span>
                    <span className="reason-score mono">{candidate.score.toFixed(2)}</span>
                    {crossProvider ? (
                      <span className="muted small">
                        跨提供方回退来自本地索引；请核对标识，界面不据此断言能力。
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="candidate-action">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      onAdopt(candidate, includeReasoning);
                    }}
                  >
                    采用元数据
                  </button>
                  {candidate.providerId !== provider.id ? (
                    <span className="muted tiny">来源 {candidate.providerId}</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">
        匹配原因只描述本地索引的匹配方式，不是模型能力、可用性或运行时生效的证明。
        {demo ? ' 当前为演示目录。' : ''}
      </p>
      {targetExisting ? (
        <p className="muted small">目标模型“{targetExisting.id}”已存在；采用时会以草稿覆盖对应叶子字段。</p>
      ) : null}    </Modal>
  );
}

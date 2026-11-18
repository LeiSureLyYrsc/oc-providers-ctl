import type { SourceDocument } from '../ipc';
import type { CheckItem } from '../lib/checks';
import { credentialLabel, shortHash } from '../lib/format';
import type { WorkbenchState } from '../lib/store';
import { batchFor } from '../lib/store';
import { Badge, CredentialBadge, DialectBadge, SeverityBadge } from '../components/Badge';
import { Icon } from '../components/Icon';

interface OverviewViewProps {
  state: WorkbenchState;
  checks: CheckItem[];
  onOpenSource: (path: string) => void;
  onOpenProvider: (sourcePath: string, providerId: string) => void;
  onOpenModel: (sourcePath: string, providerId: string, modelId: string) => void;
  onJumpCheck: (check: CheckItem) => void;
  onGoChecks: () => void;
}

function SourceCell({
  source,
  state,
  warningCount,
  draftCount,
  onOpen,
}: {
  source: SourceDocument;
  state: WorkbenchState;
  warningCount: number;
  draftCount: number;
  onOpen: () => void;
}) {
  const isActive = state.activeSourcePath === source.path;
  return (
    <button
      type="button"
      className={`topo-source-cell${isActive ? ' is-active' : ''}`}
      onClick={onOpen}
      title={source.path}
    >
      <span className="topo-source-top">
        <DialectBadge dialect={source.dialect} />
        {source.writable ? (
          <span className="muted tiny">可写</span>
        ) : (
          <span className="lock-mark"><Icon name="lock" size={11} /> 只读</span>
        )}
        {warningCount > 0 ? <span className="warn-count">{warningCount} 告警</span> : null}
        {draftCount > 0 ? <Badge tone="draft">{draftCount} 草稿</Badge> : null}
      </span>
      <span className="topo-source-path mono">{source.path}</span>
      <span className="topo-source-foot mono">
        {source.providers.length} 提供方 · {source.providers.reduce((total, provider) => total + provider.models.length, 0)} 模型 · {shortHash(source.hash, 8)}
      </span>
      {source.defaultModel ? (
        <span className="topo-source-default mono">
          默认 <span>{source.defaultModel}</span>
        </span>
      ) : (
        <span className="topo-source-default muted tiny">未声明默认模型</span>
      )}
    </button>
  );
}

export function OverviewView({
  state,
  checks,
  onOpenSource,
  onOpenProvider,
  onOpenModel,
  onJumpCheck,
  onGoChecks,
}: OverviewViewProps) {
  const sources = state.snapshot?.sources ?? [];
  const providerCount = sources.reduce((total, source) => total + source.providers.length, 0);
  const modelCount = sources.reduce(
    (total, source) => total + source.providers.reduce((sum, provider) => sum + provider.models.length, 0),
    0,
  );
  const draftCount = Object.values(state.batches).reduce((total, batch) => total + batch.edits.length, 0);
  const attention = checks.filter((check) => check.severity !== 'info');
  const visibleChecks = attention.slice(0, 4);

  return (
    <div className="pane overview-pane">
      <header className="overview-head">
        <div className="overview-title-block">
          <div className="eyebrow">WORKSPACE / 工作区</div>
          <h1 data-view-title tabIndex={-1}>
            配置源到模型的血统
          </h1>
          <p className="overview-lede">
            从文件向下追到提供方、模型与字段叶子。所有编辑先成为草稿，预演通过后才可能写盘。
          </p>
        </div>
        <div className="overview-summary">
          <span><strong>{sources.length}</strong> 配置源</span>
          <span className="summary-divider" aria-hidden="true" />
          <span><strong>{providerCount}</strong> 提供方</span>
          <span className="summary-divider" aria-hidden="true" />
          <span><strong>{modelCount}</strong> 模型</span>
          <span className="summary-divider" aria-hidden="true" />
          <span><strong>{sources.filter((source) => source.writable).length}</strong> 可写</span>
          <span className="summary-divider" aria-hidden="true" />
          <span data-draft={draftCount > 0}><strong>{draftCount}</strong> 未应用草稿</span>
        </div>
      </header>

      {sources.length === 0 ? (
        <div className="empty-state overview-empty">
          <Icon name="scan" size={24} />
          <h3>还没有可展示的配置源</h3>
          <p>
            在桌面应用中扫描全局或项目；浏览器预览会载入确定性的虚构样例。载入后这里会显示从文件到模型的血统。
          </p>
        </div>
      ) : (
        <div className="topology" aria-label="配置源到模型的血统拓扑">
          <div className="topo-head-row" aria-hidden="true">
            <span>配置源 / SOURCE</span>
            <span>提供方 / PROVIDER</span>
            <span>模型 / MODEL</span>
          </div>
          {sources.map((source) => {
            const rows = Math.max(1, source.providers.length);
            return (
              <div
                className="topo-group"
                key={source.path}
                style={{ gridTemplateRows: `repeat(${rows}, minmax(58px, auto))` }}
              >
                <div className="topo-source-slot" style={{ gridRow: `span ${rows}` }}>
                  <SourceCell
                    source={source}
                    state={state}
                    warningCount={source.warnings.length}
                    draftCount={batchFor(state, source.path)?.edits.length ?? 0}
                    onOpen={() => onOpenSource(source.path)}
                  />
                </div>
                {source.providers.length === 0 ? (
                  <div className="topo-empty-row">
                    <span>此文件没有提供方</span>
                  </div>
                ) : (
                  source.providers.flatMap((provider) => [
                    <button
                      type="button"
                      className="topo-provider-cell"
                      key={`${source.path}:${provider.id}:p`}
                      onClick={() => onOpenProvider(source.path, provider.id)}
                      title={`${provider.id} · ${provider.name ?? '未命名'}`}
                    >
                      <span className="topo-provider-top">
                        <DialectBadge dialect={provider.dialect} />
                        <span className="mono topo-provider-id">{provider.id}</span>
                        <CredentialBadge status={provider.credentialStatus} />
                      </span>
                      <span className="topo-provider-name">{provider.name ?? '未命名'}</span>
                      <span className="topo-provider-meta mono">
                        {provider.models.length} 模型 · {credentialLabel(provider.credentialStatus)}
                      </span>
                    </button>,
                    <div
                      className="topo-models-cell"
                      key={`${source.path}:${provider.id}:m`}
                    >
                      <span className="topo-model-count mono">
                        {provider.models.length}
                        <span className="muted tiny"> 模型</span>
                      </span>
                      <span className="topo-model-samples">
                        {provider.models.length === 0 ? (
                          <span className="muted tiny">无模型</span>
                        ) : (
                          provider.models.slice(0, 3).map((model) => (
                            <button
                              type="button"
                              className="model-chip mono"
                              key={model.id}
                              title={`查看模型 ${model.id}`}
                              onClick={() => onOpenModel(source.path, provider.id, model.id)}
                            >
                              {model.id}
                            </button>
                          ))
                        )}
                        {provider.models.length > 3 ? (
                          <span className="muted tiny">+{provider.models.length - 3}</span>
                        ) : null}
                      </span>
                    </div>,
                  ])
                )}
              </div>
            );
          })}
        </div>
      )}

      <section className="overview-checks" aria-label="检查摘要">
        <header className="overview-checks-head">
          <div>
            <div className="eyebrow">ATTENTION / 需要留意</div>
            <h2>
              {attention.length === 0 ? '没有错误或提示' : `${attention.length} 条错误或提示`}
            </h2>
          </div>
          <button type="button" className="btn btn-small" onClick={onGoChecks}>
            查看全部检查
            <Icon name="arrow" size={13} />
          </button>
        </header>
        {visibleChecks.length === 0 ? (
          <div className="overview-clear">
            <Icon name="check" size={15} />
            <span>当前扫描没有发现结构错误或提示。仍可在「检查」视图查看信息级说明。</span>
          </div>
        ) : (
          <ul className="overview-check-list">
            {visibleChecks.map((check) => (
              <li key={check.id}>
                <button type="button" className="overview-check-row" onClick={() => onJumpCheck(check)}>
                  <SeverityBadge severity={check.severity} />
                  <span className="overview-check-title">{check.title}</span>
                  <span className="mono muted overview-check-scope">{check.scope}</span>
                  <Icon name="chevron" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

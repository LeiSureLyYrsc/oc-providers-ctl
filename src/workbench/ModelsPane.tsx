import type { ModelEntry, ProviderEntry, SourceDocument } from '../ipc';
import { formatTokens } from '../lib/format';
import { describeReasoningDetail, reasoningSupported } from '../lib/reasoning';
import { Icon } from '../components/Icon';

export interface DraftLabel {
  label: string;
  path: string[];
}

interface ModelsPaneProps {
  source: SourceDocument | null;
  provider: ProviderEntry | null;
  model: ModelEntry | null;
  defaultModel: string | null;
  query: string;
  draftLabels: DraftLabel[];
  onSelectModel: (id: string | null) => void;
  onEditProvider: () => void;
  onAddModel: () => void;
  onEditModel: () => void;
  onRefreshModels: () => void;
  onSuggest: () => void;
  onSetDefault: (provider: ProviderEntry, model: ModelEntry, clear: boolean) => void;
  onDeleteProvider: (provider: ProviderEntry) => void;
  onDeleteModel: (model: ModelEntry) => void;
  onAddProvider: () => void;
  busy: boolean;
}

function providerScoped(path: string[], providerId: string): boolean {
  return (path[0] === 'provider' || path[0] === 'providers') && path[1] === providerId;
}

export function ModelsPane({
  source,
  provider,
  model,
  defaultModel,
  query,
  draftLabels,
  onSelectModel,
  onEditProvider,
  onAddModel,
  onEditModel,
  onRefreshModels,
  onSuggest,
  onSetDefault,
  onDeleteProvider,
  onDeleteModel,
  onAddProvider,
  busy,
}: ModelsPaneProps) {
  if (!source) {
    return (
      <section className="pane pane-right">
        <div className="empty">
          <Icon name="file" size={40} />
          <h3>还没有打开配置</h3>
          <p>在左上角选择配置文件，或从「更多」菜单打开文件。</p>
        </div>
      </section>
    );
  }

  if (!provider) {
    const pending = draftLabels.filter((draft) => draft.path.length === 2);
    return (
      <section className="pane pane-right">
        <div className="empty">
          <Icon name="add" size={40} />
          <h3>还没有供应商</h3>
          <p>添加一个供应商后，就可以管理它的模型。</p>
          <button type="button" className="btn btn-filled" onClick={onAddProvider}>
            添加供应商
          </button>
        </div>
        {pending.length > 0 ? (
          <div style={{ padding: '0 20px 24px', flex: '0 0 auto' }}>
            <div className="card">
              <div className="card-head">
                <h3>待保存的供应商</h3>
              </div>
              <ul className="model-list">
                {pending.map((draft) => (
                  <li key={draft.path.join('.')}>
                    <div className="model-row is-pending">
                      <span className="model-name">
                        <span className="primary mono">{draft.path[1]}</span>
                        <span className="secondary">保存后可用</span>
                      </span>
                      <span className="chip" data-tone="muted">
                        待保存
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  const readOnly = !source.writable;
  const needle = query.trim().toLowerCase();
  const models = provider.models.filter((entry) => {
    if (!needle) return true;
    return (
      entry.id.toLowerCase().includes(needle) ||
      (entry.name ?? '').toLowerCase().includes(needle)
    );
  });
  const defaultId = defaultModel?.startsWith(`${provider.id}/`)
    ? defaultModel.slice(provider.id.length + 1)
    : null;

  const drafts = draftLabels.filter((draft) => providerScoped(draft.path, provider.id));
  const providerDrafts = drafts.filter((draft) => draft.path.slice(2).indexOf('models') === -1);
  const newModels = drafts.filter(
    (draft) =>
      draft.path[2] === 'models' &&
      draft.path.length === 4 &&
      !provider.models.some((entry) => entry.id === draft.path[3]),
  );
  const editedIds = new Set(
    drafts.filter((draft) => draft.path[2] === 'models').map((draft) => draft.path[3]),
  );
  const deleting = drafts.some((draft) => draft.path.length === 2);
  const detail = describeReasoningDetail(model?.reasoning);

  return (
    <section className="pane pane-right" aria-label="模型">
      <div className="detail">
        <header className="detail-head">
          <div className="detail-title">
            <h2>{model ? model.name || model.id : provider.name || provider.id}</h2>
            <div className="detail-sub">
              {model
                ? `${provider.id} · ${model.id}`
                : `${provider.id} · ${provider.models.length} 个模型`}
            </div>
          </div>
          <div className="head-actions">
            {model ? (
              <>
                <button type="button" className="btn btn-small" onClick={() => onSelectModel(null)}>
                  返回
                </button>
                <button
                  type="button"
                  className="btn btn-tonal btn-small"
                  onClick={onEditModel}
                  disabled={readOnly || busy}
                >
                  编辑
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-tonal btn-small"
                  onClick={onEditProvider}
                  disabled={readOnly || busy}
                >
                  编辑供应商
                </button>
                <button
                  type="button"
                  className="btn btn-filled btn-small"
                  onClick={onAddModel}
                  disabled={readOnly || busy}
                >
                  <Icon name="add" size={18} />
                  添加模型
                </button>
              </>
            )}
          </div>
        </header>

        <div className="detail-body">
          {providerDrafts.length > 0 ? (
            <div className="draft-strip">
              <Icon name="edit" size={18} />
              <span>
                {deleting
                  ? '这个供应商将在保存后删除。'
                  : `这个供应商有 ${providerDrafts.length} 项未保存的修改。`}
              </span>
            </div>
          ) : null}

          {model ? (
            <>
              <div className="card">
                <div className="card-head">
                  <h3>模型信息</h3>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="text-btn"
                    style={{ color: 'var(--error)' }}
                    onClick={() => onDeleteModel(model)}
                    disabled={readOnly || busy}
                  >
                    删除
                  </button>
                </div>
                {editedIds.has(model.id) ? (
                  <p className="inline-note">
                    <Icon name="edit" size={18} />
                    这个模型有未保存的修改。
                  </p>
                ) : null}
                <div className="read-line">
                  <span className="read-label">模型 ID</span>
                  <span className="read-value mono">{model.id}</span>
                </div>
                <div className="read-line">
                  <span className="read-label">名称</span>
                  <span className="read-value">{model.name || '未填写'}</span>
                </div>
                <div className="read-line">
                  <span className="read-label">上下文</span>
                  <span className="read-value">
                    {model.context === null ? '未设置' : `${formatTokens(model.context)} token`}
                  </span>
                </div>
                <div className="read-line">
                  <span className="read-label">输入 / 输出</span>
                  <span className="read-value">
                    {model.input === null ? '未设置' : `${formatTokens(model.input)} token`} /{' '}
                    {model.output === null ? '未设置' : `${formatTokens(model.output)} token`}
                  </span>
                </div>
                <div className="read-line">
                  <span className="read-label">思考能力</span>
                  <span className="read-value">{detail.supported}</span>
                </div>
                <div className="read-line">
                  <span className="read-label">可关闭思考</span>
                  <span className="read-value">{detail.toggle}</span>
                </div>
                <div className="read-line">
                  <span className="read-label">可选档位</span>
                  <span className="read-value mono">{detail.effort}</span>
                </div>
                <div className="read-line">
                  <span className="read-label">预算</span>
                  <span className="read-value">{detail.budget}</span>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>默认模型</h3>
                  <span className="spacer" />
                  {defaultId === model.id ? (
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => onSetDefault(provider, model, true)}
                      disabled={readOnly || busy}
                    >
                      取消默认
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => onSetDefault(provider, model, false)}
                      disabled={readOnly || busy}
                    >
                      设为默认
                    </button>
                  )}
                </div>
                <p className="field-hint">
                  {defaultId === model.id
                    ? `当前默认模型是 ${provider.id}/${model.id}。`
                    : '默认模型写在配置的 model 字段。'}
                </p>
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>查询模型资料</h3>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="text-btn"
                    onClick={onSuggest}
                    disabled={busy}
                  >
                    从模型目录查找
                  </button>
                </div>
                <p className="field-hint">
                  按模型 ID 或名称查询公共模型目录里的名称、长度和思考能力；勾选的字段才会写入，已有内容默认不覆盖。
                </p>
              </div>
            </>
          ) : (
            <>
              {readOnly ? (
                <p className="inline-note">
                  <Icon name="lock" size={18} />
                  这个文件是只读的，只能查看。
                </p>
              ) : null}
              <div className="card">
                <div className="card-head">
                  <h3>供应商信息</h3>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="text-btn"
                    style={{ color: 'var(--error)' }}
                    onClick={() => onDeleteProvider(provider)}
                    disabled={readOnly || busy}
                  >
                    删除
                  </button>
                </div>
                <div className="read-line">
                  <span className="read-label">名称</span>
                  <span className="read-value">{provider.name || '未填写'}</span>
                </div>
                <div className="read-line">
                  <span className="read-label">基础地址</span>
                  <span className="read-value mono">{provider.baseUrl || '未填写'}</span>
                </div>
                <div className="read-line">
                  <span className="read-label">凭据</span>
                  <span className="read-value">
                    {provider.credentialStatus === 'reference'
                      ? '引用'
                      : provider.credentialStatus === 'inline'
                        ? '已内联（界面不显示）'
                        : '未提供'}
                  </span>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>模型</h3>
                  <span style={{ fontSize: 14, color: 'var(--on-surface-3)' }}>
                    {provider.models.length + newModels.length}
                  </span>
                  <span className="spacer" />
                  <button type="button" className="text-btn" onClick={onRefreshModels} disabled={busy}>
                    从供应商获取
                  </button>
                </div>
                {provider.models.length === 0 && newModels.length === 0 ? (
                  <p className="list-empty">这个供应商还没有模型。</p>
                ) : models.length === 0 && newModels.length === 0 ? (
                  <p className="list-empty">没有匹配的模型。</p>
                ) : (
                  <ul className="model-list">
                    {models.map((entry) => {
                      const supported = reasoningSupported(entry.reasoning);
                      return (
                        <li key={entry.id}>
                          <button
                            type="button"
                            className="model-row"
                            onClick={() => onSelectModel(entry.id)}
                          >
                            <span className="model-name">
                              <span className="primary">{entry.name || entry.id}</span>
                              <span className="secondary mono">{entry.id}</span>
                            </span>
                            <span className="model-meta">
                              {entry.context === null ? '—' : `${formatTokens(entry.context)} token`}
                            </span>
                            <span className="model-flag">
                              {defaultId === entry.id ? (
                                <span className="chip" data-tone="accent">
                                  <span className="chip-dot" />
                                  默认
                                </span>
                              ) : null}
                              {supported === true ? (
                                <span
                                  className="chip"
                                  data-tone="muted"
                                  title="配置声明支持思考，不代表档位或默认强度"
                                >
                                  可思考
                                </span>
                              ) : null}
                              {editedIds.has(entry.id) ? (
                                <span className="chip" data-tone="muted">
                                  已修改
                                </span>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {newModels.map((draft) => (
                      <li key={`pending-${draft.path[3]}`}>
                        <div className="model-row is-pending">
                          <span className="model-name">
                            <span className="primary mono">{draft.path[3]}</span>
                            <span className="secondary">新增，保存后可用</span>
                          </span>
                          <span className="chip" data-tone="muted">
                            待保存
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

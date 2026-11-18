import type { ModelEntry, ProviderEntry, SourceDocument } from '../ipc';
import type { CheckItem } from '../lib/checks';
import { buildChecks } from '../lib/checks';
import {
  compactValue,
  credentialHint,
  credentialLabel,
  dialectLabel,
  formatTokens,
  isModelDefault,
} from '../lib/format';
import type { Batch, WorkbenchState } from '../lib/store';
import { batchFor, draftForPath } from '../lib/store';
import {
  composeDefaultModel,
  formatPath,
  isConcreteDialect,
  locateModel,
  modelLeafPath,
  providerLeafPath,
} from '../lib/paths';
import type { ConcreteDialect } from '../lib/paths';
import type { DraftIntent } from '../lib/editRules';
import { describeReasoning } from '../lib/reasoning';
import { modelLineage, providerLineage, sourceLineage } from '../lib/lineage';
import { Lineage } from './Lineage';
import { DraftTray } from './DraftTray';
import { AdvancedJsonEditor, FieldEditor } from './FieldEditors';
import { Badge, CredentialBadge, DialectBadge } from './Badge';
import { Icon } from './Icon';

export interface InspectorActions {
  stage: (
    dialect: ConcreteDialect,
    intent: DraftIntent,
    path: string[],
    op: 'set' | 'remove',
    value: unknown,
    label: string,
  ) => void;
  setDefault: (provider: ProviderEntry, model: ModelEntry, clear: boolean) => void;
  addModel: (provider: ProviderEntry) => void;
  deleteProvider: (provider: ProviderEntry) => void;
  deleteModel: (provider: ProviderEntry, model: ModelEntry) => void;
  openCandidates: (provider: ProviderEntry, model: ModelEntry) => void;
  openInventory: (provider: ProviderEntry) => void;
  restore: (source: SourceDocument) => void;
  reload: (source: SourceDocument) => void;
  jump: (check: CheckItem) => void;
  openProvider: (providerId: string) => void;
  openModel: (providerId: string, modelId: string) => void;
  selectSource: (path: string) => void;
  preview: () => void;
  apply: () => void;
  unstage: (draftId: string) => void;
  clearBatch: () => void;
}

interface InspectorProps {
  state: WorkbenchState;
  source: SourceDocument | null;
  check: CheckItem | null;
  applying: boolean;
  actions: InspectorActions;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function ReadRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="read-row">
      <span className="read-label">{label}</span>
      <span className={mono ? 'read-value mono' : 'read-value'}>{value}</span>
    </div>
  );
}

function ReadonlyNotice({ reason }: { reason: string }) {
  return (
    <div className="readonly-notice">
      <Icon name="lock" size={14} />
      <span>{reason}</span>
    </div>
  );
}

function lineageReason(source: SourceDocument, provider: ProviderEntry): string | null {
  if (!source.writable) return '该配置源为只读。';
  if (!isConcreteDialect(provider.dialect)) {
    return '该提供方嵌套结构不是可定位的 V1 / V2 形态，只读展示。';
  }
  return null;
}

function ProviderInspector({
  source,
  provider,
  batch,
  actions,
}: {
  source: SourceDocument;
  provider: ProviderEntry;
  batch: Batch | null;
  actions: InspectorActions;
}) {
  const dialect = isConcreteDialect(provider.dialect) ? provider.dialect : null;
  const readonlyReason = lineageReason(source, provider);

  return (
    <>
      <div className="inspector-meta-row">
        <DialectBadge dialect={provider.dialect} />
        <CredentialBadge status={provider.credentialStatus} />
        <Badge tone="muted">{provider.models.length} 模型</Badge>
      </div>
      <Lineage nodes={providerLineage(source, provider, batch)} caption="来源血统 / 提供方" />
      {readonlyReason ? <ReadonlyNotice reason={readonlyReason} /> : null}

      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">READ / 只读字段</span>
          <span className="muted tiny">不会从 DTO 重建整个条目</span>
        </div>
        <ReadRow label="标识" value={provider.id} mono />
        <ReadRow
          label="方言"
          value={
            dialect
              ? `${dialectLabel(provider.dialect)} · ${dialect === 'v2' ? 'providers' : 'provider'}`
              : `${dialectLabel(provider.dialect)} · 无法定位`
          }
        />
        <ReadRow label="凭据" value={credentialLabel(provider.credentialStatus)} />
        <ReadRow label="包字段" value="保持原样（DTO 未暴露 npm / package 值）" />
        <p className="muted small">{credentialHint(provider.credentialStatus)}</p>
      </section>

      {!readonlyReason && dialect ? (
        <section className="section-block">
          <div className="section-head">
            <span className="eyebrow">EDIT / 字段级草稿</span>
            <span className="muted tiny">仅 name 与 baseURL</span>
          </div>
          <FieldEditor
            key={`p-name-${source.path}-${source.hash}-${provider.id}`}
            label="显示名 / NAME"
            path={providerLeafPath(dialect, provider.id, 'name')}
            dialect={dialect}
            kind="text"
            current={provider.name}
            readLabel={formatPath(providerLeafPath(dialect, provider.id, 'name'), dialect)}
            batch={batch}
            onStage={(path, op, value, label) => actions.stage(dialect, 'field', path, op, value, label)}
          />
          <FieldEditor
            key={`p-base-${source.path}-${source.hash}-${provider.id}`}
            label="基础地址 / BASE URL"
            path={providerLeafPath(dialect, provider.id, 'baseUrl')}
            dialect={dialect}
            kind="text"
            current={provider.baseUrl}
            readLabel={formatPath(providerLeafPath(dialect, provider.id, 'baseUrl'), dialect)}
            batch={batch}
            hint="写入对应方言的 settings.baseURL（V2）或 options.baseURL（V1）。"
            onStage={(path, op, value, label) => actions.stage(dialect, 'field', path, op, value, label)}
          />
        </section>
      ) : null}

      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">MODELS / 模型</span>
          <span className="muted tiny">选择后查看字段血统</span>
        </div>
        {provider.models.length === 0 ? (
          <p className="muted small">该提供方下没有模型。</p>
        ) : (
          <ul className="mini-model-list">
            {provider.models.map((model) => {
              const locator = locateModel(provider, model);
              const hasDraft =
                dialect && batch
                  ? (['name', 'context', 'input', 'output', 'reasoning', 'variants'] as const).some(
                      (leaf) => Boolean(draftForPath(batch, modelLeafPath(dialect, locator, leaf))),
                    )
                  : false;
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    className="mini-model-row"
                    onClick={() => actions.openModel(provider.id, model.id)}
                  >
                    <span className="mono">{model.id}</span>
                    {isModelDefault(source, provider.id, model.id) ? (
                      <Badge tone="accent">默认</Badge>
                    ) : null}
                    {hasDraft ? <span className="draft-dot" title="该模型存在草稿" /> : null}
                    <span className="mini-model-tokens mono">
                      ctx {formatTokens(model.context)} · out {formatTokens(model.output)}
                    </span>
                    <Icon name="chevron" size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="inline-actions">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => actions.addModel(provider)}
            disabled={Boolean(readonlyReason)}
          >
            <Icon name="plus" size={13} />
            新建模型
          </button>
          <button type="button" className="btn btn-small" onClick={() => actions.openInventory(provider)}>
            <Icon name="download" size={13} />
            手动抓取清单
          </button>
        </div>
      </section>

      <section className="section-block danger-zone">
        <div className="section-head">
          <span className="eyebrow">DELETE / 删除</span>
        </div>
        <p className="muted small">
          显式删除整个提供方条目（包括其模型）。不会重建或替换其它条目。
        </p>
        <button
          type="button"
          className="btn btn-small btn-danger-ghost"
          onClick={() => actions.deleteProvider(provider)}
          disabled={Boolean(readonlyReason)}
        >
          <Icon name="trash" size={13} />
          删除提供方
        </button>
      </section>
    </>
  );
}

function ModelInspector({
  source,
  provider,
  model,
  batch,
  actions,
}: {
  source: SourceDocument;
  provider: ProviderEntry;
  model: ModelEntry;
  batch: Batch | null;
  actions: InspectorActions;
}) {
  const concrete = isConcreteDialect(provider.dialect) ? provider.dialect : null;
  const readonlyReason = lineageReason(source, provider);
  const locator = locateModel(provider, model);
  const defaultValue = composeDefaultModel(provider.id, model.id);
  const isDefault = isModelDefault(source, provider.id, model.id);

  return (
    <>
      <div className="inspector-meta-row">
        <DialectBadge dialect={provider.dialect} />
        <Badge tone="muted">{provider.id}</Badge>
        {isDefault ? <Badge tone="accent">默认模型</Badge> : null}
      </div>
      <Lineage nodes={modelLineage(source, provider, model, batch)} caption="来源血统 / 模型叶子" />
      {readonlyReason ? <ReadonlyNotice reason={readonlyReason} /> : null}

      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">DEFAULT / 默认模型</span>
          <span className="muted tiny">顶层 model；不追加变体后缀</span>
        </div>
        <div className="default-row">
          <code className="mono default-value">{source.defaultModel ?? '未声明'}</code>
          {isDefault ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={Boolean(readonlyReason)}
              onClick={() => actions.setDefault(provider, model, true)}
            >
              清除默认
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-small"
              disabled={Boolean(readonlyReason)}
              onClick={() => actions.setDefault(provider, model, false)}
            >
              设为默认模型
            </button>
          )}
        </div>
        <p className="muted small">
          将写入 <code className="mono">{defaultValue}</code>。只使用 provider/model，不会猜测或补写变体。
        </p>
      </section>

      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">READ / 标识</span>
        </div>
        <ReadRow label="模型标识" value={model.id} mono />
        <ReadRow label="请求 ID" value={model.requestId ?? '未设置（只读）'} mono />
        <ReadRow
          label="方言"
          value={
            concrete
              ? `${dialectLabel(concrete)} · models 对象键`
              : '嵌套无效'
          }
        />
      </section>

      {!readonlyReason && concrete ? (
        <section className="section-block">
          <div className="section-head">
            <span className="eyebrow">EDIT / 数值与名称</span>
            <span className="muted tiny">逐叶子写入</span>
          </div>
          <FieldEditor
            key={`m-name-${source.path}-${source.hash}-${provider.id}-${model.id}`}
            label="显示名 / NAME"
            path={modelLeafPath(concrete, locator, 'name')}
            dialect={concrete}
            kind="text"
            current={model.name}
            readLabel={formatPath(modelLeafPath(concrete, locator, 'name'), concrete)}
            batch={batch}
            onStage={(path, op, value, label) => actions.stage(concrete, 'field', path, op, value, label)}
          />
          <div className="field-grid-two">
            <FieldEditor
              key={`m-ctx-${source.path}-${source.hash}-${provider.id}-${model.id}`}
              label="上下文窗口 / CONTEXT"
              path={modelLeafPath(concrete, locator, 'context')}
              dialect={concrete}
              kind="tokens"
              current={model.context}
              readLabel={formatPath(modelLeafPath(concrete, locator, 'context'), concrete)}
              batch={batch}
              onStage={(path, op, value, label) => actions.stage(concrete, 'field', path, op, value, label)}
            />
            <FieldEditor
              key={`m-in-${source.path}-${source.hash}-${provider.id}-${model.id}`}
              label="输入上限 / LIMIT.INPUT"
              path={modelLeafPath(concrete, locator, 'input')}
              dialect={concrete}
              kind="tokens"
              current={model.input}
              readLabel={formatPath(modelLeafPath(concrete, locator, 'input'), concrete)}
              batch={batch}
              onStage={(path, op, value, label) => actions.stage(concrete, 'field', path, op, value, label)}
            />
            <FieldEditor
              key={`m-out-${source.path}-${source.hash}-${provider.id}-${model.id}`}
              label="输出上限 / LIMIT.OUTPUT"
              path={modelLeafPath(concrete, locator, 'output')}
              dialect={concrete}
              kind="tokens"
              current={model.output}
              readLabel={formatPath(modelLeafPath(concrete, locator, 'output'), concrete)}
              batch={batch}
              onStage={(path, op, value, label) => actions.stage(concrete, 'field', path, op, value, label)}
            />
          </div>
          <p className="muted small">
            当前读取值：ctx {formatTokens(model.context)} · in {formatTokens(model.input)} · out{' '}
            {formatTokens(model.output)}。只按数字写入，不换算也不推断运行时生效值。
          </p>
        </section>
      ) : null}

      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">ADVANCED / 推理与变体</span>
          <span className="muted tiny">JSON 结构检查 · 未知字段提示</span>
        </div>
        {!readonlyReason && concrete ? (
          <>
            <AdvancedJsonEditor
              key={`r-${source.path}-${source.hash}-${provider.id}-${model.id}`}
              label="推理 / REASONING"
              field="reasoning"
              dialect={concrete}
              path={modelLeafPath(concrete, locator, 'reasoning')}
              current={model.reasoning}
              batch={batch}
              onStage={(path, op, value, label) => actions.stage(concrete, 'field', path, op, value, label)}
            />
            <AdvancedJsonEditor
              key={`v-${source.path}-${source.hash}-${provider.id}-${model.id}`}
              label="变体 / VARIANTS"
              field="variants"
              dialect={concrete}
              path={modelLeafPath(concrete, locator, 'variants')}
              current={model.variants}
              batch={batch}
              onStage={(path, op, value, label) => actions.stage(concrete, 'field', path, op, value, label)}
            />
          </>
        ) : (
          <>
            <ReadRow label="推理" value={describeReasoning(model.reasoning)} />
            <ReadRow label="变体" value={compactValue(model.variants)} mono />
          </>
        )}
      </section>

      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">METADATA / 建议与清单</span>
        </div>
        <div className="inline-actions">
          <button type="button" className="btn btn-small" onClick={() => actions.openCandidates(provider, model)}>
            <Icon name="spark" size={13} />
            目录建议
          </button>
          <button type="button" className="btn btn-small" onClick={() => actions.openInventory(provider)}>
            <Icon name="download" size={13} />
            手动抓取清单
          </button>
        </div>
        <p className="muted small">
          建议只补充元数据，不写请求 ID、不创建变体；匹配原因不代表能力证明。清单只用于按实际标识新增模型。
        </p>
      </section>

      <section className="section-block danger-zone">
        <div className="section-head">
          <span className="eyebrow">DELETE / 删除</span>
        </div>
        <button
          type="button"
          className="btn btn-small btn-danger-ghost"
          onClick={() => actions.deleteModel(provider, model)}
          disabled={Boolean(readonlyReason)}
        >
          <Icon name="trash" size={13} />
          删除模型
        </button>
      </section>
    </>
  );
}

function SourceInspector({ source, actions }: { source: SourceDocument; actions: InspectorActions }) {
  return (
    <>
      <div className="inspector-meta-row">
        <DialectBadge dialect={source.dialect} />
        <Badge tone={source.writable ? 'ok' : 'muted'} dot={source.writable}>
          {source.writable ? '可写' : '只读'}
        </Badge>
        <Badge tone="muted">hash {source.hash.slice(0, 10)}</Badge>
      </div>
      <Lineage nodes={sourceLineage(source)} caption="来源血统 / 文件" />
      {source.warnings.length > 0 ? (
        <section className="section-block">
          <div className="section-head">
            <span className="eyebrow">WARNINGS / 结构告警</span>
          </div>
          <ul className="warning-list">
            {source.warnings.map((warning) => (
              <li key={warning}>
                <Icon name="warning" size={13} />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">SOURCE / 文件</span>
        </div>
        <ReadRow label="完整路径" value={source.path} mono />
        <ReadRow label="哈希" value={source.hash} mono />
        <ReadRow label="默认模型" value={source.defaultModel ?? '未声明'} mono />
        <ReadRow
          label="模型总数"
          value={String(
            source.providers.reduce((total, entry) => total + entry.models.length, 0),
          )}
        />
      </section>
      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">ACTIONS / 文件动作</span>
          <span className="muted tiny">恢复只允许本进程创建的备份</span>
        </div>
        <div className="inline-actions">
          <button type="button" className="btn btn-small" onClick={() => actions.reload(source)}>
            <Icon name="refresh" size={13} />
            重新载入
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => actions.restore(source)}
            disabled={!source.writable}
            title={source.writable ? '恢复上一份由本进程创建的备份' : '只读配置源不能恢复'}
          >
            恢复上一备份
          </button>
        </div>
        <p className="muted small">
          恢复会以当前哈希校验外部改动；界面不显示备份内容，也不提供任意历史版本选择。演示模式或只读文件不可恢复。
        </p>
      </section>
      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">PROVIDERS / 提供方</span>
        </div>
        <ul className="mini-model-list">
          {source.providers.map((provider) => (
            <li key={provider.id}>
              <button
                type="button"
                className="mini-model-row"
                onClick={() => actions.openProvider(provider.id)}
              >
                <DialectBadge dialect={provider.dialect} />
                <span className="mono">{provider.id}</span>
                <span className="mini-model-tokens">{provider.name ?? '未命名'}</span>
                <span className="mono muted tiny">{provider.models.length} 模型</span>
                <Icon name="chevron" size={12} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function CheckInspector({
  check,
  checks,
  actions,
}: {
  check: CheckItem | null;
  checks: CheckItem[];
  actions: InspectorActions;
}) {
  if (!check) {
    return (
      <div className="inspector-empty">
        <Icon name="info" size={20} />
        <p>选择一条检查，查看范围、原因与可跳转位置。</p>
        <p className="muted small">共 {checks.length} 条检查；错误与提示会同时出现在总览里。</p>
      </div>
    );
  }
  return (
    <>
      <div className="inspector-meta-row">
        <Badge
          tone={
            check.severity === 'error' ? 'danger' : check.severity === 'warning' ? 'warn' : 'info'
          }
          dot
        >
          {check.severity === 'error' ? '错误' : check.severity === 'warning' ? '提示' : '信息'}
        </Badge>
        {check.action ? <Badge tone="muted">可跳转</Badge> : null}
      </div>
      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">CHECK / 检查</span>
        </div>
        <h3 className="check-title">{check.title}</h3>
        <ReadRow label="范围" value={check.scope} mono />
        {check.sourcePath ? <ReadRow label="配置源" value={check.sourcePath} mono /> : null}
        <p className="check-detail">{check.detail}</p>
      </section>
      {check.action ? (
        <div className="inline-actions">
          <button type="button" className="btn btn-small" onClick={() => actions.jump(check)}>
            <Icon name="arrow" size={13} />
            前往相关位置
          </button>
        </div>
      ) : null}
      <p className="muted small">
        检查只基于配置结构与本地目录缓存，不读取 OpenCode 运行时状态，也不断言模型可用性。
      </p>
    </>
  );
}

function WorkspaceInspector({
  state,
  source,
  checks,
  actions,
}: {
  state: WorkbenchState;
  source: SourceDocument | null;
  checks: CheckItem[];
  actions: InspectorActions;
}) {
  const sources = state.snapshot?.sources ?? [];
  const topChecks = checks.filter((check) => check.severity !== 'info').slice(0, 3);
  const draftBatches = Object.values(state.batches);
  const providerCount = sources.reduce((total, entry) => total + entry.providers.length, 0);
  const modelCount = sources.reduce(
    (total, entry) => total + entry.providers.reduce((sum, provider) => sum + provider.models.length, 0),
    0,
  );
  return (
    <>
      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">WORKSPACE / 工作区</span>
        </div>
        <div className="workspace-stat-line">
          <span><strong>{sources.length}</strong> 配置源</span>
          <span><strong>{providerCount}</strong> 提供方</span>
          <span><strong>{modelCount}</strong> 模型</span>
          <span><strong>{sources.filter((entry) => entry.writable).length}</strong> 可写</span>
        </div>
        <p className="muted small">
          只读取配置文件结构；不访问 OpenCode 服务或认证数据库，也不会声明运行时生效状态。凭证值不返回界面。
        </p>
      </section>
      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">SOURCES / 配置源</span>
        </div>
        <ul className="source-mini-list">
          {sources.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="source-mini-row"
                onClick={() => actions.selectSource(entry.path)}
              >
                <DialectBadge dialect={entry.dialect} />
                <span className="mono">{baseName(entry.path)}</span>
                <span className="muted tiny mono">{entry.hash.slice(0, 8)}</span>
                {entry.writable ? null : <Icon name="lock" size={12} />}
                <Icon name="chevron" size={12} />
              </button>
            </li>
          ))}
        </ul>
      </section>
      {draftBatches.length > 0 ? (
        <section className="section-block">
          <div className="section-head">
            <span className="eyebrow">DRAFTS / 未应用草稿</span>
          </div>
          <ul className="warning-list">
            {draftBatches.map((batch) => (
              <li key={batch.sourcePath}>
                <Icon name="draft" size={13} />
                <span className="mono">{batch.sourcePath}</span>
                <strong>{batch.edits.length} 条</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="section-block">
        <div className="section-head">
          <span className="eyebrow">ATTENTION / 需要留意</span>
        </div>
        {topChecks.length === 0 ? (
          <p className="muted small">没有错误或提示级检查。</p>
        ) : (
          <ul className="check-mini-list">
            {topChecks.map((check) => (
              <li key={check.id}>
                <button type="button" className="check-mini-row" onClick={() => actions.jump(check)}>
                  <Badge tone={check.severity === 'error' ? 'danger' : 'warn'} dot>
                    {check.severity === 'error' ? '错误' : '提示'}
                  </Badge>
                  <span>{check.title}</span>
                  <span className="mono muted tiny">{check.scope}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {source ? (
        <section className="section-block">
          <div className="section-head">
            <span className="eyebrow">CURRENT / 当前配置源</span>
          </div>
          <ReadRow label="文件" value={source.path} mono />
          <ReadRow label="方言" value={dialectLabel(source.dialect)} />
          <ReadRow label="默认模型" value={source.defaultModel ?? '未声明'} mono />
        </section>
      ) : null}
      <p className="muted small">
        从左侧切换视图；在表格里用 j / k 或方向键移动选择，右侧会同步展示来源血统与可编辑叶子。
      </p>
    </>
  );
}

export function Inspector({ state, source, check, applying, actions }: InspectorProps) {
  const snapshot = state.snapshot;
  const provider = source?.providers.find((entry) => entry.id === state.selectedProviderId) ?? null;
  const model = provider?.models.find((entry) => entry.id === state.selectedModelId) ?? null;
  const batch = batchFor(state, source?.path ?? null);
  const checks = buildChecks(state);

  let title = '工作区';
  let sub = snapshot ? `${snapshot.sources.length} 配置源` : '尚未扫描';
  if (state.view === 'providers') {
    title = provider ? provider.name ?? provider.id : '提供方详情';
    sub = provider ? `${provider.id} · ${provider.models.length} 模型` : '尚未选择提供方';
  } else if (state.view === 'models') {
    title = model ? model.id : '模型详情';
    sub = model && provider ? `${provider.id} · ${dialectLabel(provider.dialect)}` : '尚未选择模型';
  } else if (state.view === 'sources') {
    title = source ? baseName(source.path) : '配置源详情';
    sub = source ? `${dialectLabel(source.dialect)} · ${source.providers.length} 提供方` : '未载入配置源';
  } else if (state.view === 'checks') {
    title = check ? check.title : '检查详情';
    sub = check ? check.scope : '选择一条检查';
  } else {
    title = '工作区';
    sub = snapshot
      ? `${snapshot.sources.length} 源 · ${snapshot.sources.reduce((total, entry) => total + entry.providers.length, 0)} 提供方`
      : '尚未扫描';
  }

  let content;
  if (state.view === 'overview') {
    content = <WorkspaceInspector state={state} source={source} checks={checks} actions={actions} />;
  } else if (state.view === 'providers') {
    content =
      provider && source ? (
        <ProviderInspector source={source} provider={provider} batch={batch} actions={actions} />
      ) : (
        <div className="inspector-empty">
          <Icon name="chevron" size={20} />
          <p>在左侧表格选择一个提供方。</p>
          <p className="muted small">选中后会显示文件、映射、字段叶子与草稿来源。</p>
        </div>
      );
  } else if (state.view === 'models') {
    content =
      provider && model && source ? (
        <ModelInspector
          source={source}
          provider={provider}
          model={model}
          batch={batch}
          actions={actions}
        />
      ) : (
        <div className="inspector-empty">
          <Icon name="chevron" size={20} />
          <p>在左侧表格选择一个模型。</p>
          <p className="muted small">
            模型详情会展开与文件一致的 models 对象键叶子路径（V2 也按模型键，不按下标）。
          </p>
        </div>
      );
  } else if (state.view === 'sources') {
    content = source ? (
      <SourceInspector source={source} actions={actions} />
    ) : (
      <div className="inspector-empty">
        <Icon name="file" size={20} />
        <p>尚未选择配置源。</p>
        <p className="muted small">扫描全局或载入显式路径后，来源血统会出现在这里。</p>
      </div>
    );
  } else {
    content = <CheckInspector check={check} checks={checks} actions={actions} />;
  }

  return (
    <aside className="inspector" aria-label="详情检查器">
      <header className="inspector-head">
        <div className="eyebrow">INSPECTOR / 详情</div>
        <h2 title={title}>{title}</h2>
        <div className="inspector-sub">{sub}</div>
      </header>
      <div className="inspector-body">{content}</div>
      <DraftTray
        batch={batch}
        preview={state.preview}
        sourcePath={source?.path ?? null}
        sourceHash={source?.hash ?? null}
        writable={Boolean(source?.writable)}
        demo={state.mode === 'demo'}
        applying={applying}
        onPreview={actions.preview}
        onApply={actions.apply}
        onUnstage={actions.unstage}
        onClear={actions.clearBatch}
      />
    </aside>
  );
}

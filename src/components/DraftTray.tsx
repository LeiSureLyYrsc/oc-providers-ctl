import type { Batch, PreviewState } from '../lib/store';
import { formatPath } from '../lib/paths';
import { compactValue, shortHash } from '../lib/format';
import { Badge, ProvenanceTag } from './Badge';
import { Icon } from './Icon';

interface DraftTrayProps {
  batch: Batch | null;
  preview: PreviewState;
  sourcePath: string | null;
  sourceHash: string | null;
  writable: boolean;
  demo: boolean;
  applying: boolean;
  onPreview: () => void;
  onApply: () => void;
  onUnstage: (draftId: string) => void;
  onClear: () => void;
}

export function DraftTray({
  batch,
  preview,
  sourcePath,
  sourceHash,
  writable,
  demo,
  applying,
  onPreview,
  onApply,
  onUnstage,
  onClear,
}: DraftTrayProps) {
  const count = batch?.edits.length ?? 0;
  const canPreview = Boolean(batch && count > 0 && writable) && preview.status !== 'loading';
  const showPreview = preview.status !== 'idle' || Boolean(batch);

  return (
    <section className="draft-tray" aria-label="变更台">
      <header className="tray-head">
        <div className="tray-title">
          <span className="eyebrow">CHANGESET / 变更台</span>
          {count > 0 ? <Badge tone="draft" dot>{`${count} 条草稿`}</Badge> : null}
        </div>
        {sourcePath ? (
          <div className="tray-target">
            <span className="eyebrow">目标文件</span>
            <code className="mono tray-path">{sourcePath}</code>
            {sourceHash ? <span className="muted tiny mono">hash {shortHash(sourceHash, 10)}</span> : null}
          </div>
        ) : (
          <div className="tray-target muted small">未选择配置源</div>
        )}
      </header>

      {count === 0 && preview.status === 'idle' ? (
        <div className="tray-empty">
          <Icon name="draft" size={15} />
          <span>暂无草稿。字段改动会在这里暂存，预演通过后才可能写入磁盘。</span>
        </div>
      ) : count > 0 ? (
        <>
          <ul className="draft-list" aria-label="草稿列表">
            {batch?.edits.map((draft) => (
              <li key={draft.id} className="draft-row" data-origin={draft.origin}>
                <span className={`op-mark ${draft.op === 'set' ? 'is-set' : 'is-remove'}`}>
                  {draft.op === 'set' ? '+' : '−'}
                </span>
                <div className="draft-main">
                  <div className="draft-label">
                    <span>{draft.label}</span>
                    <ProvenanceTag origin={draft.origin} />
                  </div>
                  <code className="mono draft-path">{formatPath(draft.path, draft.dialect)}</code>
                  <div className="draft-value">
                    {draft.op === 'set' ? compactValue(draft.value, 70) : '清除该字段'}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn icon-btn-small"
                  onClick={() => onUnstage(draft.id)}
                  aria-label={`撤销草稿：${draft.label}`}
                  title={applying || preview.status === 'loading' ? '当前操作进行中，草稿已冻结' : '撤销这条草稿'}
                  disabled={applying || preview.status === 'loading'}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>
          <div className="tray-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={onClear}
              disabled={applying || preview.status === 'loading'}
            >
              清空草稿
            </button>
            <span className="tray-spacer" />
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={onPreview}
              disabled={!canPreview}
            >
              <Icon name="arrow" size={13} />
              {preview.status === 'loading' ? '预演中…' : '预演变更'}
            </button>
          </div>
        </>
      ) : null}

      {showPreview && preview.status !== 'idle' ? (
        <div className="preview-panel" aria-live="polite">
          {preview.status === 'loading' ? (
            <div className="preview-loading">正在请求预演…</div>
          ) : null}
          {preview.status === 'error' ? (
            <div className="dialog-error">
              <strong>预演未通过。</strong> {preview.message ?? '未能生成预演。'}
              <span className="preview-kept">草稿已保留。</span>
            </div>
          ) : null}
          {preview.status === 'blocked' ? (
            <div className="preview-blocked">
              <Badge tone="info">不会写盘</Badge>
              <p>{preview.message ?? '演示模式不会写入磁盘。'}</p>
            </div>
          ) : null}
          {preview.status === 'applied' ? (
            <div className="preview-success">
              <Icon name="check" size={14} />
              <span>{preview.message ?? '变更已写入磁盘。'}</span>
            </div>
          ) : null}
          {preview.result ? (
            <>
              <div className="preview-meta">
                <span className="eyebrow">PREVIEW / 预演</span>
                <span className="mono">编辑 {preview.result.editCount} 处</span>
                {preview.demo ? <Badge tone="info">演示示意</Badge> : <Badge tone="ok" dot>后端预演</Badge>}
              </div>
              <div className="preview-target">
                <span className="eyebrow">TARGET</span>
                <code className="mono">{preview.result.path}</code>
              </div>
              {preview.result.warnings.length > 0 ? (
                <ul className="preview-warnings">
                  {preview.result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              <pre className="diff-view" aria-label="变更预演 diff">
                {preview.result.diff}
              </pre>
              {preview.status === 'ready' || preview.status === 'blocked' ? (
                <div className="tray-actions">
                  {demo ? (
                    <span className="demo-apply-note">演示模式：应用入口禁用，绝不伪造写盘成功。</span>
                  ) : null}
                  <span className="tray-spacer" />
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    onClick={onApply}
                    disabled={applying || demo || preview.status === 'blocked'}
                    title={demo ? '演示模式不会写入磁盘' : undefined}
                  >
                    {applying ? '应用中…' : '应用到磁盘'}
                  </button>
                </div>
              ) : null}
              {preview.applyError ? (
                <div className="dialog-error">应用失败：{preview.applyError} 预演仍可查看，草稿已保留。</div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

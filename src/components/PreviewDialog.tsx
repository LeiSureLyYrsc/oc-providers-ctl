import type { PreviewState } from '../lib/store';
import { describeEdits, type SummaryEdit } from '../lib/summary';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

interface PreviewDialogProps {
  open: boolean;
  preview: PreviewState;
  edits: SummaryEdit[];
  demo: boolean;
  busy: boolean;
  onClose: () => void;
  onApply: () => void;
}

export function PreviewDialog({
  open,
  preview,
  edits,
  demo,
  busy,
  onClose,
  onApply,
}: PreviewDialogProps) {
  if (!open) return null;

  const loading = preview.status === 'loading';
  const ready = preview.status === 'ready' && preview.result;
  const applied = preview.status === 'applied';
  const blocked = preview.status === 'blocked';
  const summary = describeEdits(edits);

  return (
    <Dialog
      open
      title={applied ? '已保存' : '保存修改'}
      subtitle={preview.result?.path}
      onClose={onClose}
      wide
      actions={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {applied ? '完成' : '返回修改'}
          </button>
          {!applied ? (
            <button
              type="button"
              className="btn btn-filled"
              onClick={onApply}
              disabled={!ready || busy || demo}
              title={demo ? '演示模式不会写入磁盘' : undefined}
            >
              {busy ? '正在写入…' : '写入文件'}
            </button>
          ) : null}
        </>
      }
    >
      {loading ? (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          正在检查修改…
        </div>
      ) : null}

      {preview.status === 'error' ? (
        <div className="dialog-error">
          <strong>无法保存。</strong> {preview.message ?? '请重试。'}
        </div>
      ) : null}

      {blocked ? <div className="dialog-note">{preview.message}</div> : null}

      {applied ? (
        <div className="dialog-note" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Icon name="check" size={20} />
          修改已写入文件。
        </div>
      ) : null}

      {preview.result ? (
        <>
          <p style={{ margin: '4px 0 0', fontSize: 15 }}>
            将修改 {preview.result.editCount} 项
            {demo ? ' · 演示预览，不会写入磁盘' : ''}
          </p>
          {summary.length > 0 ? (
            <ul style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 15, lineHeight: 1.75 }}>
              {summary.slice(0, 8).map((line, index) => (
                <li key={`${line.target}-${index}`}>
                  {line.op === 'remove' ? '移除 ' : ''}
                  {line.target}
                  {line.value ? <span style={{ color: 'var(--on-surface-2)' }}> → {line.value}</span> : null}
                </li>
              ))}
              {summary.length > 8 ? <li>等 {summary.length} 处</li> : null}
            </ul>
          ) : null}
          {preview.result.warnings.length > 0 ? (
            <p className="field-hint" style={{ marginTop: 10 }}>
              {preview.result.warnings.join(' ')}
            </p>
          ) : null}
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 14, color: 'var(--primary)' }}>
              查看具体内容
            </summary>
            <pre className="diff" aria-label="修改内容">
              {preview.result.diff}
            </pre>
          </details>
          {preview.applyError ? (
            <div className="dialog-error">写入失败：{preview.applyError} 修改仍然保留。</div>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}

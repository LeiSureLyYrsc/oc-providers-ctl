import type { SourceDocument } from '../ipc';
import type { WorkbenchState } from '../lib/store';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

interface ConfigDetailDialogProps {
  open: boolean;
  state: WorkbenchState;
  source: SourceDocument | null;
  onClose: () => void;
  onOpenPath: (path: string) => void;
}

/** Small, plain overview of the current file: problems, read-only reason, paths. */
export function ConfigDetailDialog({
  open,
  state,
  source,
  onClose,
  onOpenPath,
}: ConfigDetailDialogProps) {
  if (!open) return null;

  const sources = state.snapshot?.sources ?? [];

  return (
    <Dialog
      open
      title="配置详情"
      subtitle={state.snapshot?.projectPath ? `项目 ${state.snapshot.projectPath}` : '全局配置'}
      onClose={onClose}
      actions={
        <button type="button" className="btn btn-filled" onClick={onClose}>
          知道了
        </button>
      }
    >
      {sources.length === 0 ? (
        <p className="list-empty">还没有读取到配置文件。</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {sources.map((entry) => {
            const current = entry.path === source?.path;
            const problems = entry.warnings;
            return (
              <li
                key={entry.path}
                style={{
                  padding: '12px 0',
                  borderBottom: '1px solid var(--outline-variant)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="mono" style={{ fontSize: 14, overflowWrap: 'anywhere' }}>
                    {entry.path}
                  </span>
                  {current ? (
                    <span className="chip" data-tone="accent">
                      当前
                    </span>
                  ) : null}
                  {entry.writable ? null : (
                    <span className="chip" data-tone="muted">
                      <Icon name="lock" size={14} />
                      只读
                    </span>
                  )}
                  {problems.length > 0 ? (
                    <span className="chip" data-tone="warn">
                      <Icon name="warning" size={14} />
                      {problems.length} 个问题
                    </span>
                  ) : null}
                  {!current ? (
                    <button
                      type="button"
                      className="text-btn"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => onOpenPath(entry.path)}
                    >
                      切换
                    </button>
                  ) : null}
                </div>
                {!entry.writable ? (
                  <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--on-surface-3)' }}>
                    这个文件当前只能查看：内容结构无法安全识别，或文件本身不允许写入。
                  </p>
                ) : null}
                {problems.length > 0 ? (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 14, color: 'var(--on-surface-2)' }}>
                    {problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                ) : null}
                {entry.defaultModel ? (
                  <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--on-surface-3)' }}>
                    默认模型：<span className="mono">{entry.defaultModel}</span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {state.scanError ? <div className="dialog-error">{state.scanError}</div> : null}
      <p className="field-hint" style={{ marginTop: 12 }}>
        这里只显示配置文件本身的内容，不代表运行时实际状态。
      </p>
    </Dialog>
  );
}

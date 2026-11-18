interface SaveBarProps {
  count: number;
  sourcePath: string;
  onPreview: () => void;
  onDiscard: () => void;
  busy: boolean;
}

export function SaveBar({ count, sourcePath, onPreview, onDiscard, busy }: SaveBarProps) {
  return (
    <div className="savebar" role="region" aria-label="未保存的修改">
      <div className="savebar-text">
        <strong>{count} 项修改待保存</strong>
        <span className="savebar-target" title={sourcePath}>
          {sourcePath}
        </span>
      </div>
      <button type="button" className="btn" onClick={onDiscard} disabled={busy}>
        放弃
      </button>
      <button type="button" className="btn btn-filled" onClick={onPreview} disabled={busy}>
        保存…
      </button>
    </div>
  );
}

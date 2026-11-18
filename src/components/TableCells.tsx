import type { Draft } from '../lib/store';
import { compactValue, formatTokens } from '../lib/format';

interface CellValueProps {
  current: string | number | null;
  draft?: Draft;
  format?: (value: unknown) => string;
  mono?: boolean;
}

const ORIGIN_TITLE: Record<string, string> = {
  manual: '手动草稿',
  suggestion: '目录建议草稿',
  inventory: '清单新建草稿',
};

/** Shows read value and an unapplied draft side by side, with origin-color dot. */
export function CellValue({ current, draft, format, mono }: CellValueProps) {
  const render = format ?? ((value: unknown) => compactValue(value, 40));
  const currentText =
    current === null || current === undefined
      ? '—'
      : typeof current === 'number'
        ? formatTokens(current)
        : current;

  if (!draft) {
    return <span className={mono ? 'mono cell-value' : 'cell-value'}>{currentText}</span>;
  }
  if (draft.op === 'remove') {
    return (
      <span className="cell-value cell-overlay">
        <span className="cell-read">{currentText}</span>
        <span className="cell-draft" data-origin={draft.origin} title={ORIGIN_TITLE[draft.origin]}>
          清除
        </span>
        <i className="draft-dot" data-origin={draft.origin} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="cell-value cell-overlay">
      <span className="cell-read">{currentText}</span>
      <span className="cell-arrow" aria-hidden="true">
        →
      </span>
      <span className="cell-draft" data-origin={draft.origin} title={ORIGIN_TITLE[draft.origin]}>
        {render(draft.value)}
      </span>
      <i className="draft-dot" data-origin={draft.origin} aria-hidden="true" />
    </span>
  );
}

export function DraftCount({ count }: { count: number }) {
  if (count === 0) return <span className="muted tiny">0</span>;
  return <span className="draft-count">{count}</span>;
}

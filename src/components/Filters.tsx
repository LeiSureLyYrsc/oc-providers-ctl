import type { DialectFilter } from '../lib/store';

const OPTIONS: Array<{ value: DialectFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'v1', label: 'V1' },
  { value: 'v2', label: 'V2' },
  { value: 'ambiguous', label: '待定' },
  { value: 'mixed', label: '并存' },
  { value: 'invalid', label: '无效' },
];

export function DialectFilterChips({
  value,
  onChange,
}: {
  value: DialectFilter;
  onChange: (value: DialectFilter) => void;
}) {
  return (
    <div className="filter-chips" role="group" aria-label="按方言筛选">
      {OPTIONS.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? 'chip is-active' : 'chip'}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

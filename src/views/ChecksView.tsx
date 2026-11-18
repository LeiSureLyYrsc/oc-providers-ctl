import { useState } from 'react';
import type { CheckItem, CheckSeverity } from '../lib/checks';
import { DataTable, PaneHeader } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { SeverityBadge } from '../components/Badge';
import { Icon } from '../components/Icon';

type SeverityFilter = 'all' | CheckSeverity;

interface ChecksViewProps {
  checks: CheckItem[];
  query: string;
  onQuery: (value: string) => void;
  selectedCheckId: string | null;
  onSelect: (check: CheckItem) => void;
}

const SEVERITY_OPTIONS: Array<{ value: SeverityFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'error', label: '错误' },
  { value: 'warning', label: '提示' },
  { value: 'info', label: '信息' },
];

export function ChecksView({ checks, query, onQuery, selectedCheckId, onSelect }: ChecksViewProps) {
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const needle = query.trim().toLowerCase();
  const rows = checks.filter((check) => {
    if (severity !== 'all' && check.severity !== severity) return false;
    if (!needle) return true;
    return (
      check.title.toLowerCase().includes(needle) ||
      check.scope.toLowerCase().includes(needle) ||
      check.detail.toLowerCase().includes(needle)
    );
  });

  const columns: Column<CheckItem>[] = [
    {
      key: 'severity',
      label: '级别',
      hint: 'LEVEL',
      width: '74px',
      render: (check) => <SeverityBadge severity={check.severity} />,
    },
    {
      key: 'title',
      label: '检查项',
      hint: 'CHECK',
      render: (check) => <span className="check-table-title">{check.title}</span>,
    },
    {
      key: 'scope',
      label: '范围',
      hint: 'SCOPE',
      mono: true,
      className: 'col-optional',
      render: (check) => <span className="mono muted check-scope">{check.scope}</span>,
    },
    {
      key: 'detail',
      label: '说明',
      hint: 'DETAIL',
      render: (check) => <span className="check-detail-cell">{check.detail}</span>,
    },
  ];

  const counts = {
    error: checks.filter((check) => check.severity === 'error').length,
    warning: checks.filter((check) => check.severity === 'warning').length,
    info: checks.filter((check) => check.severity === 'info').length,
  };

  return (
    <div className="pane">
      <PaneHeader
        title="检查"
        eyebrow="CHECKS / 检查"
        count={rows.length}
        query={query}
        onQuery={onQuery}
        searchPlaceholder="筛选检查项、范围或说明"
      >
        <div className="filter-chips" role="group" aria-label="按级别筛选">
          {SEVERITY_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.value}
              className={severity === option.value ? 'chip is-active' : 'chip'}
              aria-pressed={severity === option.value}
              onClick={() => setSeverity(option.value)}
            >
              {option.label}
              {option.value !== 'all' ? (
                <span className="chip-count">{counts[option.value]}</span>
              ) : null}
            </button>
          ))}
        </div>
      </PaneHeader>
      <div className="check-summary-strip" aria-label="检查计数">
        <span data-tone="danger"><strong>{counts.error}</strong> 错误</span>
        <span data-tone="warn"><strong>{counts.warning}</strong> 提示</span>
        <span data-tone="info"><strong>{counts.info}</strong> 信息</span>
        <span className="muted small">检查只针对配置结构与目录缓存。</span>
      </div>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(check) => check.id}
        selectedKey={selectedCheckId}
        onSelect={onSelect}
        density="comfortable"
        label="检查列表"
        empty={
          <div className="empty-state">
            <Icon name="check" size={22} />
            <h3>没有匹配的检查</h3>
            <p>当前筛选下没有结果。清除搜索或切换级别。</p>
          </div>
        }
      />
    </div>
  );
}

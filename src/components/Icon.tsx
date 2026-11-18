import type { ReactNode } from 'react';

export type IconName =
  | 'scan'
  | 'folder'
  | 'file'
  | 'refresh'
  | 'sun'
  | 'moon'
  | 'rows'
  | 'close'
  | 'plus'
  | 'search'
  | 'lock'
  | 'warning'
  | 'info'
  | 'check'
  | 'trash'
  | 'download'
  | 'keyboard'
  | 'chevron'
  | 'arrow'
  | 'draft'
  | 'spark';

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

const paths: Record<IconName, ReactNode> = {
  scan: (
    <>
      <path d="M2.5 5V3.5A1 1 0 0 1 3.5 2.5H5" />
      <path d="M11 2.5h1.5a1 1 0 0 1 1 1V5" />
      <path d="M13.5 11v1.5a1 1 0 0 1-1 1H11" />
      <path d="M5 13.5H3.5a1 1 0 0 1-1-1V11" />
      <path d="M8 5.5v5M5.5 8h5" />
    </>
  ),
  folder: (
    <>
      <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.4h4.8a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />
    </>
  ),
  file: (
    <>
      <path d="M4 2.5h4.5L11.5 5.5v8H4Z" />
      <path d="M8.5 2.5v3h3" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.7-3.8" />
      <path d="M13 2.8v2.7h-2.7" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
    </>
  ),
  moon: (
    <>
      <path d="M12.7 10.2A5.2 5.2 0 0 1 5.8 3.3a5.2 5.2 0 1 0 6.9 6.9Z" />
    </>
  ),
  rows: (
    <>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </>
  ),
  close: (
    <>
      <path d="M4 4l8 8M12 4l-8 8" />
    </>
  ),
  plus: (
    <>
      <path d="M8 3v10M3 8h10" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2l3.3 3.3" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.5l6 10.5h-12Z" />
      <path d="M8 6v3.2M8 11.3v.2" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4M8 4.8v.2" />
    </>
  ),
  check: (
    <>
      <path d="M3.5 8.5l3 3 6-7" />
    </>
  ),
  trash: (
    <>
      <path d="M3.5 4.5h9M6 4.5V3h4v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2" />
      <path d="M6.5 6.8v3.8M9.5 6.8v3.8" />
    </>
  ),
  download: (
    <>
      <path d="M8 2.5v8M4.8 7.5l3.2 3.2 3.2-3.2M3 13.5h10" />
    </>
  ),
  keyboard: (
    <>
      <rect x="1.8" y="4" width="12.4" height="8" rx="1.2" />
      <path d="M4 7h.2M6.3 7h.2M8.6 7h.2M10.9 7h.2M4 9.5h.2M11 9.5h.2M5.5 9.8h5" />
    </>
  ),
  chevron: (
    <>
      <path d="M6 3.5l4.5 4.5L6 12.5" />
    </>
  ),
  arrow: (
    <>
      <path d="M3 8h9.5M9.5 4.5L13 8l-3.5 3.5" />
    </>
  ),
  draft: (
    <>
      <path d="M3 12.5l.7-3.1L10.9 2.3l2.8 2.8-7.2 7.2Z" />
      <path d="M3 13h10" />
    </>
  ),
  spark: (
    <>
      <path d="M8 2.5l1.5 4 4 1.5-4 1.5L8 13.5l-1.5-4-4-1.5 4-1.5Z" />
    </>
  ),
};

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

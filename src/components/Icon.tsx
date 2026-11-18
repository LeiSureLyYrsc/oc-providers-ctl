import type { ReactNode } from 'react';

export type IconName =
  | 'search'
  | 'add'
  | 'refresh'
  | 'more'
  | 'close'
  | 'chevron'
  | 'check'
  | 'warning'
  | 'edit'
  | 'trash'
  | 'download'
  | 'sun'
  | 'moon'
  | 'file'
  | 'arrow'
  | 'lock';

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

const paths: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5.8" />
      <path d="M14.8 14.8l3.6 3.6" />
    </>
  ),
  add: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.6-5.7" />
      <path d="M19.5 4v4h-4" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="5.5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="18.5" r="1.6" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M9 5l7 7-7 7" />,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  warning: (
    <>
      <path d="M12 3.8l9 15.4H3z" />
      <path d="M12 9.5v4.2M12 16.6v.2" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20l1-4.2L16.4 4.4a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19z" />
      <path d="M4 20h5" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10M7.5 10l4.5 4.5L16.5 10M4.5 20h15" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.3 8.3 0 0 1 9.5 4a8.3 8.3 0 1 0 10.5 10.5z" />,
  file: (
    <>
      <path d="M6 3h7.5L18 7.5V21H6z" />
      <path d="M13.5 3v4.5H18" />
    </>
  ),
  arrow: <path d="M4 12h15M14 7l5 5-5 5" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
};

export function Icon({ name, size = 20, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

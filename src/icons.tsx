// 界面图标：全部手写内联 SVG（24 视框 / 1.8 描边 / currentColor）。
// 约定：状态与动作只用这些图形，不用 emoji 当图标 —— emoji 在不同字体下宽度与颜色都不受控。
import type { JSX } from 'react'

export type IconName =
  | 'check'
  | 'cross'
  | 'clock'
  | 'dash'
  | 'folder'
  | 'play'
  | 'pause'
  | 'plus'
  | 'trash'
  | 'up'
  | 'down'
  | 'retry'
  | 'save'
  | 'export'
  | 'import'
  | 'chevron'
  | 'chevronDown'
  | 'warning'
  | 'info'
  | 'cpu'
  | 'gpu'
  | 'history'
  | 'film'
  | 'grip'

const PATHS: Record<IconName, JSX.Element> = {
  check: <path d="M4 12.5l5 5L20 6.5" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.5V12l3.2 2" />
    </>
  ),
  dash: <path d="M5 12h14" />,
  folder: (
    <>
      <path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2.4h7A1.5 1.5 0 0121 10v7.5A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5z" />
    </>
  ),
  play: <path d="M8 5.5l10 6.5-10 6.5z" />,
  pause: (
    <>
      <path d="M9 5v14M15 5v14" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4.8h6V7M6.5 7l1 12.5h9l1-12.5" />
    </>
  ),
  up: <path d="M12 19V6.5M6 11.5L12 5.5l6 6" />,
  down: <path d="M12 5v12.5M6 12.5l6 6 6-6" />,
  retry: (
    <>
      <path d="M20 12a8 8 0 11-2.6-5.9" />
      <path d="M20 4v4.2h-4.2" />
    </>
  ),
  save: (
    <>
      <path d="M5 5h11l3 3v11H5z" />
      <path d="M8.5 5v5h6V5M8.5 19v-5h7v5" />
    </>
  ),
  export: (
    <>
      <path d="M12 16V4.5M7.5 9L12 4.5 16.5 9" />
      <path d="M4.5 15v4.5h15V15" />
    </>
  ),
  import: (
    <>
      <path d="M12 4.5V16M7.5 11.5L12 16l4.5-4.5" />
      <path d="M4.5 15v4.5h15V15" />
    </>
  ),
  chevron: <path d="M8.5 5l7 7-7 7" />,
  chevronDown: <path d="M5 9l7 7 7-7" />,
  warning: (
    <>
      <path d="M12 4l8.5 15H3.5z" />
      <path d="M12 9.5v4M12 16h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 10.5v5M12 7.6h.01" />
    </>
  ),
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3" />
    </>
  ),
  gpu: (
    <>
      <rect x="3" y="7" width="18" height="11" rx="2" />
      <path d="M7 11h4M7 14h2" />
      <circle cx="16" cy="12.5" r="2.2" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 108-8 8 8 0 00-6.3 3.1" />
      <path d="M4 4.5V8h3.5" />
      <path d="M12 8.5V12l2.8 1.8" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 10h18M8 5.5v13M16 5.5v13" />
    </>
  ),
  grip: (
    <>
      <circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none" />
    </>
  )
}

export function Icon(props: { name: IconName; size?: number; className?: string }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg
      className={'icon' + (props.className ? ' ' + props.className : '')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      {PATHS[props.name]}
    </svg>
  )
}

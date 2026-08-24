import type { ReactNode } from 'react';

export const ICON_NAMES = ['chevron-down', 'check', 'x', 'circle', 'loader', 'alert'] as const;

export type IconName = (typeof ICON_NAMES)[number];

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

const SYMBOLS: Record<IconName, ReactNode> = {
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="10" />,
  loader: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  alert: (
    <>
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
};

/** Hidden sprite. Mount once so every <Icon> can reference a symbol by name. */
export function IconSprite() {
  return (
    <svg
      id="oe-icon-sprite"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_NAMES.map((name) => (
        <symbol
          key={name}
          id={`oe-icon-${name}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {SYMBOLS[name]}
        </symbol>
      ))}
    </svg>
  );
}

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className ? `oe-icon ${className}` : 'oe-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#oe-icon-${name}`} />
    </svg>
  );
}

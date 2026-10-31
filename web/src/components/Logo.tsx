// The mark: a sun and a raindrop, the two ways a weather market can go.

import { useId } from "react";

export const DROP = "M21 8.5C21 8.5 28.5 16.4 28.5 21.2A7.5 7.5 0 0 1 13.5 21.2C13.5 16.4 21 8.5 21 8.5Z";

export function Logo({ size = 30 }: { size?: number }) {
  const id = useId().replace(/[^\w-]/g, "");
  return (
    <svg className="logo" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-rain`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7cc4ff" />
          <stop offset="1" stopColor="#2f73ff" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="8" className="logo-sun" />
      <path d={DROP} className="logo-gap" />
      <path d={DROP} fill={`url(#${id}-rain)`} />
    </svg>
  );
}

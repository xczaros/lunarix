import { useId } from 'react';

/** Lunarix mark: a crescent moon holding a text caret. Monochrome, inherits currentColor. */
export function LogoMark({ size = 20, className, style }: { size?: number; className?: string; style?: React.CSSProperties }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <mask id={`m${id}`}>
          <rect width="24" height="24" fill="#fff" />
          <circle cx="16.9" cy="7.66" r="8.96" fill="#000" />
        </mask>
      </defs>
      <circle cx="12" cy="12" r="10.5" fill="currentColor" mask={`url(#m${id})`} />
      <rect x="15.78" y="5.28" width="2.1" height="10.92" rx="1.05" fill="currentColor" />
    </svg>
  );
}

/** Full app tile (black tile, shaded crescent, white caret) — used for hero / about. */
export function LogoTile({ size = 64, className, animated = false }: { size?: number; className?: string; animated?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id={`bg${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d1d1d" />
          <stop offset="1" stopColor="#050505" />
        </linearGradient>
        <linearGradient id={`mo${id}`} x1="0.1" y1="0.05" x2="0.85" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.55" stopColor="#d4d4d4" />
          <stop offset="1" stopColor="#6f6f6f" />
        </linearGradient>
        <radialGradient id={`gl${id}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <mask id={`cut${id}`}>
          <rect width="512" height="512" fill="#fff" />
          <circle cx="322" cy="204" r="128" fill="#000" />
        </mask>
      </defs>
      <rect x="8" y="8" width="496" height="496" rx="116" fill={`url(#bg${id})`} />
      <rect x="8.5" y="8.5" width="495" height="495" rx="115.5" fill="none" stroke="#ffffff" strokeOpacity="0.1" />
      <circle cx="256" cy="256" r="210" fill={`url(#gl${id})`} />
      <circle cx="252" cy="266" r="150" fill={`url(#mo${id})`} mask={`url(#cut${id})`} />
      <rect x="306" y="170" width="30" height="156" rx="15" fill="#ffffff" className={animated ? 'caret-anim' : undefined} />
    </svg>
  );
}

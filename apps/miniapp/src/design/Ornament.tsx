// SVG-мотивы косівської кераміки: «Косівська хвиля» под шапкой, оберег-вазон, розетка героя, иконки.
// Декор: aria-hidden, цвета — токены сезона.
import type { ReactNode } from "react";

const WAVE_DOTS = [25, 75, 125, 175, 225, 275, 325, 375];

/** «Косівська хвиля» (14px): волна accent-2 и точки accent. */
export function KosivWave({ className = "kosiv-wave" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 14"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M0 7 Q 12 1, 25 7 T 50 7 T 75 7 T 100 7 T 125 7 T 150 7 T 175 7 T 200 7 T 225 7 T 250 7 T 275 7 T 300 7 T 325 7 T 350 7 T 375 7 T 400 7"
        fill="none"
        stroke="var(--app-accent-2)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      {WAVE_DOTS.map((cx) => (
        <circle key={cx} cx={cx} cy="7" r="2.5" fill="var(--app-accent)" />
      ))}
    </svg>
  );
}

/** Оберег «Керамічний вазон / смерека». */
export function VaseIcon({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--app-accent)"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3c-3 4-6 6-6 11a6 6 0 0012 0c0-5-3-7-6-11z" fill="var(--app-accent)" fillOpacity="0.18" />
      <path d="M12 8v9M9 12l3-2 3 2" stroke="var(--app-accent-2)" strokeLinecap="round" />
    </svg>
  );
}

/** Розетка как на косівській тарілці: декор угла героя. */
export function Rosette({ className }: { className?: string }) {
  const petals = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg className={className} viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <circle cx="100" cy="100" r="92" fill="none" stroke="var(--app-accent-2)" strokeWidth="3" />
      <circle
        cx="100"
        cy="100"
        r="80"
        fill="none"
        stroke="var(--app-accent)"
        strokeWidth="1.5"
        strokeDasharray="2 7"
      />
      {petals.map((deg) => (
        <path
          key={deg}
          d="M100 100 C 88 78, 92 48, 100 34 C 108 48, 112 78, 100 100 Z"
          transform={`rotate(${deg} 100 100)`}
          fill={deg % 60 === 0 ? "var(--app-accent)" : "var(--app-accent-2)"}
          fillOpacity="0.55"
        />
      ))}
      <circle cx="100" cy="100" r="14" fill="var(--app-surface)" stroke="var(--app-accent)" strokeWidth="3" />
    </svg>
  );
}

function Icon({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <svg
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
      {children}
    </svg>
  );
}

/** Линейные иконки разделов и навигации (currentColor). */
export const ICONS = {
  home: (
    <Icon>
      <path d="M4 11l8-7 8 7v8a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1z" />
    </Icon>
  ),
  plan: (
    <Icon>
      <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z" />
      <path d="M9 4v14M15 6v14" />
    </Icon>
  ),
  heart: (
    <Icon>
      <path d="M12 20s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.5-7 10-7 10z" />
    </Icon>
  ),
  sos: (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M6 6l3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5" />
    </Icon>
  ),
  user: (
    <Icon>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0114 0" />
    </Icon>
  ),
  about: (
    <Icon>
      <path d="M4 20V9l8-5 8 5v11z" />
      <path d="M10 20v-5h4v5" />
    </Icon>
  ),
  eat: (
    <Icon>
      <path d="M7 3v8M5 3v5a2 2 0 004 0V3M7 11v10" />
      <path d="M17 21V3c-2 1-3 4-3 7h3" />
    </Icon>
  ),
  shop: (
    <Icon>
      <path d="M5 8h14l-1 12H6z" />
      <path d="M9 8a3 3 0 016 0" />
    </Icon>
  ),
  relax: (
    <Icon>
      <path d="M3 18h18M5 18V9l7-5 7 5v9" />
      <path d="M9 18v-4h6v4" />
    </Icon>
  ),
  fun: (
    <Icon>
      <path d="M3 20l6-12 4 7 3-4 5 9z" />
      <circle cx="17" cy="6" r="2" />
    </Icon>
  ),
  nearby: (
    <Icon>
      <path d="M12 21s-6-5.3-6-11a6 6 0 0112 0c0 5.7-6 11-6 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </Icon>
  ),
  transfer: (
    <Icon>
      <path d="M5 16V8a3 3 0 013-3h8a3 3 0 013 3v8z" />
      <path d="M5 12h14M8 19v-3M16 19v-3" />
      <circle cx="8.5" cy="14" r=".6" />
      <circle cx="15.5" cy="14" r=".6" />
    </Icon>
  ),
  help: (
    <Icon>
      <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
      <path d="M12 8v5M12 16v.5" />
    </Icon>
  ),
  settings: (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </Icon>
  ),
  locate: (
    <Icon>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Icon>
  ),
  search: (
    <Icon>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Icon>
  ),
  arrow: (
    <Icon size={18}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  ),
} as const;

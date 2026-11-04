// Общий фон приложения: статичная картинка гор на весь экран и искры ватры. Один слой в оболочке (Shell): монтируется
// один раз, при переходах не пересоздаётся; скроллятся только блоки поверх него. «Ніч» — Концепт Б «Мольфарська Ватра»,
// «День» — рассвет Концепта А (светлое небо, туман). Какая из картинок видна — решает CSS по data-theme (до первого
// кадра, season-boot.js). Передний хребет продолжается до низа экрана градиентом от своего цвета (modern.css), без шва.
// Искры — только CSS: transform и opacity, без обновлений React; при «уменьшить движение» стоят, в скрытой вкладке и под
// листами на весь экран — на паузе (modern.css).
import { memo, useEffect, useRef, type CSSProperties } from "react";
import { useTheme } from "./ThemeProvider.js";

/** Смереки переднего хребта рассвета: x, основание y, масштаб. */
const SPRUCES: readonly (readonly [number, number, number])[] = [
  [14, 214, 1],
  [34, 208, 1.3],
  [58, 200, 0.9],
  [86, 195, 1.15],
  [118, 196, 0.85],
  [262, 220, 0.9],
  [292, 216, 1.2],
  [318, 210, 1],
  [346, 202, 1.35],
  [374, 195, 1.05],
  [394, 192, 0.8],
];
const SPRUCE =
  "M0 0 L-8 0 L-3.5 -7 L-6.5 -7 L-2.5 -14 L-4.5 -14 L0 -23 L4.5 -14 L2.5 -14 L6.5 -7 L3.5 -7 L8 0 Z";
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * Искры: от низа экрана (там отсвет костра) и из долины за хребтом — так они видны и в окне над карточками.
 * left %, старт снизу vh, размер px, длительность с, задержка с, покачивание px, снос px, подъём vh.
 */
const EMBERS: readonly (readonly [number, number, number, number, number, number, number, number])[] = [
  [8, 0, 3, 11, 0, 10, 14, 88],
  [18, 2, 2, 13, 3.4, -12, 20, 72],
  [27, -2, 4, 10, 6.1, 14, -10, 92],
  [36, 1, 2, 14, 1.2, -9, 24, 66],
  [44, -1, 3, 9.5, 4.7, 11, -18, 84],
  [50, 0, 4, 12, 8.3, -14, 12, 96],
  [56, 2, 2, 10.5, 2.3, 9, -22, 74],
  [63, -2, 3, 13.5, 5.6, -11, 16, 90],
  [72, 1, 2, 11.5, 9.2, 13, -14, 70],
  [81, 0, 4, 10, 0.8, -10, -20, 86],
  [91, 2, 3, 14.5, 6.9, 12, -12, 78],
  [14, 56, 2, 7, 1.6, 7, 12, 30],
  [24, 60, 3, 8, 4.2, -8, -8, 34],
  [33, 54, 2, 6.5, 0.4, 6, 16, 28],
  [42, 58, 3, 7.5, 3.1, -7, 10, 36],
  [49, 62, 2, 8.5, 5.5, 8, -12, 32],
  [54, 55, 4, 7, 2.2, -6, 14, 38],
  [61, 60, 2, 6, 6.3, 7, -10, 30],
  [69, 57, 3, 8, 0.9, -8, 12, 34],
  [78, 61, 2, 7.5, 4.8, 6, -14, 28],
  [87, 56, 3, 6.5, 2.9, -7, -6, 32],
  [96, 59, 2, 8, 7.1, 6, -16, 26],
];

function emberStyle([left, from, size, duration, delay, sway, drift, rise]: (typeof EMBERS)[number]) {
  return {
    left: `${left}%`,
    bottom: `${from}vh`,
    width: size,
    height: size,
    // Отрицательная задержка: с первого кадра искры уже на разных высотах.
    animationDuration: `${duration}s`,
    animationDelay: `${-delay}s`,
    "--sway": `${sway}px`,
    "--drift": `${drift}px`,
    "--rise": `${rise}vh`,
  } as CSSProperties;
}

export const AppBackdrop = memo(function AppBackdrop() {
  // Искры ватры — символ «Ніч»; в «День» их нет.
  const { theme } = useTheme();
  // Скрытая вкладка (свёрнутый Telegram): искры на паузе. Атрибут — напрямую, без обновления React.
  const embers = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => {
      const hidden = document.visibilityState === "hidden";
      embers.current?.toggleAttribute("data-paused", hidden);
      // Тот же признак ставит на паузу живой огонёк и волны микрофона (modern.css).
      document.documentElement.toggleAttribute("data-tab-hidden", hidden);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      document.documentElement.removeAttribute("data-tab-hidden");
    };
  }, []);
  return (
    <div className="app-backdrop" data-testid="app-backdrop" aria-hidden="true">
      <svg
        className="app-backdrop-art app-backdrop-night"
        viewBox="0 0 400 400"
        preserveAspectRatio="none"
        focusable="false"
      >
        <defs>
          <radialGradient id="app-fire-glow" cx="50%" cy="68%" r="55%">
            <stop offset="0%" stopColor="#F26419" stopOpacity="0.45" />
            <stop offset="60%" stopColor="#F6AE2D" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#071510" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* Созвездие-оберег в небе */}
        <g transform="translate(-50 85)" stroke="#F6AE2D" strokeWidth="0.7" opacity="0.45" fill="#F6AE2D">
          <circle cx="80" cy="45" r="1.5" />
          <circle cx="110" cy="30" r="2" />
          <circle cx="140" cy="45" r="1.5" />
          <circle cx="110" cy="60" r="1.5" />
          <path d="M80 45 L110 30 L140 45 L110 60 Z" fill="none" />
          <circle cx="290" cy="38" r="1.8" />
          <circle cx="325" cy="52" r="1.2" />
          <circle cx="250" cy="65" r="1.4" />
        </g>
        <rect y="78" width="400" height="300" fill="url(#app-fire-glow)" />
        <g transform="translate(0 78)">
          {/* Дальние хребты Черногоры и золотой контур от света ватры */}
          <path
            d="M0 165 L65 105 L130 145 L210 72 L285 135 L345 92 L400 130 L400 322 L0 322 Z"
            fill="#17402F"
            opacity="0.95"
          />
          <path
            d="M0 165 L65 105 L130 145 L210 72 L285 135 L345 92 L400 130"
            fill="none"
            stroke="#F6AE2D"
            strokeWidth="1.2"
            opacity="0.55"
          />
          {/* Передний хребет: ниже продолжается фоном слоя того же цвета */}
          <path
            d="M0 210 L45 165 L95 198 L165 148 L240 195 L315 152 L400 190 L400 322 L0 322 Z"
            fill="#0B1F17"
          />
        </g>
      </svg>

      <svg
        className="app-backdrop-art app-backdrop-day"
        viewBox="0 0 400 400"
        preserveAspectRatio="none"
        focusable="false"
      >
        <g transform="translate(0 90)">
          <path
            d="M0 150 L55 95 L110 130 L185 58 L255 118 L325 72 L400 125 L400 310 L0 310 Z"
            fill="#7FA99B"
            opacity="0.45"
          />
          <path d="M185 58 L215 92 L192 98 L175 78 Z" fill="#FFFDF9" opacity="0.55" />
          <path d="M325 72 L350 98 L330 102 L316 86 Z" fill="#FFFDF9" opacity="0.45" />
          <ellipse cx="140" cy="135" rx="110" ry="16" fill="#FFFFFF" opacity="0.55" />
          <ellipse cx="310" cy="125" rx="95" ry="14" fill="#FFFFFF" opacity="0.45" />
          <path
            d="M0 175 L75 122 L145 168 L230 105 L310 158 L370 120 L400 145 L400 310 L0 310 Z"
            fill="#3B6E5C"
            opacity="0.78"
          />
          <ellipse cx="220" cy="175" rx="135" ry="18" fill="#F4F9F6" opacity="0.5" />
          {/* Передний хребет: ниже продолжается фоном слоя того же цвета */}
          <path d="M0 215 Q 90 170, 180 205 T 400 190 L400 310 L0 310 Z" fill="#1E4635" />
          <g fill="#122B20">
            {SPRUCES.map(([x, y, s]) => (
              <path key={x} d={SPRUCE} transform={`translate(${x} ${y + 2}) scale(${s})`} />
            ))}
          </g>
        </g>
      </svg>
      <svg className="app-backdrop-rose" viewBox="0 0 100 100" focusable="false">
        <circle cx="50" cy="50" r="30" fill="#F59E0B" fillOpacity="0.2" />
        <circle cx="50" cy="50" r="18" fill="#EA580C" fillOpacity="0.28" />
        {RAYS.map((deg) => (
          <path
            key={deg}
            d="M50 4 L56 40 L50 50 L44 40 Z"
            transform={`rotate(${deg} 50 50)`}
            fill={deg % 90 === 0 ? "#F6AE2D" : "#FDE68A"}
          />
        ))}
        <circle cx="50" cy="50" r="6" fill="#FDE68A" stroke="#B83D18" strokeWidth="1.5" />
      </svg>

      {theme === "night" && (
        <div ref={embers} className="app-embers" data-testid="app-embers">
          {EMBERS.map((e, i) => (
            <i key={i} style={emberStyle(e)} />
          ))}
        </div>
      )}
    </div>
  );
});

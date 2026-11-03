// Панорама героя главной (Концепт А + Б): дальний хребет Чорногоры с освещёнными гранями, полосы тумана, средний
// хребет Горган, ближний лес смерек, золотая 8-лучевая «Рожа» и (в «Ніч») созвездие-оберег. Цвета — CSS-переменные темы.

/** Смереки ближнего хребта: x, основание y, масштаб. */
const SPRUCES: readonly (readonly [number, number, number])[] = [
  [14, 218, 1],
  [34, 212, 1.3],
  [58, 206, 0.9],
  [86, 198, 1.15],
  [118, 196, 0.85],
  [262, 214, 0.9],
  [292, 208, 1.2],
  [318, 200, 1],
  [346, 196, 1.35],
  [374, 194, 1.05],
  [394, 192, 0.8],
];
const SPRUCE =
  "M0 0 L-8 0 L-3.5 -7 L-6.5 -7 L-2.5 -14 L-4.5 -14 L0 -23 L4.5 -14 L2.5 -14 L6.5 -7 L3.5 -7 L8 0 Z";
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

export function HeroPanorama() {
  return (
    <>
      <svg
        className="modern-hero-art"
        viewBox="0 0 400 320"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <g className="modern-hero-stars">
          <circle cx="238" cy="92" r="1.5" />
          <circle cx="262" cy="80" r="2" />
          <circle cx="286" cy="92" r="1.5" />
          <circle cx="262" cy="104" r="1.5" />
          <path d="M238 92 L262 80 L286 92 L262 104 Z" fill="none" />
          <circle cx="345" cy="70" r="1.4" />
          <circle cx="20" cy="84" r="1.2" />
        </g>
        <g transform="translate(0 14)">
          <path
            className="modern-hero-far"
            d="M0 150 L55 95 L110 130 L185 58 L255 118 L325 72 L400 125 L400 320 L0 320 Z"
          />
          <path
            className="modern-hero-edge"
            d="M0 150 L55 95 L110 130 L185 58 L255 118 L325 72 L400 125"
            fill="none"
          />
          <path className="modern-hero-lit" d="M185 58 L215 92 L192 98 L175 78 Z" />
          <path className="modern-hero-lit" d="M325 72 L350 98 L330 102 L316 86 Z" />
          <path className="modern-hero-lit" d="M55 95 L72 110 L58 114 L46 104 Z" />
          <g className="modern-hero-mist">
            <ellipse cx="140" cy="135" rx="110" ry="16" />
            <ellipse cx="310" cy="125" rx="95" ry="14" />
          </g>
          {/* Ближние планы подняты над прототипом: иначе их целиком закрыла бы стеклянная карточка поля. */}
          <g transform="translate(0 -14)">
            <path
              className="modern-hero-mid"
              d="M0 175 L75 122 L145 168 L230 105 L310 158 L370 120 L400 145 L400 320 L0 320 Z"
            />
          </g>
          <g transform="translate(0 -40)">
            <g className="modern-hero-mist modern-hero-mist-slow">
              <ellipse cx="220" cy="175" rx="135" ry="18" />
            </g>
            <path className="modern-hero-near" d="M0 215 Q 90 170, 180 205 T 400 190 L400 360 L0 360 Z" />
            <g className="modern-hero-trees">
              {SPRUCES.map(([x, y, s]) => (
                <path key={x} d={SPRUCE} transform={`translate(${x} ${y}) scale(${s})`} />
              ))}
            </g>
          </g>
        </g>
      </svg>
      <svg className="modern-hero-rose" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle cx="50" cy="50" r="30" fill="#F59E0B" fillOpacity="0.16" />
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
    </>
  );
}

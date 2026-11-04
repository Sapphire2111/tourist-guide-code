// Повноекранна жива панорама Карпат на фоні головної сторінки (Концепт А «Живий Горизонт Чорногори» + Концепт Б «Мольфарська Ватра»):
// 4 яруси гірських хребтів від неба до низу екрана, живий рухомий туман у долинах, золоте Гуцульське Сонце-Рожа,
// тепле заграва ватри за вершинами та іскри живого вогню, що підіймаються вгору.

/** Смереки ближнього хребта: x, основа y, масштаб. */
const SPRUCES: readonly (readonly [number, number, number])[] = [
  [14, 244, 1.15],
  [34, 238, 1.45],
  [58, 232, 1.0],
  [86, 224, 1.25],
  [118, 226, 0.95],
  [146, 234, 0.85],
  [254, 236, 0.95],
  [284, 228, 1.3],
  [314, 220, 1.1],
  [344, 214, 1.5],
  [372, 216, 1.2],
  [392, 218, 0.95],
];
const SPRUCE =
  "M0 0 L-8 0 L-3.5 -7 L-6.5 -7 L-2.5 -14 L-4.5 -14 L0 -23 L4.5 -14 L2.5 -14 L6.5 -7 L3.5 -7 L8 0 Z";
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

export function HeroPanorama() {
  return (
    <div className="modern-hero-backdrop" aria-hidden="true">
      <svg
        className="modern-hero-art"
        viewBox="0 0 400 720"
        preserveAspectRatio="xMidYMin slice"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id="vatraGlow" cx="50%" cy="32%" r="56%">
            <stop offset="0%" stopColor="#F26419" stopOpacity="0.46" />
            <stop offset="48%" stopColor="#F6AE2D" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#071510" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="mistGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--hero-mist)" stopOpacity="0.15" />
            <stop offset="50%" stopColor="var(--hero-mist)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--hero-mist)" stopOpacity="0.15" />
          </linearGradient>
        </defs>

        {/* Тепле заграва мольфарської ватри за хребтами Чорногори */}
        <rect className="modern-hero-glow" x="0" y="0" width="400" height="460" fill="url(#vatraGlow)" />

        {/* Геометричне сузір'я-оберіг у небі над вершинами */}
        <g className="modern-hero-stars">
          <circle cx="76" cy="54" r="1.6" />
          <circle cx="104" cy="40" r="2.1" />
          <circle cx="132" cy="54" r="1.6" />
          <circle cx="104" cy="68" r="1.6" />
          <path d="M76 54 L104 40 L132 54 L104 68 Z" fill="none" />
          <circle cx="238" cy="76" r="1.5" />
          <circle cx="262" cy="64" r="2" />
          <circle cx="286" cy="76" r="1.5" />
          <circle cx="262" cy="88" r="1.5" />
          <path d="M238 76 L262 64 L286 76 L262 88 Z" fill="none" />
          <circle cx="342" cy="52" r="1.4" />
          <circle cx="32" cy="72" r="1.3" />
        </g>

        {/* Ярус 1: Дальній хребет Чорногори (Говерла та Петрос) */}
        <path
          className="modern-hero-far"
          d="M-20 175 L52 108 L112 146 L188 68 L258 134 L328 84 L420 142 L420 720 L-20 720 Z"
        />
        <path
          className="modern-hero-edge"
          d="M-20 175 L52 108 L112 146 L188 68 L258 134 L328 84 L420 142"
          fill="none"
        />
        {/* Сонячні / сніжні грані на вершинах */}
        <path className="modern-hero-lit" d="M188 68 L224 108 L196 116 L176 92 Z" />
        <path className="modern-hero-lit" d="M328 84 L358 114 L334 120 L316 100 Z" />
        <path className="modern-hero-lit" d="M52 108 L74 126 L56 132 L42 120 Z" />

        {/* Жива смуга ранкового туману 1 */}
        <g className="modern-hero-mist">
          <ellipse cx="125" cy="152" rx="135" ry="18" fill="url(#mistGrad)" />
          <ellipse cx="305" cy="138" rx="115" ry="15" fill="url(#mistGrad)" />
        </g>

        {/* Ярус 2: Середній хребет Горган (Хом'як і Синяк) */}
        <path
          className="modern-hero-mid"
          d="M-20 206 L74 142 L146 192 L234 122 L312 180 L372 138 L420 168 L420 720 L-20 720 Z"
        />
        <path className="modern-hero-lit" d="M234 122 L266 154 L242 160 L224 140 Z" />
        <path className="modern-hero-lit" d="M74 142 L98 164 L80 168 L64 154 Z" />

        {/* Жива смуга туману 2 (повільний зустрічний рух) */}
        <g className="modern-hero-mist modern-hero-mist-slow">
          <ellipse cx="215" cy="204" rx="165" ry="22" fill="url(#mistGrad)" />
          <ellipse cx="70" cy="216" rx="110" ry="16" fill="url(#mistGrad)" />
        </g>

        {/* Ярус 3: Ближній смерековий хребет */}
        <path className="modern-hero-near" d="M-20 246 Q 88 196, 184 234 T 420 212 L420 720 L-20 720 Z" />
        <g className="modern-hero-trees">
          {SPRUCES.map(([x, y, s]) => (
            <path key={x} d={SPRUCE} transform={`translate(${x} ${y}) scale(${s})`} />
          ))}
        </g>

        {/* Жива смуга туману 3 (середня долина під пошуком) */}
        <g className="modern-hero-mist">
          <ellipse cx="185" cy="310" rx="185" ry="24" fill="url(#mistGrad)" />
          <ellipse cx="330" cy="335" rx="130" ry="18" fill="url(#mistGrad)" />
        </g>

        {/* Ярус 4: Гірський хребет полонини за картками Bento */}
        <path
          className="modern-hero-mid"
          d="M-20 420 L65 348 L150 398 L248 326 L332 386 L420 338 L420 720 L-20 720 Z"
        />
        <path
          className="modern-hero-edge"
          d="M-20 420 L65 348 L150 398 L248 326 L332 386 L420 338"
          fill="none"
        />
        <path className="modern-hero-lit" d="M248 326 L282 362 L254 368 L236 346 Z" />
        <path className="modern-hero-lit" d="M65 348 L92 374 L70 380 L54 364 Z" />

        {/* Жива смуга туману 4 (нижня долина між плитками розділів) */}
        <g className="modern-hero-mist modern-hero-mist-slow">
          <ellipse cx="140" cy="465" rx="175" ry="24" fill="url(#mistGrad)" />
          <ellipse cx="310" cy="490" rx="150" ry="20" fill="url(#mistGrad)" />
        </g>

        {/* Ярус 5: Нижні схили смерекового пралісу до низу екрана */}
        <path className="modern-hero-valley" d="M-20 535 Q 95 482, 210 524 T 420 495 L420 720 L-20 720 Z" />
      </svg>

      {/* Золоте 8-променеве Гуцульське Сонце-Рожа (оберіг) */}
      <svg className="modern-hero-rose" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle cx="50" cy="50" r="34" fill="#F59E0B" fillOpacity="0.2" />
        <circle cx="50" cy="50" r="21" fill="#EA580C" fillOpacity="0.32" />
        {RAYS.map((deg) => (
          <path
            key={deg}
            d="M50 4 L56 40 L50 50 L44 40 Z"
            transform={`rotate(${deg} 50 50)`}
            fill={deg % 90 === 0 ? "#F6AE2D" : "#FDE68A"}
          />
        ))}
        <circle cx="50" cy="50" r="6.5" fill="#FDE68A" stroke="#B83D18" strokeWidth="1.5" />
      </svg>

      {/* Живі іскри мольфарської ватри, що підіймаються з-за гір */}
      <div className="modern-hero-embers">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

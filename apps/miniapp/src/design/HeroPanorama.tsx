// Статичний повноекранний фон «Мольфарська Ватра & Нічні Карпати» (Концепт Б):
// геометричне сузір'я Гуцульської Зірки в небі, тепле заграва ватри за вершинами Чорногори,
// смарагдові хребти з тонким золотим контуром і ближній смерековий ліс. Фон зафіксовано (position: fixed),
// а всі написи й картки плавно рухаються поверх нього під час прокрутки.

export function HeroPanorama() {
  return (
    <div className="modern-hero-backdrop" aria-hidden="true">
      <svg
        className="modern-hero-art"
        viewBox="0 0 400 360"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id="fireGlow" cx="50%" cy="68%" r="55%">
            <stop offset="0%" stopColor="#F26419" stopOpacity="0.45" />
            <stop offset="60%" stopColor="#F6AE2D" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#071510" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Геометричне сузір'я-оберіг у небі */}
        <g stroke="#F6AE2D" strokeWidth="0.7" opacity="0.45" fill="#F6AE2D">
          <circle cx="80" cy="45" r="1.5" />
          <circle cx="110" cy="30" r="2" />
          <circle cx="140" cy="45" r="1.5" />
          <circle cx="110" cy="60" r="1.5" />
          <line x1="80" y1="45" x2="110" y2="30" />
          <line x1="110" y1="30" x2="140" y2="45" />
          <line x1="140" y1="45" x2="110" y2="60" />
          <line x1="110" y1="60" x2="80" y2="45" />
          <circle cx="290" cy="38" r="1.8" />
          <circle cx="325" cy="52" r="1.2" />
          <circle cx="250" cy="65" r="1.4" />
        </g>

        {/* Тепле заграва за горами */}
        <rect width="400" height="300" fill="url(#fireGlow)" />

        {/* Дальні нічні хребти Чорногори */}
        <path
          d="M0 165 L65 105 L130 145 L210 72 L285 135 L345 92 L400 130 L400 360 L0 360 Z"
          fill="#17402F"
          opacity="0.95"
        />
        {/* Золотий контур хребта від світла ватри */}
        <path
          d="M0 165 L65 105 L130 145 L210 72 L285 135 L345 92 L400 130"
          fill="none"
          stroke="#F6AE2D"
          strokeWidth="1.4"
          opacity="0.75"
        />

        {/* Ближній смерековий ліс */}
        <path
          d="M0 210 L45 165 L95 198 L165 148 L240 195 L315 152 L400 190 L400 360 L0 360 Z"
          fill="#0B1F17"
        />

        {/* Статичні золоті іскри ватри над схилами */}
        <circle cx="134" cy="212" r="2.2" fill="#F6AE2D" opacity="0.7" />
        <circle cx="202" cy="196" r="2" fill="#F6AE2D" opacity="0.65" />
        <circle cx="268" cy="224" r="1.6" fill="#F26419" opacity="0.75" />
      </svg>
    </div>
  );
}

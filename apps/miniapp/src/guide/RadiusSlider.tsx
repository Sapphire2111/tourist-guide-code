// Радиус поиска «Лінійка-барабан»: компактная капсула с горизонтальной лентой значений (деления и подписи),
// лента листается свайпом и защёлкивается (scroll-snap), выбранное значение — в неподвижной рамке по центру.
// Шаги неравномерные — мелкие вблизи, крупные вдали. Каталог добавляет последний шаг «Усі місця» (allowAll);
// поверх карты («Поруч») — стеклянная капсула (overlay), иначе — та же лента на поверхности.
// Доступность: для клавиатуры и читалок — скрытый нативный ползунок (стрелки, Home/End, aria-valuetext «2 км»);
// сама лента для читалок скрыта (дублировала бы его).
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useT } from "@tg/ui";
import { useGuide } from "./context.js";
import { useRadiusLabel } from "./Nearby.js";

/** Шаги ползунка, м. Верх — предел API (SEARCH_RADIUS_MAX = 20 000). */
export const RADIUS_STEPS = [300, 500, 1000, 2000, 3000, 5000, 10_000, 15_000, 20_000] as const;

/** Индекс ближайшего шага для произвольного радиуса. */
export function stepIndex(m: number): number {
  let best = 0;
  RADIUS_STEPS.forEach((s, i) => {
    if (Math.abs(s - m) < Math.abs(RADIUS_STEPS[best]! - m)) best = i;
  });
  return best;
}

/** Ширина одного значения на ленте, px (то же — --rd-item в CSS): шаг i в центре при scrollLeft = i × ITEM. */
const ITEM = 56;
/** Пауза после последней прокрутки, мс: значение отдаём, когда лента остановилась, а не на каждом кадре свайпа. */
const SETTLE_MS = 120;
/** Запас на программную прокрутку, мс: если лента так и не доехала (скрыта, прервана), снимаем пометку сами. */
const AUTO_MS = 800;

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function RadiusSlider({
  value,
  onChange,
  allowAll = false,
  overlay = false,
  disabled = false,
}: {
  /** Радиус, м; null — без ограничения (последний шаг, только с allowAll). */
  value: number | null;
  onChange: (m: number | null) => void;
  /** Последний шаг «Усі місця» (null) после максимального радиуса. */
  allowAll?: boolean;
  /** Поверх карты («Поруч»): стеклянная капсула, видимой подписи нет (для читалок остаётся). */
  overlay?: boolean;
  disabled?: boolean;
}) {
  const { t } = useT();
  const { webApp } = useGuide();
  const id = useId();
  const label = useRadiusLabel();
  const last = allowAll ? RADIUS_STEPS.length : RADIUS_STEPS.length - 1;
  const idx = value === null ? last : stepIndex(value);
  const textOf = (i: number) =>
    allowAll && i === RADIUS_STEPS.length ? t("miniapp.catalog.radiusAll") : label(RADIUS_STEPS[i]!);

  // live — шаг в рамке прямо сейчас (меняется во время свайпа); committed — последний отданный/полученный шаг.
  const [live, setLive] = useState(idx);
  const liveRef = useRef(idx);
  const committed = useRef(idx);
  const strip = useRef<HTMLDivElement>(null);
  const settle = useRef<number | undefined>(undefined);
  // Цель прокрутки, запущенной кодом (клик, клавиатура, значение снаружи), px: пока лента к ней едет,
  // промежуточные шаги не показываем и не отдаём. null — прокрутка пользователя.
  const target = useRef<number | null>(null);
  const autoTimer = useRef<number | undefined>(undefined);
  const touching = useRef(false);
  const first = useRef(true);

  const mark = (i: number, haptic: boolean) => {
    if (i === liveRef.current) return;
    liveRef.current = i;
    setLive(i);
    // Лёгкий «щелчок» на каждом шаге — только в Telegram, вне его метода нет.
    if (haptic) webApp?.HapticFeedback?.selectionChanged?.();
  };
  const commit = (i: number) => {
    if (i === committed.current) return;
    committed.current = i;
    onChange(i >= RADIUS_STEPS.length ? null : RADIUS_STEPS[i]!);
  };
  const scrollToStep = (i: number, smooth: boolean) => {
    const el = strip.current;
    if (!el) return;
    const left = i * ITEM;
    if (Math.abs(el.scrollLeft - left) < 1) return;
    target.current = left;
    window.clearTimeout(autoTimer.current);
    autoTimer.current = window.setTimeout(() => (target.current = null), AUTO_MS);
    if (smooth && !reducedMotion() && typeof el.scrollTo === "function")
      el.scrollTo({ left, behavior: "smooth" });
    else el.scrollLeft = left;
  };
  /** Выбор шага нажатием на значение или с клавиатуры: сразу отдаём и доводим ленту до него. */
  const select = (i: number) => {
    mark(i, true);
    commit(i);
    scrollToStep(i, true);
  };

  // Первый показ — лента сразу на текущем значении (без анимации); новое значение снаружи — плавно к нему.
  useLayoutEffect(() => {
    const initial = first.current;
    first.current = false;
    if (!initial && idx === committed.current) return;
    committed.current = idx;
    // Палец на ленте — не выдёргиваем её из-под него: значение снаружи только запоминаем.
    if (!initial && touching.current) return;
    mark(idx, false);
    scrollToStep(idx, !initial);
    // mark/scrollToStep читают только ref-ы — подписка на них не нужна.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  useEffect(
    () => () => {
      window.clearTimeout(settle.current);
      window.clearTimeout(autoTimer.current);
    },
    [],
  );

  /** Пользователь взялся за ленту: дальше прокрутка его, а не программная. */
  const grab = () => {
    target.current = null;
    window.clearTimeout(autoTimer.current);
  };

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    // Колесо мыши (десктоп): вертикальная прокрутка листает ленту; на краю ленты — отдаём странице.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return grab();
      const max = el.scrollWidth - el.clientWidth;
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max)) return;
      e.preventDefault();
      grab();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    // Лента была скрыта (ширина 0) и появилась — ставим её снова на текущий шаг.
    let width = el.clientWidth;
    const ro =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            const was = width;
            width = el.clientWidth;
            if (was === 0 && width > 0) el.scrollLeft = liveRef.current * ITEM;
          })
        : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
    };
  }, []);

  const onScroll = () => {
    const el = strip.current;
    if (!el) return;
    if (target.current !== null) {
      // Программная прокрутка: доехали до цели — дальше снова прокрутка пользователя.
      if (Math.abs(el.scrollLeft - target.current) < 1) grab();
      return;
    }
    mark(Math.min(last, Math.max(0, Math.round(el.scrollLeft / ITEM))), true);
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      // Палец ещё на ленте — ждём, пока отпустит (touchend запланирует отдачу сам).
      if (!touching.current) commit(liveRef.current);
    }, SETTLE_MS);
  };
  const release = () => {
    touching.current = false;
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => commit(liveRef.current), SETTLE_MS);
  };

  return (
    <div
      className={overlay ? "kosiv-radius-slider kosiv-radius-overlay" : "kosiv-radius-slider"}
      data-testid="radius-slider"
      data-disabled={disabled || undefined}
      style={{ "--rd-item": `${ITEM}px` } as CSSProperties}
    >
      <label htmlFor={id}>{t("miniapp.catalog.radius")}</label>
      <div className="kosiv-rd">
        {/* Лента — отдельный элемент поверх карты, а не её потомок: свайп по ней карту не двигает. */}
        <div
          ref={strip}
          className="kosiv-rd-strip"
          aria-hidden="true"
          // Chromium делает прокручиваемый блок остановкой Tab — фокус только у скрытого ползунка.
          tabIndex={-1}
          onScroll={onScroll}
          onTouchStart={() => {
            touching.current = true;
            grab();
          }}
          onTouchEnd={release}
          onTouchCancel={release}
          onPointerDown={grab}
        >
          {Array.from({ length: last + 1 }, (_, i) => (
            <span
              key={i}
              className="kosiv-rd-item"
              data-on={i === live || undefined}
              data-all={allowAll && i === RADIUS_STEPS.length ? "" : undefined}
              data-testid={i === live ? "radius-slider-value" : undefined}
              onClick={() => !disabled && select(i)}
            >
              {textOf(i)}
            </span>
          ))}
        </div>
        <span className="kosiv-rd-frame" aria-hidden="true" />
        <input
          id={id}
          className="kosiv-rd-input"
          type="range"
          min={0}
          max={last}
          step={1}
          value={live}
          disabled={disabled}
          aria-valuetext={textOf(live)}
          onChange={(e) => select(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

// Погода на главной (флаг module.weather): компактная пилюля «иконка +2°» без названия места рядом с «Локація» в обоих дизайнах;
// нажатие — лист с прогнозом на 5 днів (день тижня, іконка, мін/макс, опади, вітер), попередження зверху, підпис
// джерела. Точка — моє місцезнаходження, вибраний пункт, заклад QR або перший пункт регіону; її назва — в aria-label пілюлі й у
// заголовку листа. Кілька вибраних пунктів — перемикач міст у листі: прогноз міста запитується лише при виборі, сервер
// віддає готовий знімок пункту (localities), тож квота джерела майже не змінюється. Немає прогнозу — нічого.
// Іконка — Google (через прокси нашого api) з alt з опису, при Open-Meteo — своя за погодою.
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { useT } from "@tg/ui";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAsync, useGuide } from "../guide/context.js";
import { nearestWithin, type LatLng } from "../guide/geo.js";
import { useLocations } from "../guide/LocationProvider.js";
import { interceptBack } from "../telegram.js";
import type { Forecast, WeatherApi, WeatherCondition, WeatherSource, WeatherWarning } from "./weather-api.js";
import "./weather.css";

const EMOJI: Record<WeatherCondition, string> = {
  clear: "☀️",
  partly_cloudy: "⛅",
  cloudy: "☁️",
  fog: "🌫️",
  drizzle: "🌦️",
  rain: "🌧️",
  heavy_rain: "🌧️",
  showers: "🌦️",
  thunderstorm: "⛈️",
  snow: "🌨️",
  heavy_snow: "❄️",
  sleet: "🌨️",
  freezing_rain: "🧊",
  hail: "🌨️",
  windy: "💨",
};

/** «+2°», «−3°», «0°»; нет значения — null. */
export function formatTemp(t: number | null | undefined): string | null {
  if (t === null || t === undefined || !Number.isFinite(t)) return null;
  const r = Math.round(t);
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}°`;
}

/** Текст погоды: описание источника (Google, украинский) или наш по condition. */
export function useConditionText(): (x: {
  condition: WeatherCondition | null;
  description: string | null;
}) => string {
  const { t } = useT();
  return (x) =>
    x.description ??
    (x.condition ? t(`miniapp.weather.condition.${x.condition}` as MessageKey) : t("miniapp.weather.title"));
}

export function WeatherIcon({
  condition,
  iconUrl,
  label,
  night = false,
  size = 24,
}: {
  condition: WeatherCondition | null;
  iconUrl: string | null;
  label: string;
  night?: boolean;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  if (iconUrl && !broken)
    return (
      <img
        className="wx-icon"
        src={iconUrl}
        alt={label}
        width={size}
        height={size}
        onError={() => setBroken(true)}
      />
    );
  const emoji = condition === "clear" && night ? "🌙" : condition ? EMOJI[condition] : "🌡️";
  return (
    <span
      className="wx-icon wx-emoji"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      style={{ fontSize: size * 0.85 }}
    >
      {emoji}
    </span>
  );
}

/** Подпись источника: Google — текст по условиям Google (без перевода), Open-Meteo — CC BY 4.0. */
export function WeatherAttribution({ source }: { source: WeatherSource }) {
  const { t } = useT();
  if (source === "google")
    return (
      <p className="wx-source" translate="no" data-testid="weather-source">
        {t("miniapp.weather.source.google")}
      </p>
    );
  return (
    <p className="wx-source" data-testid="weather-source">
      <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
        {t("miniapp.weather.source.openMeteo")}
      </a>
    </p>
  );
}

export function WarningList({ warnings, testId }: { warnings: readonly WeatherWarning[]; testId?: string }) {
  const { t } = useT();
  if (!warnings.length) return null;
  return (
    <ul className="wx-warnings" data-testid={testId}>
      {warnings.map((w) => (
        <li key={w}>
          <span aria-hidden="true">⚠️</span> {t(`miniapp.weather.warning.${w}` as MessageKey)}
        </li>
      ))}
    </ul>
  );
}

/** Дальше этого от любого пункта региона GPS-точка остаётся «Поруч із вами». */
const GPS_LOCALITY_M = 15_000;

/** Точка прогноза и её настоящее название. */
export type WeatherPlace = { id: string; point: LatLng; name: string };

/**
 * Точки погоды главной: моє місцезнаходження (ближайший пункт региона до 15 км, иначе «Поруч із вами») → вибрані пункти (кожен зі своєю назвою) → заклад QR
 * (назва закладу) → перший пункт регіону. Первая — по умолчанию; больше одной — только при нескольких выбранных.
 */
export function useWeatherPlaces(): WeatherPlace[] {
  const { t, locale } = useT();
  const { gps, selected, options } = useLocations();
  const { base } = useGuide();
  if (gps) {
    // Название ближайшего пункта региона (данные уже загружены, без геокодера); далеко от всех — «Поруч із вами».
    const near = nearestWithin(options ?? [], gps, GPS_LOCALITY_M);
    return [
      { id: "gps", point: gps, name: near ? pickLocalized(near.name, locale) : t("miniapp.weather.nearYou") },
    ];
  }
  const named = (options ?? []).flatMap((o) =>
    o.location ? [{ id: o.id, point: o.location, name: pickLocalized(o.name, locale) }] : [],
  );
  const chosen = named.filter((o) => selected.includes(o.id));
  if (chosen.length) return chosen;
  if (base?.point) return [{ id: "base", point: base.point, name: base.name }];
  return named.slice(0, 1);
}

/** Пилюля погоды на главной: значок и t°; название места — в aria-label и в листе по нажатию. Нет точки или прогноза — ничего. */
export function WeatherChip({ api }: { api: WeatherApi }) {
  const places = useWeatherPlaces();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const place = places.find((p) => p.id === pickedId) ?? places[0] ?? null;
  const point = place?.point ?? null;
  // Точка до ~100 м: мелкие сдвиги GPS не перезапрашивают прогноз.
  const key = point ? `${point.lat.toFixed(3)},${point.lng.toFixed(3)}` : "";
  const placeName = place?.name ?? "";
  // Название — в результате загрузки: на экране прогноз и подпись всегда одной точки.
  const [state] = useAsync(
    async (signal) => ({
      forecast: point ? await api.forecast(point, signal) : null,
      name: placeName,
    }),
    [api, key, placeName],
  );
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // Пока грузится прогноз для новой точки — прежний (открытый лист не пропадает и не мигает).
  const [last, setLast] = useState<{ forecast: Forecast | null; name: string } | null>(null);
  // Последний настоящий прогноз: пилюля под листом и на время возврата к городу по умолчанию (фокусу есть куда вернуться).
  const [good, setGood] = useState<{ forecast: Forecast; name: string } | null>(null);
  useEffect(() => {
    if (state.status === "ready") {
      setLast(state.data);
      const { forecast, name } = state.data;
      if (forecast?.days[0]) setGood({ forecast, name });
    } else if (state.status === "error") setLast(null);
  }, [state]);
  // Стабильная ссылка: эффект листа (фокус, Escape, «Назад») не перезапускается на каждый рендер.
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  // Город уже сменился, а результат ещё прежний (useAsync начнёт загрузку после рендера) — это тоже загрузка.
  const stale = state.status === "ready" && state.data.name !== placeName;
  const loading = state.status === "loading" || stale;
  const loaded = state.status === "ready" && !stale ? state.data : loading ? last : null;
  const f = loaded?.forecast ?? null;
  const shownName = loaded?.name ?? placeName;
  const today = f?.days[0];
  // Лист закрыт на городе без прогноза: пилюля вернётся к городу по умолчанию, а не исчезнет.
  const stuck = !open && pickedId !== null && state.status === "ready" && !stale && !today;
  useEffect(() => {
    if (stuck) setPickedId(null);
  }, [stuck]);
  // Пилюля: прогноз точки, а если его нет — последний настоящий, пока лист открыт или идёт возврат после закрытия.
  const chip = today ? { forecast: f!, name: shownName } : open || stuck || loading ? good : null;
  // Лист всегда на одном месте дерева: смена города с прогнозом на город без него его не пересоздаёт.
  return (
    <>
      {chip && <ChipButton chip={chip} button={button} open={open} onOpen={() => setOpen(true)} />}
      {open && (
        <WeatherSheet
          forecast={f && today ? f : null}
          place={shownName}
          places={places}
          pickedId={place?.id ?? null}
          pending={loading ? placeName : null}
          onPick={setPickedId}
          onClose={close}
        />
      )}
    </>
  );
}

function ChipButton({
  chip,
  button,
  open,
  onOpen,
}: {
  chip: { forecast: Forecast; name: string };
  button: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpen: () => void;
}) {
  const { t } = useT();
  const text = useConditionText();
  const now = chip.forecast.current;
  const today = chip.forecast.days[0]!;
  const temp = formatTemp(now?.temperature ?? today.temperatureMax);
  const condition = now?.condition ?? today.condition;
  const label = text(now ?? today);
  const danger = today.warnings.length > 0;
  return (
    <button
      ref={button}
      type="button"
      className="wx-chip"
      data-testid="weather-chip"
      data-danger={danger || undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t("miniapp.weather.openAt", {
        place: chip.name,
        summary: [label, temp].filter(Boolean).join(", "),
      })}
      onClick={onOpen}
    >
      <WeatherIcon
        condition={condition}
        iconUrl={now?.iconUrl ?? today.iconUrl}
        label=""
        night={now?.isDay === false}
        size={22}
      />
      {temp && <span className="wx-chip-temp">{temp}</span>}
      {danger && (
        <span className="wx-chip-alert" aria-hidden="true">
          ⚠️
        </span>
      )}
    </button>
  );
}

const FOCUSABLE = "button, a[href]";

/** Лист прогноза: aria-modal, фокус внутри (Tab по кругу), Escape, тап по фону и «Назад» Telegram закрывают. */
export function WeatherSheet({
  forecast,
  place,
  places,
  pickedId,
  pending,
  onPick,
  onClose,
}: {
  /** null — у выбранного города прогноза нет. */
  forecast: Forecast | null;
  /** Название точки, к которой относится показанный прогноз. */
  place: string;
  places: readonly WeatherPlace[];
  pickedId: string | null;
  /** Название города, чей прогноз ещё грузится. */
  pending: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  const text = useConditionText();
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  // «Назад» Telegram закрывает лист: пока перехват есть, кнопка видна и на главной (NativeBack в App.tsx).
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const releaseBack = interceptBack(onClose);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !sheet.current) return;
      const items = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      releaseBack();
    };
  }, [onClose]);
  const warnings = (forecast?.days ?? []).flatMap((d, i) =>
    d.warnings.map((w) => ({ w, day: i === 0 ? t("miniapp.weather.today") : weekday(d.date, locale) })),
  );
  return createPortal(
    <div className="wx-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={sheet}
        className="wx-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wx-sheet-title"
        data-testid="weather-sheet"
      >
        <div className="wx-sheet-head">
          <h2 id="wx-sheet-title" data-testid="weather-sheet-title">
            {t("miniapp.weather.forecastAt", { place })}
          </h2>
          <button
            type="button"
            className="wx-close"
            aria-label={t("miniapp.weather.close")}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {places.length > 1 && (
          <div
            className="wx-places"
            role="group"
            aria-label={t("miniapp.weather.choosePlace")}
            data-testid="weather-places"
          >
            {places.map((p) => (
              <button
                key={p.id}
                type="button"
                className="wx-place"
                aria-pressed={p.id === pickedId}
                onClick={() => onPick(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        <p role="status" className="wx-pending" data-testid="weather-pending">
          {pending ? t("miniapp.weather.loading", { place: pending }) : ""}
        </p>
        {warnings.length > 0 && (
          // role="alert" — на обёртке: на самом <ul> он отменил бы роль списка.
          <div role="alert">
            <ul className="wx-warnings" data-testid="weather-warnings">
              {warnings.map(({ w, day }) => (
                <li key={`${day}-${w}`}>
                  <span aria-hidden="true">⚠️</span> {day}: {t(`miniapp.weather.warning.${w}` as MessageKey)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!forecast && !pending && <p>{t("miniapp.weather.noForecast", { place })}</p>}
        {forecast && (
          <ul className="wx-days" data-testid="weather-days">
            {forecast.days.map((d, i) => {
              const label = text(d);
              const max = formatTemp(d.temperatureMax);
              const min = formatTemp(d.temperatureMin);
              return (
                <li key={d.date} className="wx-day">
                  <span className="wx-day-name">
                    {i === 0 ? t("miniapp.weather.today") : weekday(d.date, locale)}
                  </span>
                  <WeatherIcon condition={d.condition} iconUrl={d.iconUrl} label={label} size={28} />
                  <span className="wx-day-temp">
                    {max && <strong>{max}</strong>}
                    {min && <span className="wx-muted"> / {min}</span>}
                  </span>
                  <span className="wx-day-meta">
                    {d.precipitationProbabilityMax !== null && (
                      <span>
                        {t("miniapp.weather.precip", { p: Math.round(d.precipitationProbabilityMax) })}
                      </span>
                    )}
                    {d.windSpeedMax !== null && (
                      <span>{t("miniapp.weather.wind", { v: Math.round(d.windSpeedMax) })}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {forecast && <WeatherAttribution source={forecast.source} />}
      </div>
    </div>,
    document.body,
  );
}

/** «пн, 10.11» по местной дате YYYY-MM-DD. */
export function weekday(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "2-digit", month: "2-digit" }).format(
    new Date(y, m - 1, d),
  );
}

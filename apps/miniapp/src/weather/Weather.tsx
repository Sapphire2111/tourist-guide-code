// Погода на главной (флаг module.weather): компактная пилюля «иконка +2°» рядом с «Локація» в обоих дизайнах;
// нажатие — лист с прогнозом на 5 днів (день тижня, іконка, мін/макс, опади, вітер), попередження зверху, підпис
// джерела. Точка — моє місцезнаходження, вибраний пункт, заклад QR або перший пункт регіону. Немає прогнозу — нічого.
// Іконка — Google (через прокси нашого api) з alt з опису, при Open-Meteo — своя за погодою.
import type { MessageKey } from "@tg/i18n";
import { useT } from "@tg/ui";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAsync, useGuide } from "../guide/context.js";
import type { LatLng } from "../guide/geo.js";
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

/** Точка погоды главной: моє місцезнаходження → перший вибраний пункт → заклад QR → перший пункт регіону. */
export function useWeatherPoint(): LatLng | null {
  const { gps, selected, options } = useLocations();
  const { base } = useGuide();
  if (gps) return gps;
  const chosen = options?.find((o) => selected.includes(o.id) && o.location)?.location;
  if (chosen) return chosen;
  if (base?.point) return base.point;
  return options?.find((o) => o.location)?.location ?? null;
}

/** Пилюля погоды на главной; нет точки или прогноза — ничего (без пустого места). */
export function WeatherChip({ api }: { api: WeatherApi }) {
  const { t } = useT();
  const text = useConditionText();
  const point = useWeatherPoint();
  // Точка до ~100 м: мелкие сдвиги GPS не перезапрашивают прогноз.
  const key = point ? `${point.lat.toFixed(3)},${point.lng.toFixed(3)}` : "";
  const [state] = useAsync(
    (signal) => (point ? api.forecast(point, signal) : Promise.resolve(null)),
    [api, key],
  );
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const f = state.status === "ready" ? state.data : null;
  const today = f?.days[0];
  if (!f || !today) return null;
  const now = f.current;
  const temp = formatTemp(now?.temperature ?? today.temperatureMax);
  const condition = now?.condition ?? today.condition;
  const label = text(now ?? today);
  const danger = today.warnings.length > 0;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="wx-chip"
        data-testid="weather-chip"
        data-danger={danger || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("miniapp.weather.open", { summary: [label, temp].filter(Boolean).join(", ") })}
        onClick={() => setOpen(true)}
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
      {open && (
        <WeatherSheet
          forecast={f}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </>
  );
}

const FOCUSABLE = "button, a[href]";

/** Лист прогноза: aria-modal, фокус внутри (Tab по кругу), Escape, тап по фону и «Назад» Telegram закрывают. */
export function WeatherSheet({ forecast, onClose }: { forecast: Forecast; onClose: () => void }) {
  const { t, locale } = useT();
  const text = useConditionText();
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>("button")?.focus();
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
  const warnings = forecast.days.flatMap((d, i) =>
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
          <h2 id="wx-sheet-title">{t("miniapp.weather.forecast")}</h2>
          <button
            type="button"
            className="wx-close"
            aria-label={t("miniapp.weather.close")}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {warnings.length > 0 && (
          <ul className="wx-warnings" role="alert" data-testid="weather-warnings">
            {warnings.map(({ w, day }) => (
              <li key={`${day}-${w}`}>
                <span aria-hidden="true">⚠️</span> {day}: {t(`miniapp.weather.warning.${w}` as MessageKey)}
              </li>
            ))}
          </ul>
        )}
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
        <WeatherAttribution source={forecast.source} />
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

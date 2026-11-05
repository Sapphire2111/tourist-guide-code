// Точка заведения без широты и долготы руками: «Позначити на карті» (лист с картой — ленивый чанк) и «Вставити
// посилання Google Maps». Широта/долгота остаются в «Координати вручну».
import { Component, lazy, Suspense, useCallback, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, useT } from "@tg/ui";
import { isChunkLoadError, reloadOnceForChunkError } from "../chunk-reload.js";
import { mapsAvailable } from "../guide/map-config.js";
import { useSheet } from "../guide/use-sheet.js";
import { Live, type Message } from "./parts.js";

export type Coords = { lat: number; lon: number };

const inRange = (lat: number, lon: number) =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";
const PAIR = `${NUM}\\s*(?:,|;|\\s)\\s*${NUM}`;
const SHORT_LINK = /(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i;

/**
 * Координаты из ссылки Google Maps или пары чисел: «!3d…!4d…» (точка места), «?q=/ll=/query=lat,lng»,
 * «@lat,lng,zoom», «48.3, 25.1». Скорочене посилання ("short") без запроса не раскрыть; нет координат — null.
 */
export function parseMapsLink(input: string): Coords | "short" | null {
  let s = input.trim();
  if (!s) return null;
  try {
    s = decodeURIComponent(s);
  } catch {
    // Не URL-кодировка — разбираем как есть.
  }
  const found = (a: string | undefined, b: string | undefined): Coords | null => {
    if (a === undefined || b === undefined) return null;
    const lat = Number(a);
    const lon = Number(b);
    return inRange(lat, lon) ? { lat: Number(fmt(lat)), lon: Number(fmt(lon)) } : null;
  };
  const m =
    s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) ??
    s.match(new RegExp(`[?&](?:q|ll|query|center|destination|daddr)=${PAIR}(?:[&#]|$)`)) ??
    s.match(new RegExp(`@${NUM},${NUM}`)) ??
    s.match(new RegExp(`/place/${NUM},${NUM}`)) ??
    s.match(new RegExp(`^${PAIR}$`));
  const coords = found(m?.[1], m?.[2]);
  if (coords) return coords;
  return SHORT_LINK.test(s) ? "short" : null;
}

const LocationMap = lazy(() => import("./LocationMap.js"));

class MapBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error)) void reloadOnceForChunkError(error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function MapSheet({
  coords,
  onPick,
  onClose,
}: {
  coords: Coords | null;
  onPick: (c: Coords) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  useSheet(ref, close);
  const title = useId();
  return createPortal(
    <div className="partner-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className="partner-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        data-testid="location-sheet"
      >
        <h2 id={title}>{t("miniapp.partner.location.sheetTitle")}</h2>
        <p className="partner-field-hint">{t("miniapp.partner.location.mapHint")}</p>
        {mapsAvailable() ? (
          <MapBoundary fallback={<p role="alert">{t("miniapp.partner.location.mapError")}</p>}>
            <Suspense fallback={<p role="status">{t("miniapp.guide.loading")}</p>}>
              <LocationMap
                point={coords ? { lat: coords.lat, lng: coords.lon } : null}
                onPick={(p) => onPick({ lat: Number(fmt(p.lat)), lon: Number(fmt(p.lng)) })}
              />
            </Suspense>
          </MapBoundary>
        ) : (
          <p role="note" className="partner-field-hint" data-testid="map-unavailable">
            {t("miniapp.partner.location.mapUnavailable")}
          </p>
        )}
        <p data-testid="location-sheet-coords">
          {coords
            ? t("miniapp.partner.location.current", { lat: fmt(coords.lat), lon: fmt(coords.lon) })
            : t("miniapp.partner.location.none")}
        </p>
        <Button onClick={close}>{t("miniapp.partner.location.done")}</Button>
      </div>
    </div>,
    document.body,
  );
}

export function LocationPicker({
  lat,
  lon,
  onChange,
  disabled = false,
}: {
  /** Строки формы: как набрано в «Координати вручну». */
  lat: string;
  lon: string;
  onChange: (lat: string, lon: string) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [sheet, setSheet] = useState(false);
  const [link, setLink] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const ids = { link: useId(), hint: useId(), lat: useId(), lon: useId() };
  const nlat = Number(lat.replace(",", "."));
  const nlon = Number(lon.replace(",", "."));
  const coords: Coords | null =
    lat.trim() && lon.trim() && inRange(nlat, nlon) ? { lat: nlat, lon: nlon } : null;
  const set = (c: Coords) => onChange(fmt(c.lat), fmt(c.lon));

  const apply = () => {
    const parsed = parseMapsLink(link);
    if (parsed === null || parsed === "short") {
      setMessage({
        text: t(
          parsed === "short" ? "miniapp.partner.location.shortLink" : "miniapp.partner.location.badLink",
        ),
        alert: true,
      });
      return;
    }
    set(parsed);
    setLink("");
    setMessage({ text: t("miniapp.partner.location.applied"), alert: false });
  };

  return (
    <fieldset disabled={disabled} className="partner-fieldset" data-testid="location-picker">
      <legend className="partner-legend">{t("miniapp.partner.field.location")}</legend>
      <p data-testid="location-current">
        {coords
          ? t("miniapp.partner.location.current", { lat: fmt(coords.lat), lon: fmt(coords.lon) })
          : t("miniapp.partner.location.none")}
      </p>
      <Button onClick={() => setSheet(true)}>
        {t(coords ? "miniapp.partner.location.change" : "miniapp.partner.location.set")}
      </Button>
      <div className="partner-field">
        <label htmlFor={ids.link}>{t("miniapp.partner.location.pasteLabel")}</label>
        <input
          id={ids.link}
          value={link}
          inputMode="url"
          autoComplete="off"
          aria-describedby={ids.hint}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
        />
        <span id={ids.hint} className="partner-field-hint">
          {t("miniapp.partner.location.pasteHint")}
        </span>
      </div>
      <Button onClick={apply} disabled={!link.trim()}>
        {t("miniapp.partner.location.apply")}
      </Button>
      <Live message={message} testId="location-message" />
      <details className="partner-details">
        <summary>{t("miniapp.partner.location.advanced")}</summary>
        <div className="partner-row">
          <div className="partner-field partner-field-time">
            <label htmlFor={ids.lat}>{t("miniapp.partner.editor.lat")}</label>
            <input
              id={ids.lat}
              inputMode="decimal"
              value={lat}
              onChange={(e) => onChange(e.target.value, lon)}
            />
          </div>
          <div className="partner-field partner-field-time">
            <label htmlFor={ids.lon}>{t("miniapp.partner.editor.lon")}</label>
            <input
              id={ids.lon}
              inputMode="decimal"
              value={lon}
              onChange={(e) => onChange(lat, e.target.value)}
            />
          </div>
        </div>
      </details>
      {sheet && <MapSheet coords={coords} onPick={set} onClose={() => setSheet(false)} />}
    </fieldset>
  );
}

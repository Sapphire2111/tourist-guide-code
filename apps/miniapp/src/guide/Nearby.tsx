// C05 «Що поруч»: места в радиусе от базовой точки (QR) или — по нажатию и с разрешения — от устройства.
// Подпись «Поруч із вами» только при полученной геолокации, иначе «Поруч із <база>».
import { useEffect, useRef, useState } from "react";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { canOpenLocationSettings, requestLocation, type LatLng } from "./geo.js";
import type { Async } from "./context.js";
import { MapSlot, preloadMap } from "./MapSlot.js";
import { AsyncView, PlaceList } from "./parts.js";
import { OWN_MAP_SECTIONS, type PlaceSummary } from "./types.js";

/** Ползунок радиуса, м: от 500 м до 10 км шагом 500 м. */
export const RADIUS_MIN = 500;
export const RADIUS_MAX = 10_000;
export const RADIUS_STEP = 500;
export const DEFAULT_RADIUS = 500;
/** Задержка запроса при перетаскивании ползунка, мс. */
export const RADIUS_DEBOUNCE_MS = 350;
/** Не больше стольких ближайших мест на 10 км (сервер сортирует по расстоянию). */
export const NEARBY_LIMIT = 50;
/** Предел масштаба карты для выдачи вокруг устройства (приватность: тайлы OSM выдают район). */
export const DEVICE_MAX_ZOOM = 14;

/** Подпись радиуса: «500 м», «1,5 км», «10 км». */
export function useRadiusLabel(): (m: number) => string {
  const { t } = useT();
  return (m) =>
    m < 1000
      ? t("miniapp.nearby.meters", { n: m })
      : t("miniapp.place.distanceKm", { n: String(Math.round(m / 100) / 10).replace(".", ",") });
}

type NearbyResult = { list: PlaceSummary[]; radius: number };

type Geo = { status: "idle" | "locating" | "denied" } | { status: "granted"; point: LatLng };

export function Nearby({ useMyLocation }: { useMyLocation: boolean }) {
  const { t, locale } = useT();
  const { webApp, base } = useGuide();
  const [radius, setRadius] = useState<number>(DEFAULT_RADIUS);
  /** Радиус запроса — значение ползунка после паузы в перетаскивании. */
  const [queryRadius, setQueryRadius] = useState<number>(DEFAULT_RADIUS);
  useEffect(() => {
    if (radius === queryRadius) return;
    const timer = window.setTimeout(() => setQueryRadius(radius), RADIUS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [radius, queryRadius]);
  // Модуль карты и скрипт Google Maps — параллельно запросу мест (повторный вызов берёт тот же промис).
  useEffect(() => {
    preloadMap(locale).catch(() => undefined);
  }, [locale]);
  const radiusText = useRadiusLabel()(radius);
  const [geo, setGeo] = useState<Geo>({ status: useMyLocation ? "locating" : "idle" });

  const locate = () => {
    setGeo({ status: "locating" });
    void requestLocation(webApp).then((point) =>
      setGeo(point ? { status: "granted", point } : { status: "denied" }),
    );
  };
  // «Що поруч зі мною зараз» с главной — запрос сразу (это и есть нажатие пользователя).
  useEffect(() => {
    if (useMyLocation) locate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useMyLocation]);

  const point = geo.status === "granted" ? geo.point : (base?.point ?? null);
  const caption =
    geo.status === "granted"
      ? t("miniapp.nearby.nearYou")
      : base?.point
        ? t("miniapp.nearby.nearBase", { base: base.name })
        : null;

  return (
    <Stack>
      <h1>{t("miniapp.nearby.title")}</h1>
      {caption && <p data-testid="nearby-caption">{caption}</p>}
      {geo.status === "denied" && (
        <p role="alert" data-testid="geo-off">
          {base?.point ? t("miniapp.nearby.geoOff", { base: base.name }) : t("miniapp.nearby.geoOffNoBase")}
        </p>
      )}
      {geo.status === "denied" && canOpenLocationSettings(webApp) && (
        <Button onClick={() => webApp?.LocationManager?.openSettings?.()}>
          {t("miniapp.nearby.openSettings")}
        </Button>
      )}
      <div className="kosiv-range">
        <div className="kosiv-range-head">
          <label htmlFor="nearby-radius">{t("miniapp.nearby.radius")}</label>
          <output htmlFor="nearby-radius" data-testid="radius-value">
            {radiusText}
          </output>
        </div>
        <input
          id="nearby-radius"
          type="range"
          min={RADIUS_MIN}
          max={RADIUS_MAX}
          step={RADIUS_STEP}
          value={radius}
          aria-valuetext={radiusText}
          onChange={(e) => setRadius(Number(e.target.value))}
        />
      </div>
      {geo.status !== "granted" && (
        <Button disabled={geo.status === "locating"} onClick={locate}>
          {geo.status === "locating" ? t("miniapp.nearby.locating") : t("miniapp.nearby.useLocation")}
        </Button>
      )}
      {point ? (
        <NearbyPlaces
          point={point}
          radius={queryRadius}
          // Карта строится по местам и базовой точке и на устройство не центрируется; позиция устройства — только значок «Ви тут» (me).
          base={geo.status === "granted" ? null : (base?.point ?? null)}
          baseLabel={caption ?? undefined}
          me={geo.status === "granted" ? geo.point : null}
        />
      ) : (
        geo.status !== "locating" &&
        geo.status !== "denied" && <p data-testid="nearby-no-point">{t("miniapp.nearby.noBase")}</p>
      )}
    </Stack>
  );
}

function NearbyPlaces({
  point,
  radius,
  base,
  baseLabel,
  me,
}: {
  point: LatLng;
  radius: number;
  base: LatLng | null;
  baseLabel?: string;
  me: LatLng | null;
}) {
  const { t } = useT();
  const { api } = useGuide();
  const label = useRadiusLabel();
  const [fresh, retry] = useAsync(
    () =>
      api
        .search({ point, radius, excludeSections: OWN_MAP_SECTIONS, limit: NEARBY_LIMIT })
        .then((list) => ({ list, radius })),
    [api, point.lat, point.lng, radius],
  );
  // Смена радиуса: прежний список и карта остаются до ответа (карта не пересоздаётся, тайлы не грузятся заново).
  const last = useRef<Async<NearbyResult>>(fresh);
  if (fresh.status !== "loading") last.current = fresh;
  const shown = fresh.status === "loading" && last.current.status === "ready" ? last.current : fresh;
  return (
    <AsyncView state={shown} retry={retry}>
      {({ list, radius: loaded }) => (
        <Stack>
          {/* Круг, пустой текст и подписи — по радиусу загруженных данных, не по ползунку. */}
          <MapSlot
            places={list}
            center={base}
            centerLabel={baseLabel}
            radius={base ? loaded : undefined}
            // По геолокации места окружают устройство: без базовой точки не приближаем карту до двора туриста.
            maxZoom={base ? undefined : DEVICE_MAX_ZOOM}
            // Позиция устройства: только если геолокация уже получена (отдельный запрос не делаем).
            me={me}
          />
          {/* Статус обновления — под картой, в строке фиксированной высоты: карта не сдвигается. */}
          <p role="status" className="kosiv-muted kosiv-status-line" data-testid="nearby-status">
            {fresh.status === "loading"
              ? t("miniapp.guide.loading")
              : list.length >= NEARBY_LIMIT
                ? t("miniapp.nearby.limited", { n: NEARBY_LIMIT })
                : ""}
          </p>
          {list.length === 0 ? (
            <p data-testid="nearby-empty">{t("miniapp.nearby.emptyRadius", { r: label(loaded) })}</p>
          ) : (
            <PlaceList places={list} />
          )}
        </Stack>
      )}
    </AsyncView>
  );
}

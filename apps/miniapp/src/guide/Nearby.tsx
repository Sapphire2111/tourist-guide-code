// C05 «Що поруч»: места в радиусе от базовой точки (QR) или — по нажатию и с разрешения — от устройства.
// Подпись «Поруч із вами» только при полученной геолокации, иначе «Поруч із <база>».
import { useEffect, useState } from "react";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { requestLocation, type LatLng } from "./geo.js";
import { MapSlot } from "./MapSlot.js";
import { AsyncView, PlaceList } from "./parts.js";

export const RADII = [300, 500, 1000] as const;
export const DEFAULT_RADIUS = 500;

type Geo = { status: "idle" | "locating" | "denied" } | { status: "granted"; point: LatLng };

export function Nearby({ useMyLocation }: { useMyLocation: boolean }) {
  const { t } = useT();
  const { webApp, base } = useGuide();
  const [radius, setRadius] = useState<number>(DEFAULT_RADIUS);
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
      <label>
        {t("miniapp.nearby.radius")}{" "}
        <select
          value={radius}
          onChange={(e) => setRadius(Number(e.target.value))}
          style={{ font: "inherit", padding: "4px 8px" }}
        >
          {RADII.map((r) => (
            <option key={r} value={r}>
              {t("miniapp.nearby.meters", { n: r })}
            </option>
          ))}
        </select>
      </label>
      {geo.status !== "granted" && (
        <Button disabled={geo.status === "locating"} onClick={locate}>
          {geo.status === "locating" ? t("miniapp.nearby.locating") : t("miniapp.nearby.useLocation")}
        </Button>
      )}
      {point ? (
        <NearbyPlaces point={point} radius={radius} centerLabel={caption ?? undefined} />
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
  centerLabel,
}: {
  point: LatLng;
  radius: number;
  centerLabel?: string;
}) {
  const { t } = useT();
  const { api } = useGuide();
  const [places, retry] = useAsync(() => api.search({ point, radius }), [api, point.lat, point.lng, radius]);
  return (
    <AsyncView state={places} retry={retry}>
      {(list) => (
        <Stack>
          <MapSlot places={list} center={point} centerLabel={centerLabel} radius={radius} />
          {list.length === 0 ? (
            <p data-testid="nearby-empty">{t("miniapp.nearby.empty", { n: radius })}</p>
          ) : (
            <PlaceList places={list} />
          )}
        </Stack>
      )}
    </AsyncView>
  );
}

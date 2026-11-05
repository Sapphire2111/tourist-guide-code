// Выбор места каталога на карте (рядом с выпадающим списком «Місце каталогу»): кнопка открывает панель с картой —
// карта и загрузчик Google Maps грузятся лениво, только при открытии. Без ключа Google Maps — пояснение вместо
// кнопки, поиск по названию работает как прежде. Ниже — ссылка на создание места, если его нет в каталоге.
import { lazy, Suspense, useState } from "react";
import { Link, useT } from "@tg/ui";
import type { ApiSchemas } from "./api.js";
import { mapsAvailable } from "./map-config.js";
import { row, SmallButton } from "./ui.js";

type Place = ApiSchemas["PlaceDto"];

const PlaceMap = lazy(() => import("./PlaceMap.js"));

export function PlaceMapPicker({
  selected,
  onChoose,
}: {
  /** Выбранное место (центр карты при открытии); null — центр региона. */
  selected: Place | null;
  onChoose: (place: Place) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const available = mapsAvailable();
  return (
    <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ ...row, alignItems: "center" }}>
        {available ? (
          <SmallButton aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t("admin.placeMap.close") : t("admin.placeMap.open")}
          </SmallButton>
        ) : (
          <span style={{ color: "#5f6368" }}>{t("admin.placeMap.noKey")}</span>
        )}
        <Link to="/places/new">{t("admin.placeMap.addPlace")}</Link>
      </div>
      {open && (
        <section aria-label={t("admin.placeMap.title")}>
          <Suspense fallback={<p style={{ margin: 0 }}>{t("admin.placeMap.loading")}</p>}>
            <PlaceMap
              selected={selected}
              onChoose={(place) => {
                onChoose(place);
                setOpen(false);
              }}
            />
          </Suspense>
        </section>
      )}
    </div>
  );
}

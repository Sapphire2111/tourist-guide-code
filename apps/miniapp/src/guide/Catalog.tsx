// C04: раздел главной → корневая категория и её подкатегории, поиск по названию, список/карта.
// Порядок выдачи задаёт сервер (релевантность, реклама — по правилам C-02); клиент только помечает рекламу.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { ICONS } from "../design/Ornament.js";
import { loadCategories } from "./categories.js";
import { useAsync, useGuide } from "./context.js";
import { GPS_RADIUS, useLocationCaption, useLocations } from "./LocationProvider.js";
import { MapSlot } from "./MapSlot.js";
import { AsyncView, PlaceList } from "./parts.js";
import type { CatalogSection, Category } from "./types.js";

/** Поиск мест по всему региону или выбранным локациям (#/search?q=…): быстрые запросы сезона, «Усі місця». */
export function PlaceSearch({ initialQuery = "" }: { initialQuery?: string }) {
  const { t } = useT();
  return (
    <Stack>
      <h1>{t("miniapp.search.title")}</h1>
      <CategoryPlaces root={null} subcategories={[]} initialQuery={initialQuery} />
    </Stack>
  );
}

export function Catalog({ section }: { section: CatalogSection }) {
  const { t } = useT();
  const { api } = useGuide();
  const [categories, retry] = useAsync(() => loadCategories(api), [api]);
  return (
    <Stack>
      <h1>{t(`miniapp.section.${section}` as MessageKey)}</h1>
      <AsyncView state={categories} retry={retry}>
        {(all) => {
          const root = all.find((c) => c.parentId === null && c.homeSection === section);
          if (!root) return <p data-testid="section-empty">{t("miniapp.catalog.sectionEmpty")}</p>;
          return <CategoryPlaces root={root} subcategories={all.filter((c) => c.parentId === root.id)} />;
        }}
      </AsyncView>
    </Stack>
  );
}

/**
 * Сколько мест «Де жити» показывать на карте: страницы по 50 (6 запросов). Кластеризации нет — 300 маркеров
 * Leaflet держит без заметных тормозов; на курорте мест проживания меньше (Буковель ~180 по выгрузке Google).
 */
export const STAY_MAP_MAX = 300;

/** Сколько ждать базовую точку перед поиском без неё, мс. */
export const BASE_WAIT_MS = 4_000;

function CategoryPlaces({
  root,
  subcategories,
  initialQuery = "",
}: {
  /** null — поиск без категории (весь каталог). */
  root: Category | null;
  subcategories: Category[];
  initialQuery?: string;
}) {
  const { t, locale } = useT();
  const { api, analytics, base } = useGuide();
  const { selected: localityIds, gps } = useLocations();
  const locationCaption = useLocationCaption();
  const rootId = root?.id;
  const [categoryId, setCategoryId] = useState(rootId);
  const [draft, setDraft] = useState(initialQuery);
  const [q, setQ] = useState(initialQuery.trim().length >= 2 ? initialQuery.trim() : "");
  // «Де жити» — карта главная (все места ночёвки сразу на карте, до STAY_MAP_MAX), список вторичен.
  const mapFirst = root?.homeSection === "stay";
  const [view, setView] = useState<"list" | "map">(mapFirst ? "map" : "list");
  // Выбраны локации — все места этих пунктов; базовая точка QR остаётся для расстояния и порядка (api без радиуса).
  const byLocation = localityIds.length > 0;
  const point = gps ?? base?.point ?? null;
  // Номер отправки формы поиска: search_used — один раз на ответ именно этой отправки (не при повторе,
  // смене категории/базовой точки или отменённой загрузке). Текст запроса не отправляется (ПДн-риск).
  const [submitId, setSubmitId] = useState(0);
  const pendingSubmit = useRef<number | null>(null);
  const [places, retry] = useAsync(
    (signal) =>
      // Базовая точка ещё грузится — ждём её (пришла — эффект перезапустится с точкой), но не дольше
      // BASE_WAIT_MS: завис запрос точки — ищем без неё.
      (base?.pending ? new Promise((r) => setTimeout(r, BASE_WAIT_MS)) : Promise.resolve())
        .then(() =>
          api.search({
            categoryId,
            q: q || undefined,
            point,
            ...(byLocation ? { localityIds } : {}),
            ...(gps ? { radius: GPS_RADIUS } : {}),
            ...(mapFirst ? { max: STAY_MAP_MAX, signal } : {}),
          }),
        )
        .then((list) => ({ list, submitId })),
    [api, categoryId, q, submitId, base?.pending, point?.lat, point?.lng, localityIds, gps],
  );
  useEffect(() => {
    if (places.status !== "ready" || pendingSubmit.current !== places.data.submitId) return;
    pendingSubmit.current = null;
    if (q) analytics.track("search_used", { categoryId, resultCount: places.data.list.length });
  }, [analytics, categoryId, q, places]);

  useEffect(() => {
    if (categoryId) analytics.track("category_opened", { categoryId });
  }, [analytics, categoryId]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // api принимает запрос от 2 символов; короче — показываем весь раздел.
    const text = draft.trim();
    setQ(text.length >= 2 ? text : "");
    pendingSubmit.current = submitId + 1;
    setSubmitId((n) => n + 1);
  };

  return (
    <Stack>
      {subcategories.length > 0 && root && (
        <div role="group" aria-label={t("miniapp.catalog.subcategories")}>
          <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {[root, ...subcategories].map((c) => (
              <button
                key={c.id}
                type="button"
                className="kosiv-toggle"
                aria-pressed={c.id === categoryId}
                onClick={() => setCategoryId(c.id)}
              >
                {c.id === root.id ? t("miniapp.catalog.all") : pickLocalized(c.name, locale)}
              </button>
            ))}
          </span>
        </div>
      )}
      <form role="search" onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <label htmlFor="catalog-q" style={{ position: "absolute", left: -9999 }}>
          {t("miniapp.catalog.searchLabel")}
        </label>
        <input
          id="catalog-q"
          type="search"
          value={draft}
          placeholder={t("miniapp.catalog.searchLabel")}
          onChange={(e) => setDraft(e.target.value)}
          style={{ flex: 1, minWidth: 0, borderRadius: 9999, paddingLeft: 18 }}
        />
        <Button type="submit">{t("miniapp.catalog.searchButton")}</Button>
      </form>
      <div role="group" aria-label={t("miniapp.catalog.map")} style={{ display: "flex", gap: 6 }}>
        {(["list", "map"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className="kosiv-toggle"
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {t(`miniapp.catalog.${v}`)}
          </button>
        ))}
      </div>
      {/* Постоянная live-область: читалки объявляют изменение числа результатов. */}
      {locationCaption && (
        <p className="kosiv-muted" data-testid="location-caption">
          {locationCaption}
        </p>
      )}
      <p role="status" data-testid="catalog-count" className="kosiv-muted" style={{ fontSize: "0.875rem" }}>
        {places.status === "ready" && places.data.list.length > 0
          ? t("miniapp.catalog.results", { count: places.data.list.length })
          : ""}
      </p>
      <AsyncView state={places} retry={retry}>
        {({ list }) =>
          list.length === 0 ? (
            <div className="kosiv-card kosiv-empty">
              {ICONS.search}
              <p data-testid="catalog-empty">{t("miniapp.catalog.empty")}</p>
              {(q || categoryId !== rootId) && (
                <Button
                  onClick={() => {
                    setDraft("");
                    setQ("");
                    setCategoryId(rootId);
                  }}
                >
                  {t("miniapp.catalog.reset")}
                </Button>
              )}
            </div>
          ) : (
            <Stack>
              {view === "map" && <MapSlot places={list} center={point} centerLabel={base?.name} />}
              <PlaceList places={list} />
            </Stack>
          )
        }
      </AsyncView>
    </Stack>
  );
}

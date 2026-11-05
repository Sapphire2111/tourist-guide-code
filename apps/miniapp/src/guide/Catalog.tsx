// C04: раздел главной → корневая категория и её подкатегории, поиск по названию, список/карта.
// Порядок выдачи задаёт сервер (релевантность, реклама — по правилам C-02); клиент только помечает рекламу.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { ICONS } from "../design/Ornament.js";
import { AmenityFilter } from "./AmenityFilter.js";
import { useBackStep, useScreenState } from "../screen-state.js";
import { loadCategories } from "./categories.js";
import { useAsync, useGuide } from "./context.js";
import { GPS_RADIUS, searchAround, useLocationCaption, useLocations } from "./LocationProvider.js";
import { MapSlot } from "./MapSlot.js";
import { DEVICE_MAX_ZOOM, RADIUS_DEBOUNCE_MS } from "./Nearby.js";
import { SubcategorySelect } from "./SubcategorySelect.js";
import { AsyncView, PlaceList, claimHref } from "./parts.js";
import { RadiusSlider } from "./RadiusSlider.js";
import type { LatLng } from "./geo.js";
import type { CatalogSection, Category, LocalityOption } from "./types.js";

/**
 * Поиск мест по всему региону или выбранным локациям (#/search?q=…): быстрые запросы сезона, «Усі місця».
 * claim (#/search?claim=1, из анкеты партнёра): «Знайдіть свій заклад» — нажатие на место открывает заявку
 * «Це мій заклад?» вместо карточки; карта скрыта (маркеры ведут в карточку).
 */
export function PlaceSearch({
  initialQuery = "",
  claim = false,
}: {
  initialQuery?: string;
  claim?: boolean;
}) {
  const { t } = useT();
  return (
    <Stack>
      <h1>{t(claim ? "miniapp.search.claimTitle" : "miniapp.search.title")}</h1>
      {claim && (
        <p className="kosiv-muted" data-testid="search-claim-hint" style={{ margin: 0 }}>
          {t("miniapp.search.claimHint")}
        </p>
      )}
      <CategoryPlaces root={null} subcategories={[]} initialQuery={initialQuery} claim={claim} />
    </Stack>
  );
}

export function Catalog({ section }: { section: CatalogSection }) {
  const { t } = useT();
  const { api } = useGuide();
  const [categories, retry] = useAsync(() => loadCategories(api), [api]);
  return (
    <Stack>
      {/* «Пам'ятки» (#/section/nearby) — свой заголовок: miniapp.section.nearby («Що поруч») — у карты и «Поруч». */}
      <h1>
        {t(
          section === "nearby" ? "miniapp.catalog.sightsTitle" : (`miniapp.section.${section}` as MessageKey),
        )}
      </h1>
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

/** Середина центров выбранных пунктов (у которых есть координаты); нет ни одной — null. */
export function selectedCenter(options: LocalityOption[] | null, selected: readonly string[]): LatLng | null {
  const points = (options ?? []).filter((o) => selected.includes(o.id) && o.location).map((o) => o.location!);
  if (points.length === 0) return null;
  return {
    lat: points.reduce((a, p) => a + p.lat, 0) / points.length,
    lng: points.reduce((a, p) => a + p.lng, 0) / points.length,
  };
}

/** Центр карты каталога: GPS, иначе середина выбранных локаций, QR — только если ничего не выбрано. */
export function resolveMapCenter(
  gps: LatLng | null,
  options: LocalityOption[] | null,
  selected: readonly string[],
  qr: LatLng | null,
): LatLng | null {
  if (gps) return gps;
  return selected.length > 0 ? selectedCenter(options, selected) : qr;
}

function CategoryPlaces({
  root,
  subcategories,
  initialQuery = "",
  claim = false,
}: {
  /** null — поиск без категории (весь каталог). */
  root: Category | null;
  subcategories: Category[];
  initialQuery?: string;
  /** Выбор своего заведения для заявки партнёра: только список, ссылки — на заявку. */
  claim?: boolean;
}) {
  const { t, locale } = useT();
  const { api, analytics, base } = useGuide();
  const { selected: localityIds, gps, setSheetOpen, options: localityOptions } = useLocations();
  const locationCaption = useLocationCaption();
  const rootId = root?.id;
  // Подраздел, запрос и вид — за записью истории: «Назад» из карточки места возвращает их как были.
  const [savedCategory, setCategoryId] = useScreenState("catalog.category", rootId);
  // Подраздел мог исчезнуть из справочника (другой регион после скана QR, правка каталога) — раздел целиком.
  const categoryId =
    savedCategory === rootId || subcategories.some((c) => c.id === savedCategory) ? savedCategory : rootId;
  // Подраздел — ступень «Назад»: сначала к разделу целиком, затем с экрана.
  useBackStep(categoryId !== rootId, () => setCategoryId(rootId));
  const [draft, setDraft] = useScreenState("catalog.draft", initialQuery);
  const [q, setQ] = useScreenState("catalog.q", initialQuery.trim().length >= 2 ? initialQuery.trim() : "");
  // «Де жити» — карта главная (все места ночёвки сразу на карте, до STAY_MAP_MAX), список вторичен.
  const mapFirst = root?.homeSection === "stay";
  const [savedView, setView] = useScreenState<"list" | "map">("catalog.view", mapFirst ? "map" : "list");
  const view = claim ? "list" : savedView;
  // Удобства «Де жити» (басейн, сауна…): только места со всеми отмеченными; в других разделах фильтра нет.
  const [amenities, setAmenities] = useScreenState<string[]>("catalog.amenities", []);
  const activeAmenities = mapFirst ? amenities : [];
  const amenityKey = activeAmenities.join(",");
  // Выбраны локации — все места этих пунктов; базовая точка QR остаётся для расстояния и порядка (api без радиуса).
  const byLocation = localityIds.length > 0;
  const point = gps ?? base?.point ?? null;
  // Радиус: null — как раньше (GPS: 3 км, при малом числе мест расширяется до 10 км; QR-точка: без радиуса).
  // Ползунок есть, когда есть точка и не выбраны локации; выбор запоминается за записью истории.
  // "all" — явно «Усі місця» (без радиуса).
  const [radius, setRadius] = useScreenState<number | "all" | null>("catalog.radius", null);
  const canRadius = !byLocation && point !== null;
  const [queryRadius, setQueryRadius] = useState<number | "all" | null>(radius);
  useEffect(() => {
    if (radius === queryRadius) return;
    const timer = window.setTimeout(() => setQueryRadius(radius), RADIUS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [radius, queryRadius]);
  const activeRadius = canRadius ? queryRadius : null;
  const radiusNumber = typeof activeRadius === "number" ? activeRadius : null;
  // Фактический радиус GPS-выдачи (3 или 10 км): держим последний, пока грузится новый ответ или он не пришёл.
  const usedRadius = useRef<number>(GPS_RADIUS);
  // Центр карты: GPS, иначе выбранные локации (середина их центров), QR — только если ничего не выбрано.
  // Объект стабилен между рендерами (ввод в поиске не должен пересоздавать маркеры карты).
  const qrPoint = base?.point ?? null;
  const mapCenter = useMemo(
    () => resolveMapCenter(gps, localityOptions, localityIds, qrPoint),
    [gps, localityOptions, localityIds, qrPoint],
  );
  const mapCenterLabel = gps ? t("miniapp.map.me") : byLocation ? undefined : base?.name;
  // Номер отправки формы поиска: search_used — один раз на ответ именно этой отправки (не при повторе,
  // смене категории/базовой точки или отменённой загрузке). Текст запроса не отправляется (ПДн-риск).
  const [submitId, setSubmitId] = useScreenState("catalog.submit", 0);
  const pendingSubmit = useRef<number | null>(null);
  const [places, retry] = useAsync(
    (signal) =>
      // Базовая точка ещё грузится — ждём её (пришла — эффект перезапустится с точкой), но не дольше
      // BASE_WAIT_MS: завис запрос точки — ищем без неё.
      (base?.pending ? new Promise((r) => setTimeout(r, BASE_WAIT_MS)) : Promise.resolve())
        .then(async () => {
          let partial = null as "failed" | "truncated" | null;
          const params = {
            categoryId,
            q: q || undefined,
            ...(byLocation ? { localityIds } : {}),
            ...(activeAmenities.length ? { tags: activeAmenities } : {}),
            ...(mapFirst
              ? {
                  max: STAY_MAP_MAX,
                  signal,
                  onPartial: (reason: "failed" | "truncated") => {
                    if (partial !== "failed") partial = reason;
                  },
                }
              : {}),
          };
          if (!gps)
            return {
              list: await api.search({ ...params, point, ...(radiusNumber ? { radius: radiusNumber } : {}) }),
              regionWide: false,
              partial,
              used: radiusNumber,
              scope: { point, ...(radiusNumber ? { radius: radiusNumber } : {}) },
            };
          // Явный радиус отключает расширение до 10 км; «Усі місця» — без радиуса; по умолчанию — 3 км с расширением.
          const near =
            activeRadius === null
              ? await searchAround(api.search, params, gps)
              : {
                  list: await api.search({
                    ...params,
                    point: gps,
                    ...(radiusNumber ? { radius: radiusNumber } : {}),
                  }),
                  radius: radiusNumber,
                };
          // Текстовый запрос не нашёл ничего рядом (до 10 км) — ищем по региону, с пометкой.
          if (q && near.list.length === 0)
            return {
              list: await api.search({ ...params, point: gps }),
              regionWide: true,
              partial,
              used: null,
              scope: { point: gps },
            };
          return {
            list: near.list,
            regionWide: false,
            partial,
            used: near.radius,
            scope: { point: gps, ...(near.radius ? { radius: near.radius } : {}) },
          };
        })
        // scope — точка и радиус, с которыми получен список: по ним же считаются счётчики удобств.
        .then(({ list, regionWide, partial, used, scope }) => ({
          list,
          regionWide,
          partial,
          used,
          scope: scope as { point: LatLng | null; radius?: number },
          submitId,
        })),

    [
      api,
      categoryId,
      q,
      submitId,
      base?.pending,
      point?.lat,
      point?.lng,
      localityIds,
      gps,
      activeRadius,
      amenityKey,
    ],
    {
      slot: "catalog.places",
      key: JSON.stringify([
        categoryId,
        q,
        submitId,
        base?.pending,
        point,
        localityIds,
        gps,
        activeRadius,
        amenityKey,
      ]),
    },
  );
  // Счётчики удобств — после первого открытия листа, с теми же фильтрами, что у показанного списка (раздел, текст,
  // локации, точка и радиус), без учёта отметок удобств; сбой — без счётчиков.
  const [countsWanted, setCountsWanted] = useState(false);
  const countsQuery =
    places.status === "ready"
      ? {
          categoryId,
          q: q || undefined,
          ...(byLocation ? { localityIds } : {}),
          ...places.data.scope,
        }
      : null;
  const countsKey = countsQuery ? JSON.stringify(countsQuery) : null;
  const [amenityCounts, setAmenityCounts] = useState<{ key: string; data: Record<string, number> } | null>(
    null,
  );
  const countsFor = useRef<string | null>(null);
  useEffect(() => {
    // Пока список перезагружается (смена отметок), ключ пропадает и возвращается — тот же ключ не перезапрашиваем.
    if (!countsWanted || !api.tagCounts || !countsQuery || !countsKey || countsFor.current === countsKey)
      return;
    countsFor.current = countsKey;
    // Ответ хранится со своим ключом: устаревший не показывается (лист сверяет ключ), отменять не нужно.
    api
      .tagCounts(countsQuery)
      .then((data) => setAmenityCounts({ key: countsKey, data }))
      .catch(() => {
        if (countsFor.current === countsKey) countsFor.current = null;
      });
    // countsQuery — по ключу (объект новый на каждом рендере).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, countsWanted, countsKey]);
  if (places.status === "ready" && places.data.used) usedRadius.current = places.data.used;
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
      {((subcategories.length > 0 && root) || mapFirst) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {subcategories.length > 0 && root && (
            <SubcategorySelect
              title={t("miniapp.catalog.subcategories")}
              options={[root, ...subcategories].map((c) => ({
                id: c.id,
                label: c.id === root.id ? t("miniapp.subcategory.all") : pickLocalized(c.name, locale),
              }))}
              value={categoryId ?? root.id}
              onChange={setCategoryId}
            />
          )}
          {mapFirst && (
            <AmenityFilter
              value={amenities}
              onChange={setAmenities}
              // Пока список перезагружается — прежние счётчики (строки листа не прыгают под пальцем).
              counts={amenityCounts?.data ?? null}
              onOpen={() => setCountsWanted(true)}
            />
          )}
        </div>
      )}
      {subcategories.find((c) => c.id === categoryId)?.code === "peaks" && (
        // Подраздел «Вершини»: свой экран со сложностью, высотой и маршрутом (#/peaks).
        <Link to="/peaks" className="kosiv-action" data-variant="ghost" data-testid="catalog-peaks">
          <span aria-hidden="true">🏔️ </span>
          {t("miniapp.peaks.link")}
        </Link>
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
      {!claim && (
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
      )}
      {canRadius && (
        <RadiusSlider
          // По умолчанию с GPS — фактически использованный радиус (3 км или 10 км после расширения).
          value={radius === null ? (gps ? usedRadius.current : null) : radius === "all" ? null : radius}
          allowAll
          onChange={(m) => setRadius(m === null ? "all" : m)}
        />
      )}
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
      {places.status === "ready" && places.data.regionWide && (
        <p className="kosiv-muted" data-testid="catalog-region-wide">
          {t("miniapp.catalog.regionWide")}
        </p>
      )}
      {places.status === "ready" && places.data.partial && (
        <p className="kosiv-muted" role="note" data-testid="catalog-partial">
          {places.data.partial === "failed"
            ? t("miniapp.catalog.partial")
            : t("miniapp.catalog.truncated", { count: STAY_MAP_MAX })}
        </p>
      )}
      <AsyncView state={places} retry={retry}>
        {({ list }) =>
          list.length === 0 ? (
            <div className="kosiv-card kosiv-empty">
              {ICONS.search}
              <p data-testid="catalog-empty">{t("miniapp.catalog.empty")}</p>
              {gps && (
                <Button onClick={() => setSheetOpen(true)} data-testid="catalog-change-location">
                  {t("miniapp.location.change")}
                </Button>
              )}
              {(q || categoryId !== rootId || activeAmenities.length > 0) && (
                <Button
                  onClick={() => {
                    setDraft("");
                    setQ("");
                    setCategoryId(rootId);
                    setAmenities([]);
                  }}
                >
                  {t("miniapp.catalog.reset")}
                </Button>
              )}
            </div>
          ) : (
            <Stack>
              {view === "map" && (
                <MapSlot
                  places={list}
                  center={mapCenter}
                  centerLabel={mapCenterLabel}
                  centerMarker={!byLocation || !!gps}
                  // По геолокации не приближаем карту до двора туриста (как «Що поруч»).
                  maxZoom={gps ? DEVICE_MAX_ZOOM : undefined}
                  radius={radiusNumber ?? (gps && radius === null ? usedRadius.current : undefined)}
                />
              )}
              <PlaceList places={list} hrefOf={claim ? claimHref : undefined} />
            </Stack>
          )
        }
      </AsyncView>
    </Stack>
  );
}

import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ApiError, toLocalized } from "../../common/http/index.js";
import {
  currentDb,
  currentTenant,
  InjectDb,
  regionContext,
  withTenant,
  type Db,
  type JsonObject,
  type LocalizedText,
  type LonLat,
  type PlanSlot,
  type Region,
  type Scenario,
  type ScenarioItem,
  type ScenarioStatus,
  type UserPlan,
  type UserPlanItemRecord,
} from "../../db/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import { FeatureFlagsService } from "../feature-flags/index.js";
import { RegionsRepository } from "../regions/index.js";
import {
  HIKE_RELEVANT,
  hikeUnsafe,
  toDayDto,
  WeatherService,
  type WeatherSource,
  type WeatherWarning,
} from "../weather/index.js";
import type {
  AdminScenarioDetailDto,
  AdminScenarioDto,
  AdminScenarioListDto,
  CreateUserPlanDto,
  PlanDayOptionsDto,
  PlanDayWeatherDto,
  PlanPlaceDto,
  PlanTripDto,
  ScenarioDto,
  ScenarioInputDto,
  ScenarioItemDto,
  ScenarioListDto,
  ScenarioSummaryDto,
  ScenarioTag,
  UpdateUserPlanDto,
  UserPlanDto,
  UserPlanListDto,
} from "./planner.dto.js";
import { USER_PLANS_MAX } from "./planner.dto.js";
import { isMountainHike, itemSlots, planOptions, slotRank, type CatalogPlace } from "./plan-options.js";
import {
  addItem,
  planItemsFromScenario,
  removeItem,
  replaceItem,
  sphericalMeters,
  trimDays,
  type PlanEditError,
} from "./plan-rules.js";
import {
  PlannerRepository,
  type CatalogPlaceRow,
  type PlanPlaceRow,
  type PlanTripWrite,
} from "./planner.repository.js";

/** Название своего плана (без сценария-основы). */
const CUSTOM_PLAN_TITLE: LocalizedText = { uk: "Мій план", en: "My plan" };
/** Каталог региона для вариантов кэшируется на процесс: правки админки видны не позже чем через минуту. */
const CATALOG_TTL_MS = 60_000;
/** Предел выборки каталога (repo.catalogPlaces): достигнут — в лог, варианты из первых по id. */
export const CATALOG_LIMIT = 5000;

export const SCENARIO_ENTITY = "scenario";
export const SCENARIO_AUDIT = {
  create: "scenario.create",
  update: "scenario.update",
  status: "scenario.status",
} as const;

type AuditMeta = Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">;

/** Пункт для показа: общее у пункта сценария и пункта плана. */
type ViewItem = {
  id: string;
  dayNo: number;
  position: number;
  placeId: string;
  timeHint: string | null;
  durationMin: number | null;
  note: LocalizedText | null;
  alternatives: readonly string[];
  slot?: PlanSlot;
};

const hhmm = (t: string | null) => (t === null ? null : t.slice(0, 5));

/** Горных пунктов плана, для которых берётся прогноз у их точки, не больше (остальные — по базовой точке). */
const MOUNTAIN_ITEMS_MAX = 8;

/** Погода плана: по дням, дни без гор, предупреждения пунктов-походов. */
type PlanWeather = {
  days: PlanDayWeatherDto[];
  noMountainDays: Set<number>;
  items: Map<string, WeatherWarning[]>;
  source: WeatherSource | null;
};
const NO_WEATHER = (): PlanWeather => ({
  days: [],
  noMountainDays: new Set(),
  items: new Map(),
  source: null,
});

/**
 * Планировщик «Мій план» (блок 5; C09, S-04; D-53; ADR-0020): сценарии региона без AI (фильтр по тегу и дням),
 * план пользователя — копия пунктов с заменами. Турист видит только опубликованные сценарии; пункт с неопубликованным
 * местом — «Недоступно», альтернативы — только опубликованные места.
 */
@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);
  private readonly catalogCache = new Map<string, { at: number; rows: CatalogPlaceRow[] }>();

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PlannerRepository) private readonly repo: PlannerRepository,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    // Погода (module.weather): нет модуля (тесты) — план без погоды.
    @Optional() @Inject(WeatherService) private readonly weather?: WeatherService,
    @Optional() @Inject(FeatureFlagsService) private readonly flags?: FeatureFlagsService,
  ) {}

  // --- турист ---

  async scenarios(regionId: string, filter: { tag?: ScenarioTag; days?: number }): Promise<ScenarioListDto> {
    return this.inRegion(regionId, async () => {
      const rows = await this.repo.listScenarios({ status: "published", ...filter });
      const items = await this.repo.items(rows.map((r) => r.id));
      const places = await this.placeMap(items.map((i) => i.place_id));
      return {
        items: rows.map((s) =>
          summary(
            s,
            items.filter((i) => i.scenario_id === s.id && places.get(i.place_id)?.status === "published")
              .length,
          ),
        ),
      };
    });
  }

  async scenario(regionId: string, id: string): Promise<ScenarioDto> {
    return this.inRegion(regionId, async () => {
      const s = await this.repo.findScenario(id);
      if (s?.status !== "published") throw new ApiError("NOT_FOUND");
      const items = (await this.repo.items([s.id])).map(fromScenarioItem);
      const days = await this.view(items);
      return {
        ...summary(s, countAvailable(days)),
        version: s.version,
        plan: days.map((d) => ({ dayNo: d.dayNo, items: d.items.map(({ source: _s, ...dto }) => dto) })),
      };
    });
  }

  async plans(regionId: string, userId: string): Promise<UserPlanListDto> {
    return this.inRegion(regionId, async () => {
      const rows = await this.repo.listPlans(userId, USER_PLANS_MAX);
      return { items: await this.planDtos(rows) };
    });
  }

  async plan(regionId: string, userId: string, id: string): Promise<UserPlanDto> {
    return this.inRegion(regionId, async (region) => {
      const row = await this.repo.findPlan(userId, id);
      if (!row) throw new ApiError("NOT_FOUND");
      return (await this.planDtos([row], await this.catalog(region.id)))[0]!;
    });
  }

  /**
   * «Зберегти план»: копия опубликованного сценария или свой план без основы (варианты на выбор по параметрам);
   * планов в регионе — не больше USER_PLANS_MAX (409).
   */
  async createPlan(userId: string, input: CreateUserPlanDto): Promise<UserPlanDto> {
    return this.inRegion(input.regionId, async (region) => {
      const s = input.scenarioId ? await this.repo.findScenario(input.scenarioId) : null;
      if (s !== null && s?.status !== "published") throw new ApiError("NOT_FOUND");
      // Гонка двух одновременных POST может дать USER_PLANS_MAX + 1 план — принято: лимит защищает от разрастания,
      // а не инвариант данных (блокировку строки пользователя ради этого не берём).
      if ((await this.repo.countPlans(userId)) >= USER_PLANS_MAX)
        throw new ApiError("CONFLICT", {
          messageKey: "errors.plan.limitReached",
          details: { reason: "plans_limit", limit: USER_PLANS_MAX },
        });
      // База из QR могла устареть (место снято с публикации) — план всё равно создаётся, без базы.
      const trip = await this.tripWrite(input, false);
      const days = trip.days ?? s?.days ?? 1;
      const items = s ? trimDays(planItemsFromScenario(await this.repo.items([s.id])), days) : [];
      const row = await this.repo.createPlan({
        user_id: userId,
        scenario_id: s?.id ?? null,
        scenario_version: s?.version ?? null,
        title_i18n: s?.title_i18n ?? CUSTOM_PLAN_TITLE,
        start_date: input.startDate ?? null,
        items,
        ...trip,
        days,
      });
      return (await this.planDtos([row], await this.catalog(region.id)))[0]!;
    });
  }

  async updatePlan(userId: string, id: string, input: UpdateUserPlanDto): Promise<UserPlanDto> {
    return this.inRegion(input.regionId, async (region) => {
      // Каталог — до блокировки строки плана (FOR UPDATE держится до конца транзакции).
      const catalog = await this.catalog(region.id);
      const row = await this.repo.findPlan(userId, id, true);
      if (!row) throw new ApiError("NOT_FOUND");
      let items: UserPlanItemRecord[] = row.items;
      const trip = await this.tripWrite(input, true);
      if (trip.days !== undefined && trip.days !== null) items = trimDays(items, trip.days);
      if (input.addItem) {
        const days = trip.days ?? planDays(row);
        if (input.addItem.dayNo > days) throw planError("day_out_of_range");
        const target = await this.placeMap([input.addItem.placeId]);
        if (target.get(input.addItem.placeId.toLowerCase())?.status !== "published")
          throw planError("place_unavailable");
        items = orFail(addItem(items, input.addItem));
      }
      if (input.replaceItem) {
        const target = await this.placeMap([input.replaceItem.placeId]);
        if (target.get(input.replaceItem.placeId.toLowerCase())?.status !== "published")
          throw planError("not_alternative");
        items = orFail(replaceItem(items, input.replaceItem.itemId, input.replaceItem.placeId));
      }
      if (input.removeItemId) items = orFail(removeItem(items, input.removeItemId));
      const updated = await this.repo.updatePlan(row.id, {
        start_date: input.startDate,
        items: items === row.items ? undefined : items,
        ...trip,
      });
      return (await this.planDtos([updated ?? row], catalog))[0]!;
    });
  }

  async deletePlan(regionId: string, userId: string, id: string): Promise<void> {
    await this.inRegion(regionId, async () => {
      if (!(await this.repo.deletePlan(userId, id))) throw new ApiError("NOT_FOUND");
    });
  }

  // --- админка (tenant-контекст запроса) ---

  async adminList(status?: ScenarioStatus): Promise<AdminScenarioListDto> {
    const rows = await this.repo.listScenarios({ status });
    const counts = await this.repo.itemCounts(rows.map((r) => r.id));
    return { items: rows.map((r) => adminDto(r, counts.get(r.id) ?? 0)) };
  }

  async adminGet(id: string): Promise<AdminScenarioDetailDto> {
    const s = await this.repo.findScenario(id);
    if (!s) throw new ApiError("NOT_FOUND");
    return this.adminDetail(s);
  }

  async adminCreate(
    regionId: string,
    input: ScenarioInputDto,
    meta: AuditMeta,
  ): Promise<AdminScenarioDetailDto> {
    if (requireRegion() !== regionId) throw new ApiError("FORBIDDEN");
    await this.checkPlaces(input);
    const s = await this.repo
      .createScenario(scenarioWrite(input), meta.actor.type === "user" ? meta.actor.userId : null)
      .catch(codeTaken);
    if (s.region_id !== regionId) throw new Error("Сценарий создан не в регионе запроса");
    await this.repo.replaceItems(s.id, itemsWrite(input));
    await this.record(meta, SCENARIO_AUDIT.create, s, null, { code: s.code, items: input.items.length });
    return this.adminDetail(s);
  }

  /** Полная замена (с пунктами); версия растёт — сохранённые планы видят «сценарий обновлён». */
  async adminUpdate(id: string, input: ScenarioInputDto, meta: AuditMeta): Promise<AdminScenarioDetailDto> {
    requireRegion();
    const before = await this.repo.findScenario(id);
    if (!before) throw new ApiError("NOT_FOUND");
    await this.checkPlaces(input);
    const s = await this.repo.updateScenario(id, scenarioWrite(input)).catch(codeTaken);
    if (!s) throw new ApiError("NOT_FOUND");
    await this.repo.replaceItems(s.id, itemsWrite(input));
    await this.record(
      meta,
      SCENARIO_AUDIT.update,
      s,
      { code: before.code, version: before.version },
      { code: s.code, version: s.version, items: input.items.length },
    );
    return this.adminDetail(s);
  }

  async adminSetStatus(id: string, status: ScenarioStatus, meta: AuditMeta): Promise<AdminScenarioDetailDto> {
    requireRegion();
    const before = await this.repo.findScenario(id);
    if (!before) throw new ApiError("NOT_FOUND");
    if (before.status === status) return this.adminDetail(before);
    if (status === "published") {
      // Публикуется только сценарий с хотя бы одним опубликованным местом.
      const items = await this.repo.items([id]);
      const places = await this.placeMap(items.map((i) => i.place_id));
      if (!items.some((i) => places.get(i.place_id)?.status === "published"))
        throw new ApiError("UNPROCESSABLE", {
          messageKey: "errors.scenario.notPublishable",
          details: { reason: "no_published_places" },
        });
    }
    const s = await this.repo.setStatus(id, status);
    if (!s) throw new ApiError("NOT_FOUND");
    await this.record(meta, SCENARIO_AUDIT.status, s, { status: before.status }, { status });
    return this.adminDetail(s);
  }

  // --- внутреннее ---

  private async adminDetail(s: Scenario): Promise<AdminScenarioDetailDto> {
    const items = await this.repo.items([s.id]);
    const places = await this.adminPlaces(items.map((i) => i.place_id));
    return {
      ...adminDto(s, items.length),
      items: items.map((i) => ({
        id: i.id,
        dayNo: i.day_no,
        position: i.position,
        placeId: i.place_id,
        placeName: places.get(i.place_id)?.name_i18n ?? null,
        placeStatus: places.get(i.place_id)?.status ?? null,
        timeHint: hhmm(i.time_hint),
        durationMin: i.duration_min,
        note: i.note_i18n,
        alternatives: i.alternatives,
      })),
    };
  }

  /** Места региона по id с их статусом в админке (не туристский «published/unavailable»). */
  private async adminPlaces(ids: readonly string[]) {
    const rows = ids.length
      ? await currentDb(this.db)
          .selectFrom("places")
          .select(["id", "name_i18n", "status"])
          .where("id", "in", [...new Set(ids)])
          .execute()
      : [];
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Все места пунктов и альтернатив — места региона запроса (иначе 422). */
  private async checkPlaces(input: ScenarioInputDto): Promise<void> {
    const ids = [
      ...new Set(
        input.items.flatMap((i) => [i.placeId, ...(i.alternatives ?? [])]).map((id) => id.toLowerCase()),
      ),
    ];
    const found = await this.adminPlaces(ids);
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length)
      throw new ApiError("UNPROCESSABLE", {
        messageKey: "errors.catalog.invalidReference",
        details: { reason: "unknown_place", placeIds: missing },
      });
    for (const i of input.items)
      if (i.dayNo > input.days)
        throw new ApiError("VALIDATION_FAILED", {
          details: { fields: [{ field: "items", constraint: "dayNo", messageKey: "errors.validation" }] },
        });
  }

  private async record(
    meta: AuditMeta,
    action: string,
    s: Scenario,
    oldValues: JsonObject | null,
    newValues: JsonObject | null,
  ): Promise<void> {
    await this.audit.record(currentDb(this.db), {
      ...meta,
      action,
      entityType: SCENARIO_ENTITY,
      entityId: s.id,
      oldValues,
      newValues,
      regionId: s.region_id,
    });
  }

  private async placeMap(ids: readonly string[]): Promise<Map<string, PlanPlaceRow>> {
    const rows = await this.repo.places(ids.map((id) => id.toLowerCase()));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Пункты → дни с местами, альтернативами и расстояниями (только опубликованные места видны туристу). */
  private async view<T extends ViewItem>(
    items: readonly T[],
  ): Promise<{ dayNo: number; items: (ScenarioItemDto & { source: T })[] }[]> {
    const places = await this.placeMap(items.flatMap((i) => [i.placeId, ...i.alternatives]));
    const visible = (id: string): PlanPlaceDto | null => {
      const p = places.get(id);
      return p?.status === "published" && p.location ? toPlace(p) : null;
    };
    const days = new Map<number, (ScenarioItemDto & { source: T })[]>();
    // Порядок дня — части дня (ранок → вечір, затем «якщо дощ»), внутри — позиция; у пунктов сценария часть дня не
    // убывает по позиции (itemSlots), их порядок не меняется. Расстояние — от предыдущего пункта дня, у запасного
    // плана «якщо дощ» — между его пунктами.
    const slots = itemSlots(items);
    const slot = (i: { id: string }) => slots.get(i.id) ?? "afternoon";
    for (const i of [...items].sort(
      (a, b) => a.dayNo - b.dayNo || slotRank(slot(a)) - slotRank(slot(b)) || a.position - b.position,
    )) {
      const list = days.get(i.dayNo) ?? [];
      const place = visible(i.placeId);
      const rain = slot(i) === "rain";
      const prev = [...list].reverse().find((x) => x.place !== null && (x.slot === "rain") === rain);
      list.push({
        slot: slot(i),
        id: i.id,
        position: i.position,
        timeHint: i.timeHint,
        durationMin: i.durationMin,
        note: i.note,
        place,
        available: place !== null,
        alternatives: i.alternatives.flatMap((a) => {
          const p = visible(a);
          return p ? [p] : [];
        }),
        distanceFromPreviousMeters:
          place && prev?.place ? sphericalMeters(prev.place.location, place.location) : null,
        source: i,
      });
      days.set(i.dayNo, list);
    }
    return [...days.entries()].map(([dayNo, list]) => ({ dayNo, items: list }));
  }

  /** Планы для ответа; withOptions — с вариантами на выбор (один план: GET по id, POST, PATCH). */
  private async planDtos(
    rows: readonly UserPlan[],
    catalog: readonly CatalogPlaceRow[] | null = null,
  ): Promise<UserPlanDto[]> {
    const withOptions = catalog !== null;
    const versions = await this.repo.scenarioVersions(
      rows.flatMap((r) => (r.scenario_id ? [r.scenario_id] : [])),
    );
    // Базовые места всех планов — одним запросом.
    const bases = await this.placeMap(rows.flatMap((r) => (r.base_place_id ? [r.base_place_id] : [])));
    const out: UserPlanDto[] = [];
    for (const r of rows) {
      const view = new Map((await this.view(r.items)).map((d) => [d.dayNo, d.items]));
      const n = planDays(r);
      const days = Array.from({ length: n }, (_, k) => ({ dayNo: k + 1, items: view.get(k + 1) ?? [] }));
      const { trip, baseAt } = await this.trip(r, bases, withOptions);
      const wx = catalog ? await this.planWeather(r, baseAt, days, catalog) : NO_WEATHER();
      out.push({
        id: r.id,
        regionId: r.region_id,
        scenarioId: r.scenario_id,
        scenarioVersion: r.scenario_version,
        scenarioUpdated:
          r.scenario_id !== null &&
          r.scenario_version !== null &&
          (versions.get(r.scenario_id) ?? r.scenario_version) > r.scenario_version,
        title: r.title_i18n,
        startDate: r.start_date === null ? null : dateOnly(r.start_date),
        trip,
        plan: days.map((d) => ({
          dayNo: d.dayNo,
          items: d.items.map(({ source, ...dto }) => ({
            ...dto,
            replaced: source.replacedPlaceId !== null,
            weatherWarnings: wx.items.get(dto.id) ?? [],
          })),
        })),
        options: catalog ? optionsDto(days, catalog, trip, baseAt, wx.noMountainDays) : [],
        weather: wx.days,
        weatherSource: wx.source,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      });
    }
    return out;
  }

  /**
   * Погода плана (module.weather): прогноз базовой точки на даты дней (startDate + dayNo − 1; без даты начала — нет).
   * Дни с опасной для гор погодой (гроза, ветер, снегопад, гололёд) — без горных походов в вариантах; выбранный
   * горный поход в такой день (или в мороз) — с предупреждением по прогнозу у его горной точки. Ошибки — без погоды.
   * Только снимки (WeatherService.snapshotAt): устаревшие точки обновятся в фоне после ответа (inRegion).
   */
  private async planWeather(
    r: UserPlan,
    baseAt: LonLat | null,
    days: readonly { dayNo: number; items: readonly (ScenarioItemDto & { source: ViewItem })[] }[],
    catalog: readonly CatalogPlaceRow[],
  ): Promise<PlanWeather> {
    const out = NO_WEATHER();
    if (!this.weather || !baseAt || r.start_date === null) return out;
    if (this.flags && !(await this.flags.isEnabled("module.weather", r.region_id))) return out;
    // Внутри транзакции региона (и под FOR UPDATE в updatePlan) — только готовые снимки, без сети.
    const f = await this.weather.snapshotAt({ lat: baseAt.lat, lng: baseAt.lon });
    if (!f) return out;
    out.source = f.source;
    const start = dateOnly(r.start_date);
    const dateOf = (dayNo: number) => addDays(start, dayNo - 1);
    for (const d of days) {
      const w = f.days.find((x) => x.date === dateOf(d.dayNo));
      if (!w) continue;
      const noMountains = hikeUnsafe(w);
      if (noMountains) out.noMountainDays.add(d.dayNo);
      out.days.push({ ...toDayDto(w), dayNo: d.dayNo, noMountains });
    }
    if (!out.days.length) return { ...out, source: null };
    const byId = new Map(catalog.map((p) => [p.id, p]));
    const hikes = days
      .filter((d) => out.days.some((w) => w.dayNo === d.dayNo))
      .flatMap((d) =>
        d.items.flatMap((i) => {
          const p = i.place && i.slot !== "rain" ? byId.get(i.place.id) : undefined;
          return p && i.place && isMountainHike(catalogPlace(p))
            ? [{ dayNo: d.dayNo, id: i.id, at: i.place.location }]
            : [];
        }),
      )
      .slice(0, MOUNTAIN_ITEMS_MAX);
    for (const h of hikes) {
      const local =
        (await this.weather.snapshotAt({ lat: h.at.lat, lng: h.at.lon }, { mountain: true })) ?? f;
      const w = local.days.find((x) => x.date === dateOf(h.dayNo));
      const warnings = (w?.warnings ?? []).filter((x) => HIKE_RELEVANT.includes(x));
      if (warnings.length) out.items.set(h.id, warnings);
    }
    return out;
  }

  /**
   * Параметры поездки из запроса → запись. Базовая точка — только опубликованное место региона: при правке (strict)
   * иначе 422, при создании — база просто не ставится.
   */
  private async tripWrite(
    input: CreateUserPlanDto | UpdateUserPlanDto,
    strict: boolean,
  ): Promise<PlanTripWrite> {
    let basePlaceId = input.basePlaceId;
    if (basePlaceId) {
      const base = await this.placeMap([basePlaceId]);
      if (base.get(basePlaceId.toLowerCase())?.status !== "published") {
        if (strict) throw planError("place_unavailable");
        basePlaceId = null;
      }
    }
    return {
      adults: input.adults,
      children: input.children,
      with_car: input.withCar,
      days: input.days,
      base_place_id: basePlaceId === undefined ? undefined : (basePlaceId?.toLowerCase() ?? null),
    };
  }

  /** Параметры для ответа и точка отсчёта вариантов: базовое место, иначе (для вариантов) первый населённый пункт. */
  private async trip(
    r: UserPlan,
    bases: ReadonlyMap<string, PlanPlaceRow>,
    withFallback: boolean,
  ): Promise<{ trip: PlanTripDto; baseAt: LonLat | null }> {
    const base: { trip: Omit<PlanTripDto, "base"> } = {
      trip: { adults: r.adults, children: r.children, withCar: r.with_car, days: planDays(r) },
    };
    if (r.base_place_id) {
      const p = bases.get(r.base_place_id);
      if (p?.status === "published" && p.location)
        return {
          trip: { ...base.trip, base: { kind: "place", placeId: p.id, name: p.name_i18n } },
          baseAt: p.location,
        };
    }
    if (withFallback) {
      const l = await this.repo.firstLocality();
      if (l?.location)
        return {
          trip: { ...base.trip, base: { kind: "locality", placeId: null, name: l.name_i18n } },
          baseAt: l.location,
        };
    }
    return { trip: { ...base.trip, base: null }, baseAt: null };
  }

  /** Каталог региона для вариантов: кэш на CATALOG_TTL_MS; предел выборки — предупреждение в лог. */
  private async catalog(regionId: string): Promise<CatalogPlaceRow[]> {
    const hit = this.catalogCache.get(regionId);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.rows;
    const rows = await this.repo.catalogPlaces(CATALOG_LIMIT);
    if (rows.length >= CATALOG_LIMIT)
      this.logger.warn(
        `Каталог региона ${regionId}: достигнут предел ${CATALOG_LIMIT} мест для вариантов «Мій план»`,
      );
    this.catalogCache.set(regionId, { at: Date.now(), rows });
    return rows;
  }

  private async inRegion<T>(regionId: string, fn: (region: Region) => Promise<T>): Promise<T> {
    const region = await this.regions.findById(regionId.toLowerCase());
    if (region?.status !== "active") throw new ApiError("NOT_FOUND");
    const out = await withTenant(this.db, regionContext(region.id), () => fn(region));
    // Транзакция региона закрыта: устаревшие снимки погоды, которые план отдал как есть, — обновить в фоне.
    this.weather?.flushRefresh();
    return out;
  }
}

/**
 * Изменения сценариев — только в контексте региона (SUPERADMIN без выбранного региона — 403): места пунктов
 * проверяются в регионе запроса, запись — в его регион.
 */
function requireRegion(): string {
  const tenant = currentTenant();
  if (tenant?.kind !== "region")
    throw new ApiError("FORBIDDEN", { details: { reason: "region_context_required" } });
  return tenant.regionId;
}

function fromScenarioItem(i: ScenarioItem): ViewItem & { replacedPlaceId: null } {
  return {
    id: i.id,
    dayNo: i.day_no,
    position: i.position,
    placeId: i.place_id,
    timeHint: hhmm(i.time_hint),
    durationMin: i.duration_min,
    note: i.note_i18n,
    alternatives: i.alternatives,
    replacedPlaceId: null,
  };
}

/** Дней в плане: сохранённое число, у планов до 0019 — по пунктам (не меньше 1). */
function planDays(r: Pick<UserPlan, "days" | "items">): number {
  return r.days ?? Math.max(1, ...r.items.map((i) => i.dayNo));
}

function catalogPlace(p: CatalogPlaceRow): CatalogPlace {
  return {
    id: p.id,
    category: p.category_code,
    extraCategories: p.extra_category_codes,
    names: Object.values(p.name_i18n).filter((v): v is string => typeof v === "string"),
    location: p.location,
    tags: p.tags,
    recommended: p.recommended,
  };
}

/** Варианты на выбор (plan-options.ts) → DTO с местами каталога. */
function optionsDto(
  days: readonly { dayNo: number; items: readonly (ScenarioItemDto & { source: ViewItem })[] }[],
  catalog: readonly CatalogPlaceRow[],
  trip: PlanTripDto,
  baseAt: LonLat | null,
  noMountainDays?: ReadonlySet<number>,
): PlanDayOptionsDto[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const chosen = days.flatMap((d) =>
    d.items.map((i) => ({
      dayNo: d.dayNo,
      slot: i.slot,
      placeId: i.source.placeId,
      location: i.place?.location ?? null,
    })),
  );
  return planOptions({
    days: trip.days,
    items: chosen,
    places: catalog.map(catalogPlace),
    trip: { children: trip.children, withCar: trip.withCar },
    base: baseAt,
    noMountainDays,
  }).map((d) => ({
    dayNo: d.dayNo,
    slots: d.slots.map((s) => ({
      slot: s.slot,
      options: s.options.map((o) => {
        const p = byId.get(o.placeId)!;
        return {
          place: {
            id: p.id,
            categoryId: p.category_id,
            name: p.name_i18n,
            address: p.address_i18n,
            location: p.location,
            categoryName: p.category_name,
          },
          kind: o.kind,
          reason: o.reason,
          distanceMeters: o.distanceMeters,
          travel: o.travel,
          travelMinutes: o.travelMinutes,
          kidsFriendly: o.kidsFriendly,
        };
      }),
    })),
  }));
}

function countAvailable(days: readonly { items: readonly { available: boolean }[] }[]): number {
  return days.reduce((n, d) => n + d.items.filter((i) => i.available).length, 0);
}

function summary(s: Scenario, itemCount: number): ScenarioSummaryDto {
  return {
    id: s.id,
    code: s.code,
    title: s.title_i18n,
    description: s.description_i18n,
    days: s.days,
    tags: s.tags as ScenarioTag[],
    adLabel: s.is_sponsored ? s.ad_label : null,
    itemCount,
  };
}

function adminDto(s: Scenario, itemCount: number): AdminScenarioDto {
  return {
    id: s.id,
    regionId: s.region_id,
    code: s.code,
    title: s.title_i18n,
    description: s.description_i18n,
    days: s.days,
    tags: s.tags as ScenarioTag[],
    status: s.status,
    version: s.version,
    adLabel: s.is_sponsored ? s.ad_label : null,
    sortOrder: s.sort_order,
    itemCount,
    updatedAt: s.updated_at.toISOString(),
  };
}

function toPlace(p: PlanPlaceRow): PlanPlaceDto {
  return {
    id: p.id,
    categoryId: p.category_id,
    name: p.name_i18n,
    address: p.address_i18n,
    location: p.location ?? { lon: 0, lat: 0 },
  };
}

function scenarioWrite(input: ScenarioInputDto) {
  return {
    code: input.code,
    title_i18n: toLocalized(input.title),
    description_i18n: input.description ? toLocalized(input.description) : null,
    days: input.days,
    tags: [...new Set(input.tags ?? [])],
    is_sponsored: Boolean(input.adLabel),
    ad_label: input.adLabel ?? null,
    sort_order: input.sortOrder ?? 0,
  };
}

/** Позиция — порядок в массиве внутри дня. */
function itemsWrite(input: ScenarioInputDto) {
  const pos = new Map<number, number>();
  return input.items.map((i) => {
    const position = pos.get(i.dayNo) ?? 0;
    pos.set(i.dayNo, position + 1);
    return {
      day_no: i.dayNo,
      position,
      place_id: i.placeId.toLowerCase(),
      time_hint: i.timeHint ?? null,
      duration_min: i.durationMin ?? null,
      note_i18n: i.note ? toLocalized(i.note) : null,
      alternatives: [...new Set((i.alternatives ?? []).map((a) => a.toLowerCase()))].filter(
        (a) => a !== i.placeId.toLowerCase(),
      ),
    };
  });
}

/** YYYY-MM-DD + n дней (календарно, без часового пояса). */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** pg отдаёт date как Date в часовом поясе процесса — берём местную дату объекта. */
function dateOnly(v: string | Date): string {
  if (typeof v === "string") return v.slice(0, 10);
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, "0");
  const d = String(v.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function planError(reason: PlanEditError): ApiError {
  switch (reason) {
    case "item_not_found":
      return new ApiError("NOT_FOUND", { messageKey: "errors.plan.itemNotFound", details: { reason } });
    case "already_in_plan":
      return new ApiError("CONFLICT", { messageKey: "errors.plan.alreadyInPlan", details: { reason } });
    case "place_unavailable":
      return new ApiError("UNPROCESSABLE", {
        messageKey: "errors.plan.placeUnavailable",
        details: { reason },
      });
    case "items_limit":
      return new ApiError("UNPROCESSABLE", { messageKey: "errors.plan.itemsLimit", details: { reason } });
    case "day_out_of_range":
      return new ApiError("UNPROCESSABLE", { messageKey: "errors.plan.dayOutOfRange", details: { reason } });
    default:
      return new ApiError("UNPROCESSABLE", { messageKey: "errors.plan.notAlternative", details: { reason } });
  }
}

function orFail(r: UserPlanItemRecord[] | PlanEditError): UserPlanItemRecord[] {
  if (typeof r === "string") throw planError(r);
  return r;
}

function codeTaken(e: unknown): never {
  const { code, constraint } = (e ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === "23505" && constraint === "scenarios_region_code_key")
    throw new ApiError("CONFLICT", {
      messageKey: "errors.catalog.codeTaken",
      details: { reason: "code_taken" },
    });
  throw e;
}

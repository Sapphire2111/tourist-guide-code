import { Inject, Injectable, Logger } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import type { LonLat } from "../../db/index.js";
import { GuideService, LOCALITY_ALIASES, localMoment, type PlaceSummaryDto } from "../guide/index.js";
import { RegionsRepository } from "../regions/index.js";
import type {
  AssistantNote,
  AssistantPlaceDto,
  AssistantPlanDto,
  AssistantResultDto,
  DescriptionSource,
} from "./assistant.dto.js";
import {
  AssistantRepository,
  type PlaceEnrichmentFacts,
  type PlaceRatingFacts,
} from "./assistant.repository.js";
import { AssistantBudget, BUDGET_UNITS } from "./budget.js";
import {
  intentRequest,
  parseIntent,
  toolInputOf,
  type AssistantIntent,
  type DayPart,
  type IntentCategory,
  type IntentLocality,
} from "./intent.js";
import { expandKeywords, keywordPattern } from "./keywords.js";
import { NOTES_TOOL, notesRequest, parseNotes, type NoteFacts } from "./plan-notes.js";
import {
  buildPlan,
  formatMinute,
  hasTimeToday,
  PLAN_SECTIONS,
  quality,
  startMinuteFrom,
  type PlanCandidate,
  type PlanDayInput,
} from "./plan.js";
import {
  ASSISTANT_LLM,
  ASSISTANT_SPEECH,
  AssistantUpstreamError,
  type AssistantLlm,
  type AssistantSpeech,
  type AudioMime,
} from "./providers.js";
import { orderRoute } from "./route.js";

/** Мест в ответе «places» (клиент показывает по 10 — «Показати ще»). */
export const ASSISTANT_PLACES_MAX = 30;
/** Остановок экскурсии. */
export const ASSISTANT_TOUR_STOPS = 6;
/** Радиус по умолчанию, когда точка туриста известна, а турист расстояния не назвал. */
export const ASSISTANT_RADIUS_DEFAULT = 5000;
/** Радиус плана отдыха по умолчанию (от жилья туриста или лучшей пам'ятки). */
export const PLAN_RADIUS_DEFAULT = 15_000;
/** Кандидатов на категорию до фильтров (цена, «з дітьми», «відкрито»). */
const CANDIDATES_PER_CATEGORY = 30;
/** Мест, найденных по ключевым словам, — не больше. */
const KEYWORD_CANDIDATES = 60;
/** Кандидатов плана на раздел каталога. */
const PLAN_CANDIDATES_PER_SECTION = 60;
/** Меньше стольких рядом — поиск по ключевым словам расширяется (если радиус не назвал турист). */
const WIDEN_BELOW = 3;
const DESCRIPTION_MAX = 320;
const NOTE_DESCRIPTION_MAX = 220;
const TIMEZONE_DEFAULT = "Europe/Kyiv";

export type AssistantQuery = {
  text: string;
  origin?: LonLat;
  history: readonly string[];
  previous: AssistantIntent | null;
  /** Населённые пункты, выбранные туристом (фильтр «Локація»); названный в запросе — главнее. */
  localityIds?: readonly string[];
};

/** Кандидатов на категорию и пункт при поиске в населённом пункте. */
const CANDIDATES_WITH_LOCALITY = 50;

type Enrichment = PlaceEnrichmentFacts;

/** Справочник категорий региона: код ↔ id, корень раздела, название. */
type Catalog = {
  /** Коды категорий с местами (их выбирает модель) → id. */
  idOf: ReadonlyMap<string, string>;
  /** Все активные категории: код → id (разделы плана). */
  anyIdOf: ReadonlyMap<string, string>;
  codeOf: ReadonlyMap<string, string>;
  /** id категории → id корня раздела. */
  rootOf: ReadonlyMap<string, string>;
  nameOf: ReadonlyMap<string, string>;
};

/** Поиск: где искать (пункты, радиус от точки) — общий для мест и плана. */
type Scope = { origin?: LonLat; localityIds: readonly string[] };

/** Начало текста до DESCRIPTION_MAX по границе предложения (иначе слова) — без обрыва посреди слова. */
export function shorten(text: string, max = DESCRIPTION_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max / 2) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\s]+$/, "")}…`;
}

/** Описание места для ответа: ИИ-текст карточки → Вікіпедія (со ссылкой) → описание Google; нет — null. */
export function describe(e: Enrichment | undefined): {
  text: string | null;
  source: DescriptionSource | null;
  url: string | null;
} {
  if (e?.ai) return { text: shorten(e.ai), source: "ai", url: null };
  if (e?.wiki?.extract) return { text: shorten(e.wiki.extract), source: "wikipedia", url: e.wiki.url };
  if (e?.google?.summary) return { text: shorten(e.google.summary), source: "google", url: null };
  return { text: null, source: null, url: null };
}

const KIDS_AMENITIES = new Set(["good_for_children", "kids_menu"]);
const kidsFriendly = (e: Enrichment | undefined) =>
  Boolean(e?.google?.amenities.some((a) => KIDS_AMENITIES.has(a)));

/**
 * Порядок мест, найденных по ключевым словам: совпадение (название, тип, описания, отзывы) + рейтинг Google −
 * расстояние. Суши-бар с 4.7 рядом — выше кафе, где суши упомянуты в одном отзыве.
 */
export function keywordRank(
  relevance: number,
  rating: number | null,
  ratingCount: number | null,
  distanceMeters: number | null,
): number {
  return (
    relevance +
    (rating === null ? 0 : (rating - 4) * 1.5) +
    0.3 * Math.log10(1 + (ratingCount ?? 0)) -
    (distanceMeters === null ? 0 : (distanceMeters / 1000) * 0.2)
  );
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isoDay = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

const PART_UK: Record<DayPart, string> = { morning: "ранок", afternoon: "день", evening: "вечір" };

/**
 * Ассистент на главной (флаг module.assistant). Модель разбирает реплику в намерение (категории каталога, ключевые
 * слова блюда или кухни, радиус, цены, «з дітьми», маршрут, план) — места подбирает сервер из каталога
 * (GuideService.search, поиск по ключевым словам в названии, типе Google, описаниях и отзывах), цены и описания —
 * только из обогащения (place_enrichments). План отдыха собирается из мест каталога по дням и частям дня (plan.ts);
 * пояснения к пунктам — Claude по фактам выбранных мест. Контекст диалога — с клиента, сервер ничего не хранит.
 * Суточный бюджет обращений к Claude и Speech-to-Text — на api и на пользователя (AssistantBudget).
 */
@Injectable()
export class AssistantService {
  private readonly log = new Logger("AssistantService");

  constructor(
    @Inject(AssistantRepository) private readonly repo: AssistantRepository,
    @Inject(GuideService) private readonly guide: GuideService,
    @Inject(ASSISTANT_LLM) private readonly llm: AssistantLlm,
    @Inject(ASSISTANT_SPEECH) private readonly speech: AssistantSpeech,
    @Inject(AssistantBudget) private readonly budget: AssistantBudget,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
  ) {}

  /** Часы (подменяются в тестах): дата и время плана. */
  now: () => Date = () => new Date();

  async query(regionId: string, userId: string, q: AssistantQuery): Promise<AssistantResultDto> {
    if (!this.llm.enabled) throw unavailable("not_configured");
    // Категории региона: заодно проверка региона (нет или не active — 404) до обращения к модели.
    const { items } = await this.guide.categories(regionId);
    const withPlaces = items.filter((c) => c.placeCount > 0);
    const nameOf = new Map(items.map((c) => [c.id, c.name.uk]));
    const categories: IntentCategory[] = withPlaces.map((c) => ({
      code: c.code,
      name: c.name.uk,
      parentName: c.parentId ? (nameOf.get(c.parentId) ?? null) : null,
    }));
    const catalog: Catalog = {
      idOf: new Map(withPlaces.map((c) => [c.code, c.id])),
      anyIdOf: new Map(items.map((c) => [c.code, c.id])),
      codeOf: new Map(items.map((c) => [c.id, c.code])),
      rootOf: new Map(items.map((c) => [c.id, c.parentId ?? c.id])),
      nameOf,
    };
    const localityRows = await this.repo.localities(regionId);
    const localities: IntentLocality[] = localityRows.map((l) => ({
      code: l.code,
      name: l.name_i18n.uk,
      aliases: LOCALITY_ALIASES[l.code] ?? [],
    }));
    const localityIdOf = new Map(localityRows.map((l) => [l.code, l.id]));

    await this.budget.spend(userId, BUDGET_UNITS.query);
    let message;
    try {
      message = await this.llm.create(
        intentRequest(
          categories,
          {
            history: q.history,
            previous: q.previous,
            text: q.text,
            hasOrigin: Boolean(q.origin),
          },
          localities,
        ),
      );
    } catch (e) {
      throw upstream(e);
    }
    // Отказ модели, обрыв или ответ без вызова инструмента — «уточніть запит», а не ошибка.
    const allowed = new Set(catalog.idOf.keys());
    const intent =
      parseIntent(toolInputOf(message), allowed, new Set(localityIdOf.keys())) ??
      clarifyIntent(q.previous, allowed);
    const nothing = !intent.categories.length && !intent.nameQuery && !intent.keywords.length;
    if (intent.clarify || (intent.kind !== "plan" && nothing))
      return { intent: { ...intent, clarify: true }, items: [], route: null, plan: null, notes: [] };
    // Населённый пункт, названный в запросе, — главнее выбора туриста; радиус в запросе («в 500 м») без названного
    // пункта и с точкой туриста — тоже: поиск от точки, выбор «Локація» не применяется. Выбор — только пункты этого региона.
    const regionLocalities = new Set(localityIdOf.values());
    const localityIds = intent.locality
      ? [localityIdOf.get(intent.locality)!]
      : intent.radiusMeters !== null && q.origin
        ? []
        : (q.localityIds ?? []).map((id) => id.toLowerCase()).filter((id) => regionLocalities.has(id));
    const scope: Scope = { origin: q.origin, localityIds };
    if (intent.kind === "plan") return this.plan(regionId, userId, intent, catalog, scope);
    return this.select(regionId, intent, catalog, scope);
  }

  async transcribe(regionId: string, userId: string, audio: Buffer, mime: AudioMime): Promise<string> {
    if (!this.speech.enabled) throw unavailable("not_configured");
    // Регион — до траты бюджета: нет или не active — 404.
    const region = await this.regions.findById(regionId.toLowerCase());
    if (region?.status !== "active") throw new ApiError("NOT_FOUND");
    await this.budget.spend(userId, BUDGET_UNITS.voice);
    try {
      return await this.speech.recognize(audio, mime);
    } catch (e) {
      throw upstream(e);
    }
  }

  /** Разделы (корни) категорий намерения — поиск по ключевым словам идёт по всему разделу («Де поїсти»). */
  private sectionsOf(codes: readonly string[], catalog: Catalog): string[] {
    const ids = codes.map((c) => catalog.idOf.get(c)).filter((id): id is string => Boolean(id));
    return [...new Set(ids.map((id) => catalog.rootOf.get(id) ?? id))];
  }

  /**
   * Места по ключевым словам (блюдо, кухня, особенность): совпадения в названии, типе Google, описаниях и отзывах —
   * в разделах категорий намерения. Рядом мало и радиус не назван туристом — поиск расширяется (notes: widened).
   */
  private async byKeywords(
    regionId: string,
    words: readonly string[],
    intent: AssistantIntent,
    catalog: Catalog,
    scope: Scope,
  ): Promise<{ found: PlaceSummaryDto[]; relevance: Map<string, number>; notes: AssistantNote[] }> {
    const terms = expandKeywords(words);
    const pattern = keywordPattern(terms);
    const namePattern = keywordPattern(terms, false);
    const notes: AssistantNote[] = [];
    if (!pattern || !namePattern) return { found: [], relevance: new Map(), notes };
    const sections = this.sectionsOf(intent.categories, catalog);
    const byLocality = scope.localityIds.length > 0;
    const radius =
      byLocality || !scope.origin ? undefined : (intent.radiusMeters ?? ASSISTANT_RADIUS_DEFAULT);
    const run = (r: number | undefined) =>
      this.repo.keywordMatches(regionId, {
        pattern,
        namePattern,
        categoryIds: sections,
        localityIds: byLocality ? scope.localityIds : undefined,
        origin: scope.origin,
        radius: r,
        // Без категорий одно упоминание в отзыве (отель, где «замовляли суші») не считается.
        minScore: sections.length ? 1 : 2,
        limit: KEYWORD_CANDIDATES,
      });
    let matches = await run(radius);
    if (matches.length < WIDEN_BELOW && radius !== undefined && intent.radiusMeters === null) {
      const wide = await run(undefined);
      if (wide.length > matches.length) {
        matches = wide;
        notes.push("widened");
      }
    }
    if (!matches.length) return { found: [], relevance: new Map(), notes };
    const page = await this.guide.search(regionId, {
      ids: matches.map((m) => m.id),
      origin: scope.origin,
      limit: matches.length,
      offset: 0,
    });
    return { found: page.items, relevance: new Map(matches.map((m) => [m.id, m.score])), notes };
  }

  /** Места каталога по намерению: поиск по категориям или ключевым словам, фильтры и порядок, описания из обогащения. */
  private async select(
    regionId: string,
    intent: AssistantIntent,
    catalog: Catalog,
    scope: Scope,
  ): Promise<AssistantResultDto> {
    const { origin, localityIds } = scope;
    const byLocality = localityIds.length > 0;
    const notes: AssistantNote[] = [];
    let found: PlaceSummaryDto[] = [];
    let relevance: Map<string, number> | null = null;

    if (intent.keywords.length) {
      const k = await this.byKeywords(regionId, intent.keywords, intent, catalog, scope);
      found = k.found;
      relevance = k.relevance;
      notes.push(...k.notes);
      // Блюда нет нигде — показываем места категории с пояснением.
      if (!found.length && intent.categories.length) notes.push("keyword_none");
    }
    if (!found.length && (intent.categories.length || intent.nameQuery)) {
      relevance = null;
      found = await this.byCategories(regionId, intent, catalog, scope);
      // Слово модели в nameQuery («суші») — не название: мало по названию — ищем ещё по описаниям и отзывам.
      if (found.length < WIDEN_BELOW && intent.nameQuery && !intent.keywords.length) {
        const k = await this.byKeywords(regionId, [intent.nameQuery], intent, catalog, scope);
        const seen = new Set(found.map((p) => p.id));
        const extra = k.found.filter((p) => !seen.has(p.id));
        if (extra.length) {
          // Найденные по названию — первыми.
          relevance = new Map([...k.relevance, ...found.map((p) => [p.id, 100] as const)]);
          found = [...found, ...extra];
        }
      }
    }

    if (!origin && !byLocality && intent.radiusMeters !== null) notes.push("no_origin");
    if (intent.openNow) {
      const open = found.filter((p) => p.openNow === true);
      if (open.length) found = open;
      else if (found.length) notes.push("none_open");
    }
    const enrichment = await this.repo.enrichments(
      regionId,
      found.map((p) => p.id),
    );
    if (relevance) {
      const rank = new Map(
        found.map((p) => {
          const g = enrichment.get(p.id)?.google;
          return [
            p.id,
            keywordRank(
              relevance.get(p.id) ?? 0,
              g?.rating ?? null,
              g?.ratingCount ?? null,
              p.distanceMeters,
            ),
          ] as const;
        }),
      );
      found = [...found].sort((a, b) => rank.get(b.id)! - rank.get(a.id)!);
    }
    let items: AssistantPlaceDto[] = found.map((place) => this.placeDto(place, enrichment.get(place.id)));
    if (intent.priceMin !== null || intent.priceMax !== null) {
      const min = intent.priceMin ?? 0;
      const max = intent.priceMax ?? 4;
      // Цена неизвестна — место не подходит под фильтр; совсем ничего — показываем без фильтра с пояснением.
      const priced = items.filter((i) => i.priceLevel !== null && i.priceLevel >= min && i.priceLevel <= max);
      if (priced.length) items = priced;
      else if (items.length) notes.push("price_unknown");
    }
    // «З дітьми» — не фильтр (данные о детях есть не у всех мест): подходящие — первыми.
    if (intent.withKids)
      items = [...items.filter((i) => i.kidsFriendly), ...items.filter((i) => !i.kidsFriendly)];

    if (intent.kind === "tour") {
      const stops = items.slice(0, ASSISTANT_TOUR_STOPS).map((i) => ({ ...i, location: i.place.location }));
      const { ordered, lengthMeters } = orderRoute(stops, origin);
      return {
        intent,
        items: ordered.map(({ location: _, ...i }) => i),
        route: ordered.length > 1 ? { lengthMeters } : null,
        plan: null,
        notes,
      };
    }
    return { intent, items: items.slice(0, ASSISTANT_PLACES_MAX), route: null, plan: null, notes };
  }

  /** Поиск по категориям намерения (и части названия): как раньше — по расстоянию или порядку каталога. */
  private async byCategories(
    regionId: string,
    intent: AssistantIntent,
    catalog: Catalog,
    scope: Scope,
  ): Promise<PlaceSummaryDto[]> {
    const { origin, localityIds } = scope;
    const byLocality = localityIds.length > 0;
    const cats = intent.categories.length
      ? intent.categories.map((code) => catalog.idOf.get(code))
      : [undefined];
    // В населённых пунктах — localityIds каталога без радиуса (Буковель из Яремче — дальше любого радиуса от туриста);
    // точка туриста — только для расстояния и порядка. Иначе — в радиусе от точки туриста.
    const pages = await Promise.all(
      cats.map((categoryId) =>
        this.guide.search(regionId, {
          origin,
          radius: byLocality || !origin ? undefined : (intent.radiusMeters ?? ASSISTANT_RADIUS_DEFAULT),
          categoryId,
          localityIds: byLocality ? [...localityIds] : undefined,
          text: intent.nameQuery ?? undefined,
          // Лимит — на категорию по всем выбранным пунктам вместе (осознанно): при точке туриста выдача отсортирована
          // по расстоянию, ближайшие не теряются.
          limit: byLocality ? CANDIDATES_WITH_LOCALITY : CANDIDATES_PER_CATEGORY,
          offset: 0,
        }),
      ),
    );
    const seen = new Set<string>();
    let found: PlaceSummaryDto[] = [];
    for (const item of pages.flatMap((p) => p.items)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      found.push(item);
    }
    // Несколько категорий: общий порядок — по расстоянию (с точкой), иначе как пришло.
    if (origin && (pages.length > 1 || byLocality))
      found = found.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
    return found;
  }

  private placeDto(place: PlaceSummaryDto, e: Enrichment | undefined): AssistantPlaceDto {
    const d = describe(e);
    return {
      place,
      priceLevel: e?.google?.priceLevel ?? null,
      kidsFriendly: kidsFriendly(e),
      description: d.text,
      descriptionSource: d.source,
      descriptionUrl: d.url,
    };
  }

  /**
   * План отдыха: дни (с учётом «сьогодні/завтра/вихідні» в таймзоне региона), кандидаты из разделов каталога рядом
   * с туристом (или в выбранных пунктах, или вокруг лучшей пам'ятки региона), график работы на даты плана, сборка
   * buildPlan и пояснения Claude по фактам выбранных мест (не вышло — план без пояснений).
   */
  private async plan(
    regionId: string,
    userId: string,
    intent: AssistantIntent,
    catalog: Catalog,
    scope: Scope,
  ): Promise<AssistantResultDto> {
    const notes: AssistantNote[] = [];
    const region = await this.regions.findById(regionId.toLowerCase());
    const local = localMoment(this.now(), region?.timezone ?? TIMEZONE_DEFAULT);
    let offset =
      intent.start === "tomorrow"
        ? 1
        : intent.start === "weekend"
          ? local.dayOfWeek >= 6
            ? 0
            : 6 - local.dayOfWeek
          : 0;
    const nowFrom = startMinuteFrom(local.minutes);
    if (offset === 0 && !hasTimeToday(intent.dayParts, nowFrom)) {
      offset = 1;
      notes.push("plan_tomorrow");
    }
    const days: PlanDayInput[] = Array.from({ length: intent.days ?? 1 }, (_, i) => {
      const date = addDays(local.date, offset + i);
      return { dayNo: i + 1, date, dayOfWeek: isoDay(date), fromMinute: offset + i === 0 ? nowFrom : 0 };
    });

    // Где искать: выбранные пункты; иначе от точки туриста; иначе — вокруг лучшей пам'ятки региона.
    const byLocality = scope.localityIds.length > 0;
    let center = scope.origin;
    if (!byLocality && !center) center = await this.planAnchor(regionId, intent, catalog);
    const radius = byLocality || !center ? undefined : (intent.radiusMeters ?? PLAN_RADIUS_DEFAULT);
    const sectionIds = PLAN_SECTIONS.map((code) => catalog.anyIdOf.get(code)).filter((id): id is string =>
      Boolean(id),
    );
    const pages = await Promise.all(
      sectionIds.map((categoryId) =>
        this.guide.search(regionId, {
          categoryId,
          origin: center,
          radius,
          localityIds: byLocality ? [...scope.localityIds] : undefined,
          limit: PLAN_CANDIDATES_PER_SECTION,
          offset: 0,
        }),
      ),
    );
    const places = new Map<string, PlaceSummaryDto>();
    for (const p of pages.flatMap((x) => x.items)) if (!places.has(p.id)) places.set(p.id, p);
    const ids = [...places.keys()];
    const wantedIds = new Set<string>();
    if (intent.keywords.length && ids.length) {
      const terms = expandKeywords(intent.keywords);
      const pattern = keywordPattern(terms);
      const namePattern = keywordPattern(terms, false);
      if (pattern && namePattern)
        for (const m of await this.repo.keywordMatches(regionId, {
          pattern,
          namePattern,
          categoryIds: [],
          localityIds: byLocality ? scope.localityIds : undefined,
          origin: center,
          radius,
          minScore: 2,
          limit: KEYWORD_CANDIDATES,
        }))
          wantedIds.add(m.id);
    }
    const [facts, schedules] = await Promise.all([
      this.repo.ratings(regionId, ids),
      this.repo.schedules(
        regionId,
        ids,
        days.map((d) => d.date),
      ),
    ]);
    const wantedCats = new Set(intent.categories.map((c) => catalog.idOf.get(c)).filter(Boolean));
    const candidates: PlanCandidate[] = [...places.values()].map((p) =>
      planCandidate(p, catalog, facts.get(p.id), schedules.get(p.id) ?? null, {
        wanted:
          wantedIds.has(p.id) ||
          wantedCats.has(p.categoryId) ||
          wantedCats.has(catalog.rootOf.get(p.categoryId)),
      }),
    );
    const built = buildPlan(candidates, {
      days,
      parts: intent.dayParts,
      origin: scope.origin,
      withKids: intent.withKids,
      month: Number(days[0]!.date.slice(5, 7)),
      priceMin: intent.priceMin,
      priceMax: intent.priceMax,
    });

    // Места плана — в порядке плана (каждое один раз), пункты ссылаются на индекс в items.
    const order: string[] = [];
    for (const d of built.days) for (const p of d.parts) for (const s of p.stops) order.push(s.placeId);
    const enrichment = await this.repo.enrichments(regionId, order);
    const items = order.map((id) => this.placeDto(places.get(id)!, enrichment.get(id)));
    const index = new Map(order.map((id, i) => [id, i]));
    const texts = await this.planNotes(userId, intent, built.days, items, enrichment, catalog, facts);
    let n = 0;
    const plan: AssistantPlanDto = {
      lengthMeters: built.lengthMeters,
      days: built.days.map((d) => ({
        dayNo: d.dayNo,
        date: d.date,
        parts: d.parts.map((p) => ({
          part: p.part,
          stops: p.stops.map((s) => ({
            item: index.get(s.placeId)!,
            role: s.role,
            start: formatMinute(s.startMinute),
            durationMin: s.durationMin,
            travel: s.travel,
            travelMinutes: s.travelMinutes,
            travelMeters: s.travelMeters,
            hours: s.hours,
            note: texts.get(++n) ?? null,
          })),
        })),
      })),
    };
    return { intent, items, route: null, plan: items.length ? plan : null, notes };
  }

  /** Без точки туриста и пунктов: центр плана — лучшая (по рейтингу и рекомендации) пам'ятка региона. */
  private async planAnchor(
    regionId: string,
    intent: AssistantIntent,
    catalog: Catalog,
  ): Promise<LonLat | undefined> {
    const wanted = intent.categories.map((c) => catalog.idOf.get(c)).find(Boolean);
    const categoryId = wanted ?? catalog.anyIdOf.get("nearby");
    if (!categoryId) return undefined;
    const page = await this.guide.search(regionId, {
      categoryId,
      limit: PLAN_CANDIDATES_PER_SECTION,
      offset: 0,
    });
    if (!page.items.length) return undefined;
    const facts = await this.repo.ratings(
      regionId,
      page.items.map((p) => p.id),
    );
    const opts = { withKids: intent.withKids, priceMin: null, priceMax: null };
    const best = page.items
      .map((p) => ({
        p,
        q: quality(planCandidate(p, catalog, facts.get(p.id), null, { wanted: false }), opts),
      }))
      .sort((a, b) => b.q - a.q)[0]!;
    return best.p.location;
  }

  /** Пояснения к пунктам плана (Claude по фактам каталога); бюджет исчерпан или сбой — без пояснений. */
  private async planNotes(
    userId: string,
    intent: AssistantIntent,
    days: ReturnType<typeof buildPlan>["days"],
    items: readonly AssistantPlaceDto[],
    enrichment: ReadonlyMap<string, Enrichment>,
    catalog: Catalog,
    facts: ReadonlyMap<string, PlaceRatingFacts>,
  ): Promise<Map<number, string>> {
    const stops: NoteFacts[] = [];
    const byId = new Map(items.map((i) => [i.place.id, i]));
    for (const d of days)
      for (const p of d.parts)
        for (const s of p.stops) {
          const item = byId.get(s.placeId)!;
          const e = enrichment.get(s.placeId);
          const f = facts.get(s.placeId);
          const desc = describe(e).text;
          stops.push({
            n: stops.length + 1,
            name: item.place.name.uk,
            category: catalog.nameOf.get(item.place.categoryId) ?? "",
            type: f?.typeLabel ?? null,
            role: s.role,
            day: d.dayNo,
            part: PART_UK[p.part],
            start: formatMinute(s.startMinute),
            durationMin: s.durationMin,
            hours: s.hours,
            rating: f?.rating ?? null,
            description: desc ? shorten(desc, NOTE_DESCRIPTION_MAX) : null,
            kidsFriendly: item.kidsFriendly,
          });
        }
    if (!stops.length) return new Map();
    try {
      await this.budget.spend(userId, BUDGET_UNITS.planNotes);
      const message = await this.llm.create(notesRequest(stops, { withKids: intent.withKids }));
      return parseNotes(toolInputOf(message, NOTES_TOOL), new Set(stops.map((s) => s.n)));
    } catch (e) {
      // План без пояснений лучше, чем ошибка: места и время уже подобраны.
      this.log.warn(`Пояснения к плану не получены: ${e instanceof Error ? e.message : String(e)}`);
      return new Map();
    }
  }
}

/** Место каталога → кандидат плана (код подкатегории, рейтинг и цена Google, «дітям», график). */
function planCandidate(
  p: PlaceSummaryDto,
  catalog: Catalog,
  f: PlaceRatingFacts | undefined,
  schedule: PlanCandidate["schedule"],
  extra: { wanted: boolean },
): PlanCandidate {
  return {
    id: p.id,
    category: catalog.codeOf.get(p.categoryId) ?? "",
    location: p.location,
    rating: f?.rating ?? null,
    ratingCount: f?.ratingCount ?? null,
    recommended: p.recommended,
    kidsFriendly: Boolean(f?.amenities.some((a) => KIDS_AMENITIES.has(a))),
    priceLevel: f?.priceLevel ?? null,
    schedule: schedule && (schedule.weekly.length || schedule.exceptions.length) ? schedule : null,
    wanted: extra.wanted,
  };
}

/** Намерение «уточніть»: прежнее (если было) — чтобы следующий запрос продолжил диалог. */
function clarifyIntent(previous: AssistantIntent | null, allowed: ReadonlySet<string>): AssistantIntent {
  const kind = previous?.kind ?? "places";
  return {
    kind,
    // Намерение пришло с клиента: только коды каталога региона.
    categories: (previous?.categories ?? []).filter((c) => allowed.has(c)),
    nameQuery: previous?.nameQuery ?? null,
    keywords: previous?.keywords ?? [],
    // Пункт прошлого запроса не переносится: уточнение без пункта — снова выбор туриста.
    locality: null,
    radiusMeters: previous?.radiusMeters ?? null,
    priceMin: previous?.priceMin ?? null,
    priceMax: previous?.priceMax ?? null,
    withKids: previous?.withKids ?? false,
    openNow: previous?.openNow ?? false,
    clarify: true,
    suggestions: [],
    days: kind === "plan" ? (previous?.days ?? 1) : null,
    dayParts: kind === "plan" ? (previous?.dayParts ?? []) : [],
    start: kind === "plan" ? (previous?.start ?? null) : null,
  };
}

function unavailable(reason: "not_configured"): ApiError {
  return new ApiError("SERVICE_UNAVAILABLE", {
    messageKey: "errors.assistant.unavailable",
    details: { reason },
  });
}

function upstream(e: unknown): unknown {
  if (!(e instanceof AssistantUpstreamError)) return e;
  if (e.reason === "timeout")
    return new ApiError("GATEWAY_TIMEOUT", {
      messageKey: "errors.assistant.upstream",
      details: { reason: "timeout" },
    });
  // Неверный ключ или выключенный API — ассистент недоступен (код — в логе), а не «плохое аудио».
  if (e.reason === "config") return unavailable("not_configured");
  if (e.reason === "rejected")
    return new ApiError("UNPROCESSABLE", {
      messageKey: "errors.assistant.audio",
      details: { reason: "rejected" },
    });
  return new ApiError("BAD_GATEWAY", {
    messageKey: "errors.assistant.upstream",
    details: { reason: "upstream" },
  });
}

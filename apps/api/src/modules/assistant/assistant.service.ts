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
  type KeywordQuery,
  type PlaceEnrichmentFacts,
  type PlaceRatingFacts,
} from "./assistant.repository.js";
import { AssistantBudget, BUDGET_UNITS } from "./budget.js";
import {
  CATEGORY_HINTS,
  intentRequest,
  parseIntent,
  toolInputOf,
  type AssistantIntent,
  type AssistantQuestion,
  type DayPart,
  type IntentCategory,
  type IntentLocality,
} from "./intent.js";
import { expandKeywords, isKnownKeyword, keywordPattern } from "./keywords.js";
import {
  NOTE_COMPACT_MAX,
  NOTES_TOOL,
  notesRequest,
  notesSubset,
  parseNotes,
  type NoteFacts,
} from "./plan-notes.js";
import {
  AREA,
  buildPlan,
  formatMinute,
  FOOT_HOP_M,
  hasTimeToday,
  MAX_HOP_M,
  planAreas,
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
import { haversineMeters, orderRoute } from "./route.js";

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
/** Кандидатов плана на раздел каталога: на день; с каждым следующим днём — больше, до предела. */
const PLAN_CANDIDATES_PER_SECTION = 60;
const PLAN_CANDIDATES_PER_DAY = 15;
const PLAN_CANDIDATES_MAX = 150;
/** Пешком — план вокруг жилья компактнее. */
export const PLAN_RADIUS_FOOT = 3000;
/** План по районам: пам'ятки и активности (районы дней) — разделы и сколько лучших по региону на день. */
const PLAN_AREA_SECTIONS = ["nearby", "fun", "ski"] as const;
const PLAN_REGION_SIGHTS_PER_DAY = 40;
/** Вокруг района — еда и отдых (пешком — все разделы плана), кандидатов на раздел. */
const PLAN_AROUND_SECTIONS = ["eat", "relax"] as const;
const PLAN_AREA_CANDIDATES = 25;
/** Без авто: такси, экскурсии, автостанция — не дальше от района, м, и не больше на вид. */
const TRANSFER_HELP_RADIUS = 20_000;
const TRANSFER_HELP_MAX = 2;
const BUS_STATION_TERMS = ["автостанц*", "автовокзал*", "автостанция", "bus station"];
/** Меньше стольких рядом — поиск по ключевым словам расширяется на регион (если радиус не назвал турист): ближние
 * всё равно первыми (штраф за расстояние в keywordRank). */
const WIDEN_BELOW = 5;
const DESCRIPTION_MAX = 320;
const NOTE_DESCRIPTION_MAX = 220;
const TIMEZONE_DEFAULT = "Europe/Kyiv";
/** Пояснения к плану — не дольше (иначе план без пояснений, а не ожидание общего таймаута Claude). */
const NOTES_TIMEOUT_MS = 9000;
/** Большой план: пунктов больше — ответ дольше. */
const NOTES_TIMEOUT_COMPACT_MS = 14_000;

export type AssistantQuery = {
  text: string;
  origin?: LonLat;
  history: readonly string[];
  previous: AssistantIntent | null;
  /** Населённые пункты, выбранные туристом (фильтр «Локація»); названный в запросе — главнее. */
  localityIds?: readonly string[];
  /** Ответ на уточняющие вопросы плана: намерение — previous с ответами, без вызова модели. */
  answer?: boolean;
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

/** Где искать: пункты, радиус от точки (общее для мест и плана); localityCenter — центр выбранного пункта. */
type Scope = { origin?: LonLat; localityIds: readonly string[]; localityCenter?: LonLat };

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

/** Вес совпадения по связанным понятиям в keywordRank: подъём, а не замена рейтинга (одно упоминание — +0.4). */
export const relatedBoost = (score: number) => Math.min(score, 6) * 0.4;

/** Ответ без мест (уточнение, вопрос перед планом). */
const EMPTY_RESULT = { items: [], route: null, plan: null, notes: [], questions: [] } satisfies Omit<
  AssistantResultDto,
  "intent"
>;

/** Точки без повторов (районы, повторённые на второй день). */
const uniquePoints = (points: readonly LonLat[]) =>
  points.filter((p, i) => points.findIndex((q) => q.lon === p.lon && q.lat === p.lat) === i);

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
      hint: CATEGORY_HINTS[c.code],
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

    const allowed = new Set(catalog.idOf.keys());
    const allowedLocalities = new Set(localityIdOf.keys());
    const prevPlan = q.previous?.kind === "plan" ? q.previous : null;
    let intent: AssistantIntent;
    if (q.answer && prevPlan) {
      // Ответ на уточнения (чипы области и передвижения): намерение — прежнее с ответами, проверенное как ответ
      // модели (коды каталога, пределы); модель не вызывается — без единицы бюджета и без 2–5 с ожидания.
      intent = { ...parseIntent(prevPlan, allowed, allowedLocalities)!, clarify: false };
    } else {
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
      intent =
        parseIntent(toolInputOf(message), allowed, allowedLocalities) ?? clarifyIntent(q.previous, allowed);
    }
    const nothing =
      !intent.categories.length && !intent.nameQuery && !intent.keywords.length && !intent.related.length;
    if (intent.clarify || (intent.kind !== "plan" && nothing))
      return { ...EMPTY_RESULT, intent: { ...intent, clarify: true } };
    const regionLocalities = new Set(localityIdOf.values());
    const inRegion = (ids: readonly string[]) =>
      [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => regionLocalities.has(id));
    if (intent.kind === "plan") {
      // Ответы на уточнения (область, передвижение) — в прежнем намерении; модель могла их не повторить.
      const prev = prevPlan;
      intent.scope ??= prev?.scope ?? null;
      intent.transport ??= prev?.transport ?? null;
      intent.scopeLocalityIds = intent.scope === "localities" ? inRegion(prev?.scopeLocalityIds ?? []) : [];
      // Пункты не выбраны (или чужие) — как по всему региону.
      if (intent.scope === "localities" && !intent.scopeLocalityIds.length) intent.scope = "region";
      // Модель не перекрывает ответ на уточнение: «обрані локації» — пункты из ответа (не пункт и не радиус модели);
      // «Пішки» — способ передвижения, а не радиус «пішки ≈ 1500 м» (если турист не назвал расстояние числом).
      if (intent.scope === "localities") {
        intent.locality = null;
        intent.radiusMeters = null;
      }
      if (
        intent.transport === "foot" &&
        intent.radiusMeters !== null &&
        (prev?.radiusMeters ?? null) === null &&
        !/\d/.test(q.text)
      )
        intent.radiusMeters = null;
      // Многодневный план без области или передвижения — сначала уточнить (места не ищем).
      if ((intent.days ?? 1) >= 2) {
        const questions: AssistantQuestion[] = [];
        if (!intent.scope && !intent.locality && intent.radiusMeters === null) questions.push("scope");
        if (!intent.transport) questions.push("transport");
        if (questions.length) return { ...EMPTY_RESULT, intent, questions };
      }
    }
    // Населённый пункт, названный в запросе, — главнее выбора туриста; радиус в запросе («в 500 м») без названного
    // пункта и с точкой туриста — тоже: поиск от точки, выбор «Локація» не применяется. Выбор — только пункты этого
    // региона. План «по всьому регіону» — без пунктов; «обрані локації» — пункты из ответа на уточнение.
    const localityIds = intent.locality
      ? [localityIdOf.get(intent.locality)!]
      : intent.scope === "localities"
        ? intent.scopeLocalityIds
        : intent.scope === "region" || (intent.radiusMeters !== null && q.origin)
          ? []
          : inRegion(q.localityIds ?? []);
    const scope: Scope = {
      origin: q.origin,
      localityIds,
      localityCenter: localityRows.find((l) => l.id === localityIds[0])?.location ?? undefined,
    };
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
      const c = await this.byCategories(regionId, intent, catalog, scope);
      found = c.found;
      notes.push(...c.notes);
      // Слово модели в nameQuery — блюдо из словаря («суші»), а не название заведения («Суші Барберрі»): мало по
      // названию — ищем ещё по описаниям и отзывам.
      if (
        found.length < WIDEN_BELOW &&
        intent.nameQuery &&
        !intent.keywords.length &&
        isKnownKeyword(intent.nameQuery)
      ) {
        const k = await this.byKeywords(regionId, [intent.nameQuery], intent, catalog, scope);
        const seen = new Set(found.map((p) => p.id));
        const extra = k.found.filter((p) => !seen.has(p.id));
        if (extra.length) {
          // Найденные по названию — первыми.
          relevance = new Map([...k.relevance, ...found.map((p) => [p.id, 100] as const)]);
          found = [...found, ...extra];
        }
      }
      // Раскрытое желание («з дітьми цікаво» → атракціони, зоопарк, канатка): места категорий плюс найденные по
      // связанным словам; совпавшие — выше (умеренно: рейтинг и расстояние тоже важны).
      if (intent.related.length && !relevance) {
        const k = await this.byKeywords(regionId, intent.related, intent, catalog, scope);
        const seen = new Set(found.map((p) => p.id));
        found = [...found, ...k.found.filter((p) => !seen.has(p.id))];
        relevance = new Map([...k.relevance].map(([id, s]) => [id, relatedBoost(s)] as const));
        if (k.notes.includes("widened") && found.length > c.found.length) notes.push("widened");
      }
    } else if (!found.length && intent.related.length) {
      // Только связанные понятия без категорий — места, где они встречаются (одного отзыва мало: minScore 2).
      const k = await this.byKeywords(regionId, intent.related, intent, catalog, scope);
      found = k.found;
      relevance = new Map([...k.relevance].map(([id, s]) => [id, relatedBoost(s)] as const));
      notes.push(...k.notes);
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
        notes: [...new Set(notes)],
        questions: [],
      };
    }
    return {
      intent,
      items: items.slice(0, ASSISTANT_PLACES_MAX),
      route: null,
      plan: null,
      notes: [...new Set(notes)],
      questions: [],
    };
  }

  /** Поиск по категориям намерения (и части названия): как раньше — по расстоянию или порядку каталога. */
  private async byCategories(
    regionId: string,
    intent: AssistantIntent,
    catalog: Catalog,
    scope: Scope,
  ): Promise<{ found: PlaceSummaryDto[]; notes: AssistantNote[] }> {
    const { origin, localityIds } = scope;
    const byLocality = localityIds.length > 0;
    const radius = byLocality || !origin ? undefined : (intent.radiusMeters ?? ASSISTANT_RADIUS_DEFAULT);
    const found = await this.byCategoriesWithin(regionId, intent, catalog, scope, radius);
    // Рядом мало и радиус не назван туристом (GPS-режим в 8–15 км от центра) — ближайшие по всему региону.
    if (found.length < WIDEN_BELOW && radius !== undefined && intent.radiusMeters === null) {
      const wide = await this.byCategoriesWithin(regionId, intent, catalog, scope, undefined);
      if (wide.length > found.length) return { found: wide, notes: ["widened"] };
    }
    return { found, notes: [] };
  }

  private async byCategoriesWithin(
    regionId: string,
    intent: AssistantIntent,
    catalog: Catalog,
    scope: Scope,
    radius: number | undefined,
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
          radius,
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

    const transport = intent.transport ?? "car";
    const foot = transport === "foot";
    const byLocality = scope.localityIds.length > 0;
    // Несколько дней по региону (или по нескольким выбранным пунктам) — дни по разным районам.
    const multiArea =
      days.length >= 2 && ((intent.scope === "region" && !byLocality) || scope.localityIds.length >= 2);
    const sectionIds = PLAN_SECTIONS.map((code) => catalog.anyIdOf.get(code)).filter((id): id is string =>
      Boolean(id),
    );
    // Кандидатов на раздел — с запасом на число дней (5–7 дней — до ~60 пунктов без повторов).
    const perSection = Math.min(
      PLAN_CANDIDATES_MAX,
      PLAN_CANDIDATES_PER_SECTION + PLAN_CANDIDATES_PER_DAY * (days.length - 1),
    );
    const places = new Map<string, PlaceSummaryDto>();
    const add = (items: readonly PlaceSummaryDto[]) => {
      for (const p of items) if (!places.has(p.id)) places.set(p.id, p);
    };
    const wantedIds = new Set<string>();
    const wantedCats = new Set(intent.categories.map((c) => catalog.idOf.get(c)).filter(Boolean));
    const wantedOf = (p: PlaceSummaryDto) =>
      wantedIds.has(p.id) || wantedCats.has(p.categoryId) || wantedCats.has(catalog.rootOf.get(p.categoryId));
    const wanted = async (q: Pick<KeywordQuery, "origin" | "radius">) => {
      const terms = expandKeywords([...intent.keywords, ...intent.related]);
      const pattern = keywordPattern(terms);
      const namePattern = keywordPattern(terms, false);
      if (!pattern || !namePattern) return;
      for (const m of await this.repo.keywordMatches(regionId, {
        pattern,
        namePattern,
        categoryIds: [],
        localityIds: byLocality ? scope.localityIds : undefined,
        ...q,
        minScore: 2,
        limit: KEYWORD_CANDIDATES,
      }))
        wantedIds.add(m.id);
    };
    const opts = {
      withKids: intent.withKids,
      month: Number(days[0]!.date.slice(5, 7)),
      priceMin: intent.priceMin,
      priceMax: intent.priceMax,
    };
    let planOrigin = scope.origin;
    let areas: LonLat[] = [];

    if (multiArea) {
      // 1) Пам'ятки и активности — лучшие по рейтингу: по всему региону или в выбранных пунктах (без радиуса).
      const sightIds = PLAN_AREA_SECTIONS.map((code) => catalog.anyIdOf.get(code)).filter(
        (id): id is string => Boolean(id),
      );
      const limit = Math.min(PLAN_CANDIDATES_MAX * 2, PLAN_REGION_SIGHTS_PER_DAY * days.length);
      const top = await this.repo.topRated(regionId, {
        categoryIds: sightIds,
        localityIds: byLocality ? scope.localityIds : undefined,
        limit,
      });
      if (top.length)
        add((await this.guide.search(regionId, { ids: top, limit: top.length, offset: 0 })).items);
      if (intent.keywords.length || intent.related.length) await wanted({});
      const sightFacts = await this.repo.ratings(regionId, [...places.keys()]);
      const sights = [...places.values()].map((p) =>
        planCandidate(p, catalog, sightFacts.get(p.id), null, { wanted: wantedOf(p) }),
      );
      areas = planAreas(sights, days.length, { ...opts, origin: scope.origin, transport });
      // Районов нет (пам'яток с координатами не нашлось) — запасной вариант: план вокруг якоря, как без районов.
      if (!areas.length) {
        places.clear();
        wantedIds.clear();
      }
    }
    if (areas.length) {
      // 2) Вокруг каждого района — еда и отдых (пешком — и пам'ятки рядом: район компактный).
      const aroundIds = (foot ? PLAN_SECTIONS : PLAN_AROUND_SECTIONS)
        .map((code) => catalog.anyIdOf.get(code))
        .filter((id): id is string => Boolean(id));
      // Районы — по очереди (каждый — несколько запросов параллельно): не занимать весь пул соединений.
      for (const at of uniquePoints(areas)) {
        const pages = await Promise.all(
          aroundIds.map((categoryId) =>
            this.guide.search(regionId, {
              categoryId,
              origin: at,
              radius: AREA[transport].radius,
              localityIds: byLocality ? [...scope.localityIds] : undefined,
              limit: PLAN_AREA_CANDIDATES,
              offset: 0,
            }),
          ),
        );
        add(pages.flatMap((x) => x.items));
      }
      // День начинается в районе: переезд от жилья — между днями (transfer), не первым пунктом дня.
      planOrigin = undefined;
    } else {
      // Без районов (один день, «тут», один пункт или запасной вариант).
      // Где искать: выбранные пункты; иначе от точки туриста; иначе — вокруг лучшей пам'ятки региона.
      let center = scope.origin;
      // В пункте без точки туриста (или она далеко — QR отеля в Косові, «план у Буковелі») — кандидаты ближе к центру
      // пункта, а не первые по алфавиту.
      const lc = scope.localityCenter;
      // Жильё дальше предела переезда от пункта плана — день начинается на месте, без переезда от жилья.
      const homeFar = Boolean(
        byLocality && lc && center && haversineMeters(center, lc) > (foot ? FOOT_HOP_M : MAX_HOP_M),
      );
      planOrigin = homeFar ? undefined : scope.origin;
      if (byLocality && lc && (!center || homeFar)) center = lc;
      if (!byLocality && !center) center = await this.planAnchor(regionId, intent, catalog);
      const radius =
        byLocality || !center
          ? undefined
          : (intent.radiusMeters ?? (foot ? PLAN_RADIUS_FOOT : PLAN_RADIUS_DEFAULT));
      const pages = await Promise.all(
        sectionIds.map((categoryId) =>
          this.guide.search(regionId, {
            categoryId,
            origin: center,
            radius,
            localityIds: byLocality ? [...scope.localityIds] : undefined,
            limit: perSection,
            offset: 0,
          }),
        ),
      );
      add(pages.flatMap((x) => x.items));
      if ((intent.keywords.length || intent.related.length) && places.size)
        await wanted({ origin: center, radius });
    }

    const ids = [...places.keys()];
    const [facts, schedules] = await Promise.all([
      this.repo.ratings(regionId, ids),
      this.repo.schedules(
        regionId,
        ids,
        days.map((d) => d.date),
      ),
    ]);
    const candidates: PlanCandidate[] = [...places.values()].map((p) =>
      planCandidate(p, catalog, facts.get(p.id), schedules.get(p.id) ?? null, { wanted: wantedOf(p) }),
    );
    const built = buildPlan(candidates, {
      days: areas.length ? days.map((d, i) => ({ ...d, center: areas[i] })) : days,
      parts: intent.dayParts,
      origin: planOrigin,
      transport,
      ...opts,
    });

    // Переезды в другой район перед днём (от жилья — перед первым). Без авто — такси, экскурсии, автостанция
    // каталога рядом с районом (расписаний в каталоге нет — клиент советует уточнять у перевозчика).
    const transfers = new Map<
      number,
      { meters: number; taxi: string[]; excursions: string[]; bus: string[] }
    >();
    for (const [i, at] of areas.entries()) {
      const from = i ? areas[i - 1] : scope.origin;
      const meters = from ? haversineMeters(from, at) : 0;
      if (meters <= FOOT_HOP_M) continue;
      const help = foot
        ? await this.transferHelp(regionId, at, catalog)
        : { places: [], ids: { taxi: [], excursions: [], bus: [] } };
      for (const p of help.places) add([p]);
      transfers.set(i + 1, { meters: Math.round(meters), ...help.ids });
    }

    // Места плана — в порядке плана (каждое один раз), пункты ссылаются на индекс в items; затем места переездов.
    const order: string[] = [];
    for (const d of built.days) for (const p of d.parts) for (const s of p.stops) order.push(s.placeId);
    const planned = order.length;
    for (const t of transfers.values())
      for (const id of [...t.taxi, ...t.excursions, ...t.bus]) if (!order.includes(id)) order.push(id);
    const enrichment = await this.repo.enrichments(regionId, order);
    const items = order.map((id) => this.placeDto(places.get(id)!, enrichment.get(id)));
    const index = new Map(order.map((id, i) => [id, i]));
    const texts = await this.planNotes(userId, intent, built.days, items, enrichment, catalog, facts);
    let n = 0;
    const plan: AssistantPlanDto = {
      lengthMeters: built.lengthMeters,
      days: built.days.map((d) => {
        const t = transfers.get(d.dayNo);
        return {
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
          transfer: t
            ? {
                meters: t.meters,
                taxi: t.taxi.map((id) => index.get(id)!),
                excursions: t.excursions.map((id) => index.get(id)!),
                busStations: t.bus.map((id) => index.get(id)!),
              }
            : null,
        };
      }),
    };
    return {
      intent,
      items,
      route: null,
      plan: planned ? plan : null,
      notes,
      questions: [],
    };
  }

  /** Без авто, переезд в район: такси и трансферы, экскурсионные бюро, автостанция каталога рядом. */
  private async transferHelp(
    regionId: string,
    at: LonLat,
    catalog: Catalog,
  ): Promise<{ places: PlaceSummaryDto[]; ids: { taxi: string[]; excursions: string[]; bus: string[] } }> {
    const near = async (code: string) => {
      const categoryId = catalog.anyIdOf.get(code);
      if (!categoryId) return [];
      return (
        await this.guide.search(regionId, {
          categoryId,
          origin: at,
          radius: TRANSFER_HELP_RADIUS,
          limit: TRANSFER_HELP_MAX,
          offset: 0,
        })
      ).items;
    };
    const bus = async () => {
      const pattern = keywordPattern(BUS_STATION_TERMS);
      const namePattern = keywordPattern(BUS_STATION_TERMS, false);
      if (!pattern || !namePattern) return [];
      const found = await this.repo.keywordMatches(regionId, {
        pattern,
        namePattern,
        categoryIds: [],
        origin: at,
        radius: TRANSFER_HELP_RADIUS,
        // Название или тип Google («Автовокзал»), а не упоминание в отзыве.
        minScore: 3,
        limit: 1,
      });
      if (!found.length) return [];
      return (
        await this.guide.search(regionId, {
          ids: found.map((m) => m.id),
          origin: at,
          limit: found.length,
          offset: 0,
        })
      ).items;
    };
    const [taxi, excursions, stations] = await Promise.all([near("taxi"), near("excursions"), bus()]);
    return {
      places: [...taxi, ...excursions, ...stations],
      ids: {
        taxi: taxi.map((p) => p.id),
        excursions: excursions.map((p) => p.id),
        bus: stations.map((p) => p.id),
      },
    };
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
    // Большой план (5–7 дней) — короче и только к пам'яткам и активностям: тот же один вызов в бюджете.
    const { stops: sent, compact } = notesSubset(stops);
    if (!sent.length) return new Map();
    try {
      await this.budget.spend(userId, BUDGET_UNITS.planNotes);
      const message = await this.llm.create(notesRequest(sent, { withKids: intent.withKids, compact }), {
        timeoutMs: compact ? NOTES_TIMEOUT_COMPACT_MS : NOTES_TIMEOUT_MS,
      });
      return parseNotes(
        toolInputOf(message, NOTES_TOOL),
        new Set(sent.map((s) => s.n)),
        compact ? NOTE_COMPACT_MAX : undefined,
      );
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
    related: previous?.related ?? [],
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
    scope: kind === "plan" ? (previous?.scope ?? null) : null,
    scopeLocalityIds: kind === "plan" ? (previous?.scopeLocalityIds ?? []) : [],
    transport: kind === "plan" ? (previous?.transport ?? null) : null,
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

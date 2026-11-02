import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import type { LonLat } from "../../db/index.js";
import { GuideService, type PlaceSummaryDto } from "../guide/index.js";
import { RegionsRepository } from "../regions/index.js";
import type {
  AssistantNote,
  AssistantPlaceDto,
  AssistantResultDto,
  DescriptionSource,
} from "./assistant.dto.js";
import { AssistantRepository, type PlaceEnrichmentFacts } from "./assistant.repository.js";
import { AssistantBudget, BUDGET_UNITS } from "./budget.js";
import {
  intentRequest,
  parseIntent,
  toolInputOf,
  type AssistantIntent,
  type IntentCategory,
  type IntentLocality,
} from "./intent.js";
import {
  ASSISTANT_LLM,
  ASSISTANT_SPEECH,
  AssistantUpstreamError,
  type AssistantLlm,
  type AssistantSpeech,
  type AudioMime,
} from "./providers.js";
import { orderRoute } from "./route.js";

/** Мест в ответе «places». */
export const ASSISTANT_PLACES_MAX = 10;
/** Остановок экскурсии. */
export const ASSISTANT_TOUR_STOPS = 6;
/** Радиус по умолчанию, когда точка туриста известна, а турист расстояния не назвал. */
export const ASSISTANT_RADIUS_DEFAULT = 5000;
/** Кандидатов на категорию до фильтров (цена, «з дітьми», «відкрито»). */
const CANDIDATES_PER_CATEGORY = 30;
const DESCRIPTION_MAX = 320;

export type AssistantQuery = {
  text: string;
  origin?: LonLat;
  history: readonly string[];
  previous: AssistantIntent | null;
  /** Населённые пункты, выбранные туристом (фильтр «Локація»); названный в запросе — главнее. */
  localityIds?: readonly string[];
};

/**
 * Синонимы населённых пунктов для модели (курорты и разговорные названия). Временно здесь — до общего списка
 * локаций с синонимами (ветка «Локація»).
 */
export const LOCALITY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  polianytsia: ["Буковель", "Bukovel"],
};
/** Кандидатов на категорию при фильтре по населённому пункту (фильтр — после поиска, до общего параметра). */
const CANDIDATES_WITH_LOCALITY = 50;

type Enrichment = PlaceEnrichmentFacts;

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

const kidsFriendly = (e: Enrichment | undefined) =>
  Boolean(e?.google?.amenities.some((a) => a === "good_for_children" || a === "kids_menu"));

/**
 * Ассистент на главной (флаг module.assistant). Модель разбирает реплику в намерение (категории каталога, радиус,
 * цены, «з дітьми», маршрут) — места подбирает сервер существующим поиском каталога (GuideService.search), цены и
 * описания — только из обогащения (place_enrichments). Контекст диалога — с клиента, сервер ничего не хранит.
 * Суточный бюджет обращений к Claude и Speech-to-Text — на api и на пользователя (AssistantBudget).
 */
@Injectable()
export class AssistantService {
  constructor(
    @Inject(AssistantRepository) private readonly repo: AssistantRepository,
    @Inject(GuideService) private readonly guide: GuideService,
    @Inject(ASSISTANT_LLM) private readonly llm: AssistantLlm,
    @Inject(ASSISTANT_SPEECH) private readonly speech: AssistantSpeech,
    @Inject(AssistantBudget) private readonly budget: AssistantBudget,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
  ) {}

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
    const idOf = new Map(withPlaces.map((c) => [c.code, c.id]));
    const localityRows = await this.repo.localities(regionId);
    const localities: IntentLocality[] = localityRows.map((l) => ({
      code: l.code,
      name: l.name_i18n.uk,
      synonyms: LOCALITY_SYNONYMS[l.code] ?? [],
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
    const allowed = new Set(idOf.keys());
    const intent =
      parseIntent(toolInputOf(message), allowed, new Set(localityIdOf.keys())) ??
      clarifyIntent(q.previous, allowed);
    if (intent.clarify || (!intent.categories.length && !intent.nameQuery))
      return { intent: { ...intent, clarify: true }, items: [], route: null, notes: [] };
    // Населённый пункт, названный в запросе, — главнее выбора туриста; выбор — только пункты этого региона.
    const regionLocalities = new Set(localityIdOf.values());
    const localityIds = intent.locality
      ? [localityIdOf.get(intent.locality)!]
      : (q.localityIds ?? []).map((id) => id.toLowerCase()).filter((id) => regionLocalities.has(id));
    return this.select(regionId, intent, idOf, q.origin, localityIds);
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

  /** Места каталога по намерению: поиск по категориям, фильтры и порядок, описания из обогащения. */
  private async select(
    regionId: string,
    intent: AssistantIntent,
    idOf: ReadonlyMap<string, string>,
    origin: LonLat | undefined,
    localityIds: readonly string[],
  ): Promise<AssistantResultDto> {
    const byLocality = localityIds.length > 0;
    // Поиск в населённом пункте — без радиуса от точки туриста (Буковель из Яремче — дальше 5 км); расстояние
    // по-прежнему считается от точки.
    const radius = origin && !byLocality ? (intent.radiusMeters ?? ASSISTANT_RADIUS_DEFAULT) : undefined;
    const searches = intent.categories.length
      ? intent.categories.map((code) => ({ categoryId: idOf.get(code) }))
      : [{ categoryId: undefined }];
    const pages = await Promise.all(
      searches.map((s) =>
        this.guide.search(regionId, {
          origin,
          radius,
          categoryId: s.categoryId,
          text: intent.nameQuery ?? undefined,
          // TODO(локації): передать localityIds в поиск каталога, когда в GET /places/search появится параметр.
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
    if (byLocality) {
      const localityOf = await this.repo.placeLocalities(
        regionId,
        found.map((p) => p.id),
      );
      const wanted = new Set(localityIds);
      found = found.filter((p) => wanted.has(localityOf.get(p.id) ?? ""));
    }
    // Несколько категорий: общий порядок — по расстоянию (с точкой), иначе как пришло.
    if (origin && pages.length > 1)
      found = found.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));

    const notes: AssistantNote[] = [];
    if (!origin && intent.radiusMeters !== null) notes.push("no_origin");
    if (intent.openNow) {
      const open = found.filter((p) => p.openNow === true);
      if (open.length) found = open;
      else if (found.length) notes.push("none_open");
    }
    const enrichment = await this.repo.enrichments(
      regionId,
      found.map((p) => p.id),
    );
    let items: AssistantPlaceDto[] = found.map((place) => {
      const e = enrichment.get(place.id);
      const d = describe(e);
      return {
        place,
        priceLevel: e?.google?.priceLevel ?? null,
        kidsFriendly: kidsFriendly(e),
        description: d.text,
        descriptionSource: d.source,
        descriptionUrl: d.url,
      };
    });
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
        notes,
      };
    }
    return { intent, items: items.slice(0, ASSISTANT_PLACES_MAX), route: null, notes };
  }
}

/** Намерение «уточніть»: прежнее (если было) — чтобы следующий запрос продолжил диалог. */
function clarifyIntent(previous: AssistantIntent | null, allowed: ReadonlySet<string>): AssistantIntent {
  return {
    kind: previous?.kind === "tour" ? "tour" : "places",
    // Намерение пришло с клиента: только коды каталога региона.
    categories: (previous?.categories ?? []).filter((c) => allowed.has(c)),
    nameQuery: previous?.nameQuery ?? null,
    locality: null,
    radiusMeters: previous?.radiusMeters ?? null,
    priceMin: previous?.priceMin ?? null,
    priceMax: previous?.priceMax ?? null,
    withKids: previous?.withKids ?? false,
    openNow: previous?.openNow ?? false,
    clarify: true,
    suggestions: [],
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

// Unit (Claude, Speech-to-Text, каталог и БД подменены): ассистент подбирает только места каталога по намерению
// модели — категории, радиус, цены и «з дітьми» из обогащения, маршрут экскурсии; без ключа и сверх суточного
// предела — 503; сбои Claude — 502/504; ответ модели без инструмента — «уточніть».
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "../../common/http/index.js";
import type { GuideService, PlaceSummaryDto, ScheduleRows } from "../guide/index.js";
import type { AssistantRepository, KeywordQuery, PlaceEnrichmentFacts } from "./assistant.repository.js";
import type { RegionsRepository } from "../regions/index.js";
import {
  AssistantService,
  describe as describePlace,
  nameHasStems,
  nameStems,
  placeTypeCategories,
  shorten,
  wantsBest,
} from "./assistant.service.js";
import { AssistantBudget } from "./budget.js";
import { INTENT_TOOL, type AssistantIntent } from "./intent.js";
import { AssistantUpstreamError, type AssistantLlm, type AssistantSpeech } from "./providers.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const YAREMCHE = "0190f5c2-7d3e-7000-8000-000000000301";
const POLIANYTSIA = "0190f5c2-7d3e-7000-8000-000000000302";
const YAREMCHE_AT = { lon: 24.551, lat: 48.451 };
const BUKOVEL_AT = { lon: 24.417, lat: 48.367 };
const EAT = "0190f5c2-7d3e-7000-8000-000000000101";
const CAFES = "0190f5c2-7d3e-7000-8000-000000000102";
const MUSEUMS = "0190f5c2-7d3e-7000-8000-000000000103";
const EMPTY = "0190f5c2-7d3e-7000-8000-000000000104";
const STAY = "0190f5c2-7d3e-7000-8000-000000000105";
const HOTELS = "0190f5c2-7d3e-7000-8000-000000000106";
const RESTAURANTS = "0190f5c2-7d3e-7000-8000-000000000107";
const NEARBY = "0190f5c2-7d3e-7000-8000-000000000108";
const NATURE = "0190f5c2-7d3e-7000-8000-000000000109";
const RELAX = "0190f5c2-7d3e-7000-8000-000000000110";
const CHANY = "0190f5c2-7d3e-7000-8000-000000000111";
const TRANSFER = "0190f5c2-7d3e-7000-8000-000000000112";
const TAXI = "0190f5c2-7d3e-7000-8000-000000000113";
const FUN = "0190f5c2-7d3e-7000-8000-000000000114";
const EXCURSIONS = "0190f5c2-7d3e-7000-8000-000000000115";

const place = (n: number, over: Partial<PlaceSummaryDto> = {}): PlaceSummaryDto => ({
  id: `0190f5c2-7d3e-7000-8000-0000000002${String(n).padStart(2, "0")}`,
  categoryId: CAFES,
  name: { uk: `Місце ${n}` },
  address: null,
  location: { lon: 24.5, lat: 48.4 + n / 100 },
  distanceMeters: n * 100,
  recommended: false,
  adLabel: null,
  openNow: true,
  phone: null,
  cover: null,
  coverPhoto: null,
  peak: null,
  ...over,
});

const google = (over: Partial<NonNullable<PlaceEnrichmentFacts["google"]>> = {}) => ({
  typeLabel: null,
  summary: null,
  priceLevel: null,
  rating: 4.9,
  ratingCount: 10,
  mapsUri: null,
  amenities: [],
  reviews: [],
  photos: [],
  ...over,
});

const intent = (over: Partial<AssistantIntent> = {}): AssistantIntent => ({
  kind: "places",
  categories: ["cafes"],
  nameQuery: null,
  keywords: [],
  locality: null,
  radiusMeters: null,
  priceMin: null,
  priceMax: null,
  withKids: false,
  openNow: false,
  clarify: false,
  suggestions: ["cheaper"],
  days: null,
  dayParts: [],
  start: null,
  related: [],
  scope: null,
  scopeLocalityIds: [],
  transport: null,
  sort: null,
  ...over,
});

const reply = (input: unknown, stop: Anthropic.Message["stop_reason"] = "tool_use") =>
  ({
    content: [{ type: "tool_use", id: "t", name: INTENT_TOOL, input }],
    stop_reason: stop,
  }) as unknown as Anthropic.Message;

type SearchArg = {
  origin?: { lon: number; lat: number };
  localityIds?: readonly string[];
  categoryId?: string;
  ids?: readonly string[];
  radius?: number;
  text?: string;
};

function setup(
  opts: {
    llm?: Partial<AssistantLlm>;
    speech?: Partial<AssistantSpeech>;
    places?: PlaceSummaryDto[];
    enrichment?: Record<string, PlaceEnrichmentFacts>;
    dailyLimit?: number;
    userDailyLimit?: number;
    regionStatus?: string;
    /** place_id → locality_id. */
    placeLocality?: Record<string, string>;
    /** Выдача каталога в зависимости от точки поиска. */
    searchAt?: (s: SearchArg) => PlaceSummaryDto[] | undefined;
    /** Совпадения по ключевым словам (id → вес). */
    keywordMatches?: (q: KeywordQuery) => { id: string; score: number }[];
    schedules?: Record<string, ScheduleRows>;
    timezone?: string;
    /** Лучшие места региона по рейтингу (план «по всьому регіону»). */
    topRated?: (q: {
      categoryIds: readonly string[];
      localityIds?: readonly string[];
      limit: number;
    }) => string[];
  } = {},
) {
  const guide = {
    categories: vi.fn(() =>
      Promise.resolve({
        items: [
          { id: EAT, parentId: null, code: "eat", name: { uk: "Де поїсти" }, placeCount: 3 },
          { id: CAFES, parentId: EAT, code: "cafes", name: { uk: "Кафе" }, placeCount: 3 },
          { id: MUSEUMS, parentId: null, code: "museums", name: { uk: "Музеї" }, placeCount: 2 },
          { id: EMPTY, parentId: null, code: "empty", name: { uk: "Порожня" }, placeCount: 0 },
          { id: STAY, parentId: null, code: "stay", name: { uk: "Де жити" }, placeCount: 2 },
          { id: HOTELS, parentId: STAY, code: "hotels", name: { uk: "Готелі" }, placeCount: 2 },
          { id: RESTAURANTS, parentId: EAT, code: "restaurants", name: { uk: "Ресторани" }, placeCount: 2 },
          { id: NEARBY, parentId: null, code: "nearby", name: { uk: "Що поруч" }, placeCount: 2 },
          { id: NATURE, parentId: NEARBY, code: "nature", name: { uk: "Пам'ятки природи" }, placeCount: 2 },
          { id: RELAX, parentId: null, code: "relax", name: { uk: "Релакс" }, placeCount: 1 },
          { id: CHANY, parentId: RELAX, code: "chany", name: { uk: "Чани та сауни" }, placeCount: 1 },
          { id: TRANSFER, parentId: null, code: "transfer", name: { uk: "Транспорт" }, placeCount: 1 },
          { id: TAXI, parentId: TRANSFER, code: "taxi", name: { uk: "Таксі" }, placeCount: 1 },
          { id: FUN, parentId: null, code: "fun", name: { uk: "Розваги" }, placeCount: 1 },
          { id: EXCURSIONS, parentId: FUN, code: "excursions", name: { uk: "Екскурсії" }, placeCount: 1 },
        ],
      }),
    ),
    search: vi.fn((_r: string, s: SearchArg) =>
      Promise.resolve({
        // Как каталог: localityIds — только места этих пунктов (place_id → locality_id из opts.placeLocality).
        items: (opts.searchAt?.(s) ?? opts.places ?? [place(1), place(2)]).filter(
          (p) =>
            (!s.localityIds?.length || s.localityIds.includes(opts.placeLocality?.[p.id] ?? "")) &&
            (!s.ids || s.ids.includes(p.id)),
        ),
        nextOffset: null,
        radiusMeters: null,
      }),
    ),
  };
  const llm = { enabled: true, create: vi.fn(() => Promise.resolve(reply(intent()))), ...opts.llm };
  const speech = { enabled: true, recognize: vi.fn(() => Promise.resolve("кава поруч")), ...opts.speech };
  const repo = {
    enrichments: vi.fn((_r: string, ids: readonly string[]) =>
      Promise.resolve(
        new Map(ids.flatMap((id) => (opts.enrichment?.[id] ? [[id, opts.enrichment[id]] as const] : []))),
      ),
    ),
    keywordMatches: vi.fn((_r: string, q: KeywordQuery) => Promise.resolve(opts.keywordMatches?.(q) ?? [])),
    ratings: vi.fn((_r: string, ids: readonly string[]) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) => {
            const g = opts.enrichment?.[id]?.google;
            return g
              ? [
                  [
                    id,
                    {
                      rating: g.rating,
                      ratingCount: g.ratingCount,
                      priceLevel: g.priceLevel,
                      amenities: g.amenities,
                      typeLabel: g.typeLabel,
                    },
                  ] as const,
                ]
              : [];
          }),
        ),
      ),
    ),
    schedules: vi.fn(() => Promise.resolve(new Map(Object.entries(opts.schedules ?? {})))),
    topRated: vi.fn(
      (_r: string, q: { categoryIds: readonly string[]; localityIds?: readonly string[]; limit: number }) =>
        Promise.resolve(opts.topRated?.(q) ?? []),
    ),
    localities: vi.fn(() =>
      Promise.resolve([
        { id: YAREMCHE, code: "yaremche", name_i18n: { uk: "Яремче" }, location: YAREMCHE_AT },
        {
          id: POLIANYTSIA,
          code: "polianytsia",
          name_i18n: { uk: "Поляниця (Буковель)" },
          location: BUKOVEL_AT,
        },
      ]),
    ),
  };
  const budget = new AssistantBudget({ dailyLimit: opts.dailyLimit, userDailyLimit: opts.userDailyLimit });
  const regions = {
    findById: vi.fn(() =>
      Promise.resolve({
        id: REGION,
        status: opts.regionStatus ?? "active",
        timezone: opts.timezone ?? "Europe/Kyiv",
      }),
    ),
  };
  const service = new AssistantService(
    repo as unknown as AssistantRepository,
    guide as unknown as GuideService,
    llm as AssistantLlm,
    speech as AssistantSpeech,
    budget,
    regions as unknown as RegionsRepository,
  );
  return { service, guide, llm, speech, repo, budget, regions };
}

const ask = (text = "кав'ярня поруч", over: Partial<Parameters<AssistantService["query"]>[2]> = {}) => ({
  text,
  history: [],
  previous: null,
  ...over,
});

const status = (e: unknown) => (e as ApiError).getStatus();

describe("AssistantService.query", () => {
  it("категории модели → поиск каталога по id категории с радиусом; в модель — только категории с местами", async () => {
    const create = vi.fn((_p: Anthropic.MessageCreateParamsNonStreaming) =>
      Promise.resolve(reply(intent({ radiusMeters: 1500 }))),
    );
    const { service, guide } = setup({ llm: { create } });
    const res = await service.query(REGION, USER, ask("кава", { origin: { lon: 24.5, lat: 48.4 } }));
    expect(guide.categories).toHaveBeenCalledWith(REGION);
    const tool = create.mock.calls[0]![0].tools![0] as Anthropic.Tool;
    expect(JSON.stringify(tool.input_schema)).not.toContain('"empty"');
    expect(guide.search).toHaveBeenCalledWith(REGION, {
      origin: { lon: 24.5, lat: 48.4 },
      radius: 1500,
      categoryId: CAFES,
      text: undefined,
      limit: 30,
      offset: 0,
    });
    expect(res.items.map((i) => i.place.name.uk)).toEqual(["Місце 1", "Місце 2"]);
    expect(res.route).toBeNull();
    expect(res.intent.suggestions).toEqual(["cheaper"]);
  });

  it("без точки радиус не применяется (пояснение no_origin); код вне каталога отбрасывается", async () => {
    const { service, guide } = setup({
      llm: {
        create: vi.fn(() =>
          Promise.resolve(reply(intent({ categories: ["cafes", "invented"], radiusMeters: 800 }))),
        ),
      },
    });
    const res = await service.query(REGION, USER, ask());
    expect(guide.search).toHaveBeenCalledTimes(1);
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ origin: undefined, radius: undefined }),
    );
    expect(res.notes).toEqual(["no_origin"]);
  });

  it("цены и описания — только из обогащения; фильтр цены; «з дітьми» — первыми", async () => {
    const [a, b, c] = [place(1), place(2), place(3)];
    const { service } = setup({
      places: [a, b, c],
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ priceMax: 2, withKids: true })))) },
      enrichment: {
        [a.id]: { google: google({ priceLevel: 2 }), wiki: null, ai: null },
        [b.id]: {
          google: google({ priceLevel: 1, amenities: ["kids_menu"] }),
          wiki: null,
          ai: "Кафе з терасою. Відвідувачі хвалять каву.",
        },
        [c.id]: { google: google({ priceLevel: 4 }), wiki: null, ai: null },
      },
    });
    const res = await service.query(REGION, USER, ask());
    expect(res.items.map((i) => [i.place.id, i.priceLevel, i.kidsFriendly])).toEqual([
      [b.id, 1, true],
      [a.id, 2, false],
    ]);
    expect(res.items[0]).toMatchObject({
      description: "Кафе з терасою. Відвідувачі хвалять каву.",
      descriptionSource: "ai",
    });
    expect(res.items[1]).toMatchObject({ description: null, descriptionSource: null });
  });

  it("цен нет ни у одного места — без фильтра, с пояснением; «відкрито» — фильтр или пояснение", async () => {
    const { service } = setup({
      places: [place(1, { openNow: false }), place(2, { openNow: null })],
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ priceMin: 3, openNow: true })))) },
    });
    const res = await service.query(REGION, USER, ask());
    expect(res.items).toHaveLength(2);
    expect(res.notes).toEqual(["none_open", "price_unknown"]);
  });

  it("экскурсия: остановки в порядке обхода от точки, длина маршрута, описание из Вікіпедії со ссылкой", async () => {
    const far = place(5, { categoryId: MUSEUMS });
    const near = place(1, { categoryId: MUSEUMS });
    const { service } = setup({
      places: [far, near],
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ kind: "tour", categories: ["museums"] })))) },
      enrichment: {
        [near.id]: {
          google: null,
          wiki: {
            lang: "uk",
            title: "Музей",
            url: "https://uk.wikipedia.org/wiki/M",
            extract: "Музей у Яремчі.",
            image: null,
          },
          ai: null,
        },
      },
    });
    const res = await service.query(REGION, USER, ask("екскурсія", { origin: { lon: 24.5, lat: 48.4 } }));
    expect(res.items.map((i) => i.place.id)).toEqual([near.id, far.id]);
    expect(res.route!.lengthMeters).toBeGreaterThan(4000);
    // Текст статьи туристу не отдаётся: нет пересказа — нет описания (CC BY-SA, только пересказ и ссылка).
    expect(res.items[0]).toMatchObject({ description: null, descriptionSource: null, descriptionUrl: null });
  });

  it("описание: пересказ ИИ со ссылкой на статью; без пересказа — описание Google без текста статьи", () => {
    const wiki = {
      lang: "uk",
      title: "M",
      url: "https://uk.wikipedia.org/wiki/M",
      extract: "Стаття.",
      image: null,
    };
    expect(describePlace({ google: null, wiki, ai: "Пересказ." })).toEqual({
      text: "Пересказ.",
      source: "ai",
      url: wiki.url,
    });
    expect(describePlace({ google: google({ summary: "Опис Google" }), wiki, ai: null })).toEqual({
      text: "Опис Google",
      source: "google",
      url: null,
    });
    expect(describePlace({ google: null, wiki, ai: null })).toEqual({ text: null, source: null, url: null });
  });

  it("модель ответила текстом, отказала или не нашла категорий — «уточніть» без поиска, прежнее намерение сохраняется", async () => {
    for (const msg of [
      { content: [{ type: "text", text: "Рекомендую «Вигадане кафе»" }], stop_reason: "end_turn" },
      reply(intent(), "refusal"),
      reply(intent({ categories: [], clarify: true })),
    ]) {
      const { service, guide } = setup({
        llm: { create: vi.fn(() => Promise.resolve(msg as Anthropic.Message)) },
      });
      const res = await service.query(
        REGION,
        USER,
        // Намерение с клиента: чужой код не попадает в ответ.
        ask("як справи?", { previous: intent({ categories: ["museums", "forged"] }) }),
      );
      expect(res.intent.categories).not.toContain("forged");
      expect(res.intent.clarify).toBe(true);
      expect(res.items).toEqual([]);
      expect(guide.search).not.toHaveBeenCalled();
    }
  });

  it("без ключа Claude — 503 errors.assistant.unavailable, каталог и модель не трогаются", async () => {
    const { service, guide, llm } = setup({ llm: { enabled: false } });
    const err = await service.query(REGION, USER, ask()).catch((e: unknown) => e);
    expect(status(err)).toBe(503);
    expect((err as ApiError).messageKey).toBe("errors.assistant.unavailable");
    expect(guide.categories).not.toHaveBeenCalled();
    expect(llm.create).not.toHaveBeenCalled();
  });

  it("сбой Claude: таймаут — 504, прочее — 502", async () => {
    for (const [reason, code] of [
      ["timeout", 504],
      ["upstream", 502],
    ] as const) {
      const { service } = setup({
        llm: { create: vi.fn(() => Promise.reject(new AssistantUpstreamError(reason))) },
      });
      expect(status(await service.query(REGION, USER, ask()).catch((e: unknown) => e))).toBe(code);
    }
  });

  it("суточный бюджет: запрос — 1 единица, голос — 2; сверх общего — 503, на следующие сутки снова можно", async () => {
    const { service, llm, budget } = setup({ dailyLimit: 3 });
    budget.now = () => new Date("2026-11-03T10:00:00Z");
    await service.query(REGION, USER, ask());
    await service.transcribe(REGION, USER, Buffer.from("x"), "audio/webm");
    expect(status(await service.query(REGION, "other-user", ask()).catch((e: unknown) => e))).toBe(503);
    expect(llm.create).toHaveBeenCalledTimes(1);
    budget.now = () => new Date("2026-11-04T00:00:01Z");
    await service.query(REGION, USER, ask());
    expect(llm.create).toHaveBeenCalledTimes(2);
  });

  it("предел пользователя — 429 errors.assistant.dailyLimit, другой пользователь не затронут", async () => {
    const { service, llm, budget } = setup({ userDailyLimit: 2 });
    budget.now = () => new Date("2026-11-03T10:00:00Z");
    await service.query(REGION, USER, ask());
    await service.query(REGION, USER, ask());
    const err = await service.query(REGION, USER, ask()).catch((e: unknown) => e);
    expect(status(err)).toBe(429);
    expect((err as ApiError).messageKey).toBe("errors.assistant.dailyLimit");
    await service.query(REGION, "other-user", ask());
    expect(llm.create).toHaveBeenCalledTimes(3);
  });

  it("неверный ключ Claude (401/403) — 503, а не 502", async () => {
    const { service } = setup({
      llm: { create: vi.fn(() => Promise.reject(new AssistantUpstreamError("config", 401))) },
    });
    expect(status(await service.query(REGION, USER, ask()).catch((e: unknown) => e))).toBe(503);
  });
});

describe("проживання", () => {
  it("«готель поруч»: категории проживания — в модель из каталога, поиск — по коду модели (hotels)", async () => {
    const hotel = place(1, { categoryId: HOTELS, name: { uk: "Готель «Карпати»" } });
    const create = vi.fn((_p: Anthropic.MessageCreateParamsNonStreaming) =>
      Promise.resolve(reply(intent({ categories: ["hotels"], radiusMeters: 1000 }))),
    );
    const { service, guide } = setup({ places: [hotel], llm: { create } });
    const res = await service.query(REGION, USER, ask("готель поруч", { origin: { lon: 24.5, lat: 48.4 } }));
    const params = create.mock.calls[0]![0];
    const schema = JSON.stringify((params.tools![0] as Anthropic.Tool).input_schema);
    expect(schema).toContain('"stay"');
    expect(schema).toContain('"hotels"');
    expect(String(params.messages[0]!.content)).toContain("- hotels: Готелі (розділ «Де жити»)");
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ categoryId: HOTELS, radius: 1000, origin: { lon: 24.5, lat: 48.4 } }),
    );
    expect(res.items.map((i) => i.place.name.uk)).toEqual(["Готель «Карпати»"]);
  });
});

describe("населені пункти", () => {
  it("«прокат лиж у Буковелі» при выбранном Яремче — ищем в Поляниці (Буковель), без радиуса от точки", async () => {
    const yaremche = place(1, { name: { uk: "Прокат у Яремчі" } });
    const bukovel = place(2, { name: { uk: "Прокат у Буковелі" } });
    const create = vi.fn((_p: Anthropic.MessageCreateParamsNonStreaming) =>
      Promise.resolve(reply(intent({ categories: ["cafes"], locality: "polianytsia" }))),
    );
    const { service, guide } = setup({
      places: [yaremche, bukovel],
      llm: { create },
      placeLocality: { [yaremche.id]: YAREMCHE, [bukovel.id]: POLIANYTSIA },
    });
    const res = await service.query(
      REGION,
      USER,
      ask("прокат лиж у Буковелі", { origin: { lon: 24.55, lat: 48.45 }, localityIds: [YAREMCHE] }),
    );
    // В инструменте — коды пунктов с названиями и синонимами.
    const tool = create.mock.calls[0]![0].tools![0] as Anthropic.Tool;
    const schema = JSON.stringify(tool.input_schema);
    expect(schema).toContain('"polianytsia"');
    expect(schema).toContain("Буковель");
    // Поиск — в Поляниці (localityIds), не в выбранном Яремче; точка туриста — для расстояния, без радиуса.
    expect(guide.search).toHaveBeenCalledTimes(1);
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({
        origin: { lon: 24.55, lat: 48.45 },
        radius: undefined,
        localityIds: [POLIANYTSIA],
      }),
    );
    expect(res.items.map((i) => i.place.name.uk)).toEqual(["Прокат у Буковелі"]);
    expect(res.intent.locality).toBe("polianytsia");
  });

  it("Буковель из Яремче: поиск по пункту, расстояние — от точки туриста, не от центра пункта", async () => {
    const bukovel = place(99, { name: { uk: "Прокат у Буковелі" }, location: BUKOVEL_AT });
    const { service, guide } = setup({
      // Каталог считает distanceMeters от переданной точки: от туриста в Яремче — 14 км, от центра Поляниці — 0.
      searchAt: (s) => [{ ...bukovel, distanceMeters: s.origin?.lat === YAREMCHE_AT.lat ? 14_000 : 0 }],
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ locality: "polianytsia" })))) },
      placeLocality: { [bukovel.id]: POLIANYTSIA },
    });
    const res = await service.query(REGION, USER, ask("прокат у Буковелі", { origin: YAREMCHE_AT }));
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ origin: YAREMCHE_AT, radius: undefined, localityIds: [POLIANYTSIA] }),
    );
    expect(res.items.map((i) => [i.place.name.uk, i.place.distanceMeters])).toEqual([
      ["Прокат у Буковелі", 14_000],
    ]);
  });

  it("радиус в запросе без названного пункта — выбор туриста не применяется, поиск в радиусе от точки", async () => {
    const { service, guide } = setup({
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ radiusMeters: 500 })))) },
    });
    await service.query(
      REGION,
      USER,
      ask("кава в 500 м", { origin: YAREMCHE_AT, localityIds: [POLIANYTSIA] }),
    );
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ origin: YAREMCHE_AT, radius: 500, localityIds: undefined }),
    );
  });

  it("радиус в запросе без точки туриста — действует выбор туриста, без пометки no_origin", async () => {
    const { service, guide } = setup({
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ radiusMeters: 500 })))) },
    });
    const res = await service.query(REGION, USER, ask("кава поруч", { localityIds: [YAREMCHE] }));
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ radius: undefined, localityIds: [YAREMCHE] }),
    );
    expect(res.notes).not.toContain("no_origin");
  });

  it("радиус в запросе и названный пункт — поиск по пункту из запроса", async () => {
    const { service, guide } = setup({
      llm: {
        create: vi.fn(() => Promise.resolve(reply(intent({ radiusMeters: 500, locality: "polianytsia" })))),
      },
    });
    await service.query(
      REGION,
      USER,
      ask("кава в Буковелі", { origin: YAREMCHE_AT, localityIds: [YAREMCHE] }),
    );
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ origin: YAREMCHE_AT, radius: undefined, localityIds: [POLIANYTSIA] }),
    );
  });

  it("пункт не назван — действует выбор туриста; чужие id и код от модели вне списка — игнорируются", async () => {
    const a = place(1);
    const b = place(2);
    const { service } = setup({
      places: [a, b],
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ locality: "atlantis" })))) },
      placeLocality: { [a.id]: YAREMCHE, [b.id]: POLIANYTSIA },
    });
    const res = await service.query(
      REGION,
      USER,
      ask("кава", { localityIds: [YAREMCHE, "0190f5c2-7d3e-7000-8000-000000000999"] }),
    );
    expect(res.intent.locality).toBeNull();
    expect(res.items.map((i) => i.place.id)).toEqual([a.id]);
  });
});

describe("AssistantService.transcribe", () => {
  it("текст распознавания; без ключа — 503; отклонённое аудио — 422", async () => {
    const ok = setup();
    expect(await ok.service.transcribe(REGION, USER, Buffer.from("x"), "audio/ogg")).toBe("кава поруч");
    expect(ok.speech.recognize).toHaveBeenCalledWith(Buffer.from("x"), "audio/ogg");
    const off = setup({ speech: { enabled: false } });
    expect(
      status(
        await off.service.transcribe(REGION, USER, Buffer.from("x"), "audio/webm").catch((e: unknown) => e),
      ),
    ).toBe(503);
    const bad = setup({
      speech: { recognize: vi.fn(() => Promise.reject(new AssistantUpstreamError("rejected", 400))) },
    });
    expect(
      status(
        await bad.service.transcribe(REGION, USER, Buffer.from("x"), "audio/webm").catch((e: unknown) => e),
      ),
    ).toBe(422);
    const config = setup({
      speech: { recognize: vi.fn(() => Promise.reject(new AssistantUpstreamError("config", 403))) },
    });
    expect(
      status(
        await config.service
          .transcribe(REGION, USER, Buffer.from("x"), "audio/webm")
          .catch((e: unknown) => e),
      ),
    ).toBe(503);
  });

  it("регион не active — 404 до траты бюджета и распознавания", async () => {
    const { service, speech, budget } = setup({ regionStatus: "draft", userDailyLimit: 1 });
    const spend = vi.spyOn(budget, "spend");
    expect(
      status(await service.transcribe(REGION, USER, Buffer.from("x"), "audio/webm").catch((e: unknown) => e)),
    ).toBe(404);
    expect(spend).not.toHaveBeenCalled();
    expect(speech.recognize).not.toHaveBeenCalled();
  });
});

describe("блюдо или кухня (ключевые слова)", () => {
  const sushi = (id: number, name: string, over: Partial<PlaceSummaryDto> = {}) =>
    place(id, { name: { uk: name }, categoryId: RESTAURANTS, ...over });

  it("«суші»: поиск по названию, типу, описаниям и отзывам во всём разделе «Де поїсти»; порядок — от ближайшего (релевантность — отбор)", async () => {
    const byName = sushi(1, "Суши Кафе");
    const byReview = sushi(2, "Family", { categoryId: CAFES });
    const byAi = sushi(3, "KUMA");
    const { service, repo, guide } = setup({
      places: [byName, byReview, byAi],
      keywordMatches: () => [
        { id: byName.id, score: 9 },
        { id: byAi.id, score: 5 },
        { id: byReview.id, score: 1 },
      ],
      enrichment: {
        [byAi.id]: { google: google({ rating: 4.8 }), wiki: null, ai: "Хвалять суші та роли." },
        [byReview.id]: { google: google({ rating: 4.9 }), wiki: null, ai: null },
      },
      llm: {
        create: vi.fn(() =>
          Promise.resolve(reply(intent({ categories: ["restaurants"], keywords: ["суші", "sushi"] }))),
        ),
      },
    });
    const res = await service.query(REGION, USER, ask("суші", { origin: YAREMCHE_AT }));
    const q = repo.keywordMatches.mock.calls[0]![1];
    expect(q).toMatchObject({ categoryIds: [EAT], origin: YAREMCHE_AT, radius: 5000, minScore: 1 });
    expect(q.pattern).toContain("роли");
    expect(q.pattern.startsWith("\\m")).toBe(true);
    expect(q.namePattern).toContain("sushi");
    // Карточки — поиском каталога по найденным id (не по названию).
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ ids: [byName.id, byAi.id, byReview.id], origin: YAREMCHE_AT }),
    );
    expect(guide.search).toHaveBeenCalledTimes(1);
    expect(res.items.map((i) => i.place.name.uk)).toEqual(["Суши Кафе", "Family", "KUMA"]);
    expect(res.notes).toEqual([]);
  });

  it("рядом мало и радиус не назван — поиск по всему региону (widened)", async () => {
    const a = sushi(1, "Суші 1");
    const b = sushi(2, "Суші 2");
    const c = sushi(3, "Суші 3");
    const { service, repo } = setup({
      places: [a, b, c],
      keywordMatches: (q) =>
        q.radius === undefined ? [a, b, c].map((p) => ({ id: p.id, score: 4 })) : [{ id: a.id, score: 4 }],
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ categories: [], keywords: ["суші"] })))) },
    });
    const res = await service.query(REGION, USER, ask("суші", { origin: YAREMCHE_AT }));
    expect(repo.keywordMatches).toHaveBeenCalledTimes(2);
    // Без категорий — одних упоминаний в отзывах мало.
    expect(repo.keywordMatches.mock.calls[0]![1]).toMatchObject({ categoryIds: [], minScore: 2 });
    expect(res.items).toHaveLength(3);
    expect(res.notes).toEqual(["widened"]);
  });

  it("блюда нет нигде — места категории с пояснением keyword_none", async () => {
    const { service, guide } = setup({
      llm: {
        create: vi.fn(() => Promise.resolve(reply(intent({ categories: ["cafes"], keywords: ["рамен"] })))),
      },
    });
    const res = await service.query(REGION, USER, ask("рамен"));
    expect(guide.search).toHaveBeenCalledWith(REGION, expect.objectContaining({ categoryId: CAFES }));
    expect(res.items).toHaveLength(2);
    expect(res.notes).toEqual(["keyword_none"]);
  });

  it("старое намерение: «суші» в nameQuery — по названию мало, добавляются найденные по описаниям и отзывам", async () => {
    const named = sushi(1, "Доставка суші");
    const described = sushi(2, "KUMA");
    const { service } = setup({
      searchAt: (s) => (s.ids ? [named, described] : [named]),
      keywordMatches: () => [
        { id: named.id, score: 4 },
        { id: described.id, score: 5 },
      ],
      llm: {
        create: vi.fn(() =>
          Promise.resolve(reply(intent({ categories: ["restaurants"], nameQuery: "суші" }))),
        ),
      },
    });
    const res = await service.query(REGION, USER, ask("суші"));
    expect(res.items.map((i) => i.place.name.uk)).toEqual(["Доставка суші", "KUMA"]);
  });

  it("nameQuery — название заведения («Суші Барберрі»): синонимами не расширяется", async () => {
    const named = sushi(1, "Суші Барберрі");
    const { service, repo } = setup({
      places: [named],
      llm: {
        create: vi.fn(() =>
          Promise.resolve(reply(intent({ categories: ["restaurants"], nameQuery: "Суші Барберрі" }))),
        ),
      },
    });
    const res = await service.query(REGION, USER, ask("Суші Барберрі"));
    expect(repo.keywordMatches).not.toHaveBeenCalled();
    expect(res.items.map((i) => i.place.name.uk)).toEqual(["Суші Барберрі"]);
  });

  it("мест больше 10 — до 30 (клиент показывает по 10)", async () => {
    const many = Array.from({ length: 40 }, (_, i) => place(i + 1));
    const { service } = setup({ places: many });
    const res = await service.query(REGION, USER, ask());
    expect(res.items).toHaveLength(30);
  });
});

describe("план відпочинку", () => {
  const NOTES = "plan_notes";
  const at = (dxKm: number) => ({ lon: YAREMCHE_AT.lon + dxKm / 73.8, lat: YAREMCHE_AT.lat });
  const nature = place(1, { categoryId: NATURE, name: { uk: "Водоспад Пробій" }, location: at(0.5) });
  const sight = place(2, { categoryId: NATURE, name: { uk: "Скелі" }, location: at(1) });
  const lunch = place(3, { categoryId: RESTAURANTS, name: { uk: "Колиба" }, location: at(1.2) });
  const dinner = place(4, { categoryId: RESTAURANTS, name: { uk: "Ресторан" }, location: at(1.4) });
  const chan = place(5, { categoryId: CHANY, name: { uk: "Чан" }, location: at(1.6) });
  const bySection: Record<string, PlaceSummaryDto[]> = {
    [NEARBY]: [nature, sight],
    [EAT]: [lunch, dinner],
    [RELAX]: [chan],
  };
  const planIntent = (over: Partial<AssistantIntent> = {}) =>
    intent({ kind: "plan", categories: [], days: 1, dayParts: [], start: null, ...over });
  const notesReply = (notes: { n: number; text: string }[]) =>
    ({
      content: [{ type: "tool_use", id: "n", name: NOTES, input: { notes } }],
      stop_reason: "tool_use",
    }) as unknown as Anthropic.Message;

  function planSetup(
    i: AssistantIntent,
    notes: Promise<Anthropic.Message>,
    extra: Parameters<typeof setup>[0] = {},
  ) {
    const create = vi
      .fn<
        (
          p: Anthropic.MessageCreateParamsNonStreaming,
          o?: { timeoutMs?: number },
        ) => Promise<Anthropic.Message>
      >()
      .mockResolvedValueOnce(reply(i))
      .mockReturnValueOnce(notes);
    const s = setup({
      llm: { create },
      searchAt: (q) => (q.categoryId ? bySection[q.categoryId] : []),
      ...extra,
    });
    // Суббота 7.11.2026, 9:00 по Киеву.
    s.service.now = () => new Date("2026-11-07T07:00:00Z");
    return { ...s, create };
  }

  it("«план на день»: части дня с местами каталога, время, переезды; пояснения Claude по фактам", async () => {
    const { service, guide, create, repo } = planSetup(
      planIntent(),
      Promise.resolve(notesReply([{ n: 1, text: "Почніть день біля водоспаду, поки мало людей." }])),
    );
    const res = await service.query(REGION, USER, ask("склади план на день", { origin: YAREMCHE_AT }));
    // Кандидаты — по разделам каталога в радиусе плана от жилья.
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ categoryId: EAT, origin: YAREMCHE_AT, radius: 15_000 }),
    );
    expect(repo.schedules).toHaveBeenCalledWith(REGION, expect.any(Array), ["2026-11-07"]);
    const plan = res.plan!;
    expect(plan.days).toHaveLength(1);
    expect(plan.days[0]!.date).toBe("2026-11-07");
    expect(plan.days[0]!.parts.map((p) => [p.part, p.stops.map((s) => s.role)])).toEqual([
      ["morning", ["see", "see"]],
      ["afternoon", ["eat"]],
      ["evening", ["eat", "relax"]],
    ]);
    // Пункты ссылаются на items (места каталога в порядке плана).
    const stops = plan.days[0]!.parts.flatMap((p) => p.stops);
    expect(stops.map((s) => res.items[s.item]!.place.id)).toEqual(res.items.map((i) => i.place.id));
    expect(stops[0]).toMatchObject({
      start: "09:38",
      travel: "walk",
      note: expect.stringContaining("водоспаду"),
    });
    expect(stops[1]!.note).toBeNull();
    expect(res.route).toBeNull();
    // Пояснения — второй вызов Claude: только факты каталога в теге данных.
    expect(create).toHaveBeenCalledTimes(2);
    const notesMsg = String(create.mock.calls[1]![0].messages[0]!.content);
    expect(notesMsg).toContain("Водоспад Пробій");
    expect(notesMsg).toContain("<facts>");
  });

  it("пояснения не получены (сбой Claude) — план без пояснений, а не ошибка", async () => {
    const { service } = planSetup(planIntent(), Promise.reject(new AssistantUpstreamError("timeout")));
    const res = await service.query(REGION, USER, ask("план", { origin: YAREMCHE_AT }));
    expect(res.plan!.days[0]!.parts.flatMap((p) => p.stops).every((s) => s.note === null)).toBe(true);
  });

  it("«що робити сьогодні ввечері» в 23:30 — план на завтра (plan_tomorrow); вихідні — с субботы", async () => {
    const late = planSetup(planIntent({ dayParts: ["evening"] }), Promise.resolve(notesReply([])));
    late.service.now = () => new Date("2026-11-04T21:30:00Z"); // среда 23:30 в Киеве
    const res = await late.service.query(REGION, USER, ask("що робити ввечері", { origin: YAREMCHE_AT }));
    expect(res.notes).toEqual(["plan_tomorrow"]);
    expect(res.plan!.days[0]!.date).toBe("2026-11-05");
    expect(res.plan!.days[0]!.parts.map((p) => p.part)).toEqual(["evening"]);

    const weekend = planSetup(
      planIntent({ start: "weekend", days: 2, scope: "here", transport: "car" }),
      Promise.resolve(notesReply([])),
    );
    weekend.service.now = () => new Date("2026-11-04T08:00:00Z");
    const w = await weekend.service.query(REGION, USER, ask("план на вихідні", { origin: YAREMCHE_AT }));
    expect(w.plan!.days.map((d) => d.date)).toEqual(["2026-11-07", "2026-11-08"]);
  });

  it("без точки и пунктов — центр плана у лучшей пам'ятки региона; мест нет — plan null", async () => {
    const { service, guide } = planSetup(planIntent(), Promise.resolve(notesReply([])));
    const res = await service.query(REGION, USER, ask("план"));
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ categoryId: EAT, radius: 15_000, origin: expect.any(Object) }),
    );
    expect(res.plan).not.toBeNull();

    const empty = setup({
      llm: { create: vi.fn(() => Promise.resolve(reply(planIntent()))) },
      searchAt: () => [],
    });
    const none = await empty.service.query(REGION, USER, ask("план", { origin: YAREMCHE_AT }));
    expect(none.plan).toBeNull();
    expect(none.items).toEqual([]);
  });

  it("жильё за 50 км (QR отеля в Косові), «план у Яремчі» — план не пустой; кандидаты — от центра пункта", async () => {
    const KOSIV = { lon: 25.09, lat: 48.31 };
    const all = Object.values(bySection).flat();
    const { service, guide } = planSetup(
      planIntent({ locality: "yaremche" }),
      Promise.resolve(notesReply([])),
      { placeLocality: Object.fromEntries(all.map((p) => [p.id, YAREMCHE])) },
    );
    const res = await service.query(REGION, USER, ask("план у Яремчі", { origin: KOSIV }));
    expect(guide.search).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({
        categoryId: EAT,
        origin: YAREMCHE_AT,
        radius: undefined,
        localityIds: [YAREMCHE],
      }),
    );
    const stops = res.plan!.days[0]!.parts.flatMap((p) => p.stops);
    expect(stops.length).toBe(5);
    expect(stops[0]).toMatchObject({ travel: null, travelMeters: null });
  });

  it("пояснения — с коротким таймаутом; бюджет плана — 2 единицы, на втором вызове исчерпан — план без пояснений, не 429", async () => {
    const ok = planSetup(planIntent(), Promise.resolve(notesReply([{ n: 1, text: "Пояснення." }])), {
      userDailyLimit: 2,
    });
    const res = await ok.service.query(REGION, USER, ask("план", { origin: YAREMCHE_AT }));
    expect(ok.create).toHaveBeenCalledTimes(2);
    expect(ok.create.mock.calls[1]![1]).toEqual({ timeoutMs: 9000 });
    expect(res.plan!.days[0]!.parts[0]!.stops[0]!.note).toBe("Пояснення.");

    const tight = planSetup(planIntent(), Promise.resolve(notesReply([{ n: 1, text: "Пояснення." }])), {
      userDailyLimit: 1,
    });
    const cut = await tight.service.query(REGION, USER, ask("план", { origin: YAREMCHE_AT }));
    expect(tight.create).toHaveBeenCalledTimes(1);
    expect(cut.plan!.days[0]!.parts.flatMap((p) => p.stops).every((s) => s.note === null)).toBe(true);
  });

  it("«приїхав на 5 днів з дітьми» без области и передвижения — сначала вопросы, места не ищутся", async () => {
    const { service, guide, create } = planSetup(
      planIntent({ days: 5, withKids: true }),
      Promise.resolve(notesReply([])),
    );
    const res = await service.query(
      REGION,
      USER,
      ask("Я приїхав на 5 днів з дітьми", { origin: YAREMCHE_AT }),
    );
    expect(res.questions).toEqual(["scope", "transport"]);
    expect(res.plan).toBeNull();
    expect(res.items).toEqual([]);
    expect(guide.search).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    // Пункт назван — область не спрашиваем, только передвижение; передвижение сказано — только область.
    const named = planSetup(planIntent({ days: 3, locality: "yaremche" }), Promise.resolve(notesReply([])));
    expect((await named.service.query(REGION, USER, ask("3 дні в Яремчі"))).questions).toEqual(["transport"]);
    const car = planSetup(planIntent({ days: 3, transport: "car" }), Promise.resolve(notesReply([])));
    expect((await car.service.query(REGION, USER, ask("3 дні на авто"))).questions).toEqual(["scope"]);
  });

  /** Районы по региону: по пам'ятці, обеду, ужину и чану вокруг точек в dx км к востоку от Яремче. */
  function regionData(dxs: readonly number[]) {
    let n = 10;
    const areas = dxs.map((dx) => ({
      sights: [
        place(++n, { categoryId: NATURE, location: at(dx) }),
        place(++n, { categoryId: NATURE, location: at(dx + 0.5) }),
      ],
      eat: [
        place(++n, { categoryId: RESTAURANTS, location: at(dx + 0.3) }),
        place(++n, { categoryId: RESTAURANTS, location: at(dx + 0.8) }),
      ],
      relax: [place(++n, { categoryId: CHANY, location: at(dx + 1) })],
    }));
    const all = areas.flatMap((a) => [...a.sights, ...a.eat, ...a.relax]);
    const section: Record<string, PlaceSummaryDto[]> = {
      [NEARBY]: areas.flatMap((a) => a.sights),
      [EAT]: areas.flatMap((a) => a.eat),
      [RELAX]: areas.flatMap((a) => a.relax),
    };
    return { all, section, sightIds: areas.flatMap((a) => a.sights.map((p) => p.id)) };
  }

  it("ответ «По всьому Прикарпаттю» (previous.scope): 5 днів — дні по різних районах, переїзди між днями", async () => {
    const dxs = [0, 30, 60, 90, 120];
    const data = regionData(dxs);
    const previous = planIntent({ days: 5, withKids: true, scope: "region", transport: "car" });
    const { service, repo } = planSetup(
      // Модель не повторила область и передвижение — берутся из прежнего намерения.
      planIntent({ days: 5, withKids: true }),
      Promise.resolve(notesReply([])),
      {
        topRated: () => data.sightIds,
        searchAt: (q) => (q.ids ? data.all : q.categoryId ? data.section[q.categoryId] : []),
      },
    );
    const res = await service.query(
      REGION,
      USER,
      ask("По всьому Прикарпаттю", { origin: YAREMCHE_AT, previous }),
    );
    expect(res.questions).toEqual([]);
    expect(res.intent).toMatchObject({ scope: "region", transport: "car" });
    expect(repo.topRated).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ categoryIds: expect.arrayContaining([NEARBY]) }),
    );
    const plan = res.plan!;
    expect(plan.days).toHaveLength(5);
    // Каждый день — в одном районе (все пункты в пределах 12 км), районы дней разные.
    const areaOf = (lon: number) => Math.round(((lon - YAREMCHE_AT.lon) * 73.8) / 30);
    const dayAreas = plan.days.map((d) => {
      const areas = new Set(
        d.parts.flatMap((p) => p.stops.map((s) => areaOf(res.items[s.item]!.place.location.lon))),
      );
      expect(areas.size).toBe(1);
      return [...areas][0];
    });
    expect(new Set(dayAreas).size).toBe(5);
    // Переезд в другой район — между днями (на авто — без подсказок такси).
    expect(plan.days[0]!.transfer).toBeNull();
    for (const d of plan.days.slice(1))
      expect(d.transfer).toMatchObject({ taxi: [], excursions: [], busStations: [] });
    expect(plan.days[1]!.transfer!.meters).toBeGreaterThan(20_000);
  });

  it("без авто, обрані локації: переходи пішки ≤ 2 км; переїзд в інший пункт — таксі, екскурсії, автостанція каталогу", async () => {
    const data = regionData([0, 0]);
    // Второй район — у Буковелі.
    const buk = (dx: number) => ({ lon: BUKOVEL_AT.lon + dx / 73.8, lat: BUKOVEL_AT.lat });
    const bukovel = [
      place(40, { categoryId: NATURE, location: buk(0) }),
      place(41, { categoryId: NATURE, location: buk(0.4) }),
      place(42, { categoryId: RESTAURANTS, location: buk(0.2) }),
      place(43, { categoryId: RESTAURANTS, location: buk(0.6) }),
      place(44, { categoryId: CHANY, location: buk(0.8) }),
    ];
    const taxi = place(50, { categoryId: TAXI, location: buk(1) });
    const excursion = place(51, { categoryId: EXCURSIONS, location: buk(1.5) });
    const bus = place(52, { categoryId: TAXI, name: { uk: "Автостанція" }, location: buk(2) });
    const yaremche = data.all.slice(0, 5);
    const all = [...yaremche, ...bukovel, taxi, excursion, bus];
    const section: Record<string, PlaceSummaryDto[]> = {
      [NEARBY]: all.filter((p) => p.categoryId === NATURE),
      [EAT]: all.filter((p) => p.categoryId === RESTAURANTS),
      [RELAX]: all.filter((p) => p.categoryId === CHANY),
      [TAXI]: [taxi],
      [EXCURSIONS]: [excursion],
    };
    const previous = planIntent({
      days: 2,
      scope: "localities",
      scopeLocalityIds: [YAREMCHE, POLIANYTSIA, "0190f5c2-7d3e-7000-8000-000000000399"],
      transport: "foot",
    });
    const { service, repo } = planSetup(planIntent({ days: 2 }), Promise.resolve(notesReply([])), {
      placeLocality: Object.fromEntries([
        ...yaremche.map((p) => [p.id, YAREMCHE] as const),
        ...bukovel.map((p) => [p.id, POLIANYTSIA] as const),
      ]),
      searchAt: (q) => (q.ids ? all : q.categoryId ? section[q.categoryId] : []),
      keywordMatches: (q) => (q.minScore === 3 ? [{ id: bus.id, score: 4 }] : []),
      topRated: () => [...yaremche, ...bukovel].filter((p) => p.categoryId === NATURE).map((p) => p.id),
    });
    const res = await service.query(REGION, USER, ask("Обрані локації: Яремче, Поляниця", { previous }));
    // Чужой пункт отброшен; пам'ятки — лучшие по рейтингу в выбранных пунктах.
    expect(res.intent.scopeLocalityIds).toEqual([YAREMCHE, POLIANYTSIA]);
    expect(repo.topRated).toHaveBeenCalledWith(
      REGION,
      expect.objectContaining({ localityIds: [YAREMCHE, POLIANYTSIA] }),
    );
    const plan = res.plan!;
    expect(plan.days).toHaveLength(2);
    for (const d of plan.days)
      for (const s of d.parts.flatMap((p) => p.stops)) {
        expect(s.travel === null || s.travel === "walk").toBe(true);
        expect(s.travelMeters ?? 0).toBeLessThanOrEqual(2000);
      }
    const t = plan.days[1]!.transfer!;
    expect(t.meters).toBeGreaterThan(5000);
    expect(t.taxi.map((i) => res.items[i]!.place.id)).toEqual([taxi.id]);
    expect(t.excursions.map((i) => res.items[i]!.place.id)).toEqual([excursion.id]);
    expect(t.busStations.map((i) => res.items[i]!.place.id)).toEqual([bus.id]);
    // Автостанция — по названию или типу Google, а не упоминанию в отзывах.
    expect(repo.keywordMatches).toHaveBeenCalledWith(REGION, expect.objectContaining({ minScore: 3 }));
  });

  it("ответ чипами (answer): намерение из previous без вызова модели и без единицы бюджета", async () => {
    const data = regionData([0, 30]);
    const previous = planIntent({ days: 2, withKids: true, scope: "region", transport: "car" });
    const { service, create } = planSetup(planIntent({ days: 2 }), Promise.resolve(notesReply([])), {
      topRated: () => data.sightIds,
      searchAt: (q) => (q.ids ? data.all : q.categoryId ? data.section[q.categoryId] : []),
      // Одна единица — только на пояснения: разбор моделью не тратит.
      userDailyLimit: 1,
    });
    // Подменённые поля previous проверяются как ответ модели: чужой код категории отброшен.
    const res = await service.query(
      REGION,
      USER,
      ask("По всьому Прикарпаттю, На авто", {
        previous: { ...previous, categories: ["hacked"] },
        answer: true,
      }),
    );
    expect(res.intent).toMatchObject({
      kind: "plan",
      days: 2,
      scope: "region",
      transport: "car",
      categories: [],
    });
    expect(res.plan!.days).toHaveLength(2);
    // Вызов модели — только пояснения к плану.
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0]![0].tools![0] as Anthropic.Tool).name).toBe(NOTES);
  });

  it("ответ через модель: пункт и радиус модели не перекрывают «обрані локації» и «Пішки»", async () => {
    const previous = planIntent({
      days: 2,
      scope: "localities",
      scopeLocalityIds: [YAREMCHE],
      transport: null,
    });
    const { service } = planSetup(
      // Модель «додумала»: пункт Буковель и «пішки» ≈ 1500 м.
      planIntent({ days: 2, locality: "polianytsia", radiusMeters: 1500, transport: "foot" }),
      Promise.resolve(notesReply([])),
    );
    const res = await service.query(REGION, USER, ask("Пішки (без авто)", { origin: YAREMCHE_AT, previous }));
    expect(res.intent).toMatchObject({
      scope: "localities",
      scopeLocalityIds: [YAREMCHE],
      locality: null,
      radiusMeters: null,
      transport: "foot",
    });
    // «Пішки» без области в previous: радиус модели (1500) — не радиус туриста.
    const foot = planSetup(
      planIntent({ days: 2, radiusMeters: 1500, transport: "foot" }),
      Promise.resolve(notesReply([])),
    );
    const r2 = await foot.service.query(
      REGION,
      USER,
      ask("Пішки", { origin: YAREMCHE_AT, previous: planIntent({ days: 2, scope: "here" }) }),
    );
    expect(r2.intent.radiusMeters).toBeNull();
  });

  it("по региону, но пам'яток для районов нет — запасной план вокруг якоря, а не пусто", async () => {
    const { service, repo } = planSetup(
      planIntent({ days: 2, scope: "region", transport: "car" }),
      Promise.resolve(notesReply([])),
      { topRated: () => [] },
    );
    const res = await service.query(REGION, USER, ask("2 дні по всьому регіону", { origin: YAREMCHE_AT }));
    expect(repo.topRated).toHaveBeenCalled();
    expect(res.plan).not.toBeNull();
    expect(res.plan!.days.every((d) => !d.transfer)).toBe(true);
  });
});

describe("широкое понимание и расширение поиска", () => {
  it("GPS-режим, по категориям в радиусе 5 км пусто — ближайшие по региону (widened)", async () => {
    const far = [place(1, { distanceMeters: 9000 }), place(2, { distanceMeters: 12_000 })];
    const { service, guide } = setup({ searchAt: (s) => (s.radius === undefined ? far : []) });
    const res = await service.query(REGION, USER, ask("кафе", { origin: YAREMCHE_AT }));
    expect(guide.search).toHaveBeenCalledWith(REGION, expect.objectContaining({ radius: 5000 }));
    expect(res.notes).toContain("widened");
    expect(res.items.map((i) => i.place.id)).toEqual(far.map((p) => p.id));
    // Радиус назван туристом — не расширяем.
    const named = setup({
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ radiusMeters: 1000 })))) },
      searchAt: (s) => (s.radius === undefined ? far : []),
    });
    const r = await named.service.query(REGION, USER, ask("кафе в 1 км", { origin: YAREMCHE_AT }));
    expect(r.items).toEqual([]);
    expect(r.notes).not.toContain("widened");
  });

  it("связанные понятия: места категорий плюс найденные по словам; с точкой — от ближайшего", async () => {
    const terrace = place(3);
    const { service, repo } = setup({
      llm: {
        create: vi.fn(() =>
          Promise.resolve(
            reply(intent({ categories: ["cafes", "restaurants"], related: ["тераса", "з видом"] })),
          ),
        ),
      },
      searchAt: (s) => (s.ids ? [terrace] : [place(1), place(2)]),
      keywordMatches: () => [{ id: terrace.id, score: 3 }],
    });
    const res = await service.query(REGION, USER, ask("романтичний вечір", { origin: YAREMCHE_AT }));
    expect(repo.keywordMatches).toHaveBeenCalled();
    expect(res.items.map((i) => i.place.id)).toEqual([place(1).id, place(2).id, terrace.id]);
  });
});

describe("порядок списка — по расстоянию от туриста", () => {
  const near = place(1, { name: { uk: "Близька" }, distanceMeters: 300 });
  const mid = place(2, { name: { uk: "Середня" }, distanceMeters: 1200 });
  const far = place(3, { name: { uk: "Далека" }, distanceMeters: 4000 });
  const chargers = (text: string, origin?: { lon: number; lat: number }) => {
    const { service } = setup({
      // Каталог/поиск отдаёт в порядке релевантности: дальняя — самая релевантная и с лучшим рейтингом.
      searchAt: () => [far, mid, near],
      keywordMatches: () => [
        { id: far.id, score: 9 },
        { id: mid.id, score: 5 },
        { id: near.id, score: 2 },
      ],
      enrichment: {
        [far.id]: { google: google({ rating: 5, ratingCount: 500 }), wiki: null, ai: null },
        [mid.id]: { google: google({ rating: 3.9 }), wiki: null, ai: null },
        [near.id]: { google: google({ rating: 4.2 }), wiki: null, ai: null },
      },
      llm: {
        create: vi.fn(() => Promise.resolve(reply(intent({ categories: ["cafes"], keywords: ["зарядка"] })))),
      },
    });
    return service
      .query(REGION, USER, ask(text, origin ? { origin } : {}))
      .then((r) => r.items.map((i) => i.place.name.uk));
  };

  it("зарядки на разном удалении и с разным рейтингом — от ближайшей к дальней", async () => {
    expect(await chargers("знайди електрозарядку", YAREMCHE_AT)).toEqual(["Близька", "Середня", "Далека"]);
  });

  it("явное «найкращий» — по рейтингу", async () => {
    expect(await chargers("найкраща зарядка", YAREMCHE_AT)).toEqual(["Далека", "Близька", "Середня"]);
  });

  it("без точки — прежний порядок (релевантность и рейтинг)", async () => {
    expect(await chargers("знайди електрозарядку")).toEqual(["Далека", "Середня", "Близька"]);
  });

  it("по категории без ключевых слов — тоже от ближайшего", async () => {
    const { service } = setup({
      searchAt: () => [far, near, mid],
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ categories: ["cafes"] })))) },
    });
    const res = await service.query(REGION, USER, ask("де кава", { origin: YAREMCHE_AT }));
    expect(res.items.map((i) => i.place.name.uk)).toEqual(["Близька", "Середня", "Далека"]);
  });

  it("wantsBest", () => {
    expect(wantsBest("з найвищим рейтингом")).toBe(true);
    expect(wantsBest("топ кафе")).toBe(true);
    expect(wantsBest("лучшее кафе")).toBe(true);
    expect(wantsBest("знайди зарядку")).toBe(false);
    expect(wantsBest("стопка млинців")).toBe(false);
    for (const t of [
      "best cafe",
      "the best pizza",
      "кращі кафе",
      "найпопулярніші",
      "top rated",
      "high rated",
    ])
      expect(wantsBest(t)).toBe(true);
    for (const t of ["покращення дороги", "кафе з рейтингом від 4", "bestseller"])
      expect(wantsBest(t)).toBe(false);
    expect(wantsBest("за рейтингом")).toBe(true);
    for (const t of ["мені краще щось недороге", "що краще: кафе чи ресторан"])
      expect(wantsBest(t)).toBe(false);
  });

  it("ключевые слова с точкой — кандидаты из репозитория ближайшие (order distance); «найкращі» и экскурсия — score", async () => {
    const run = async (text: string, kind: "places" | "tour" = "places") => {
      const { service, repo } = setup({
        keywordMatches: () => [{ id: near.id, score: 1 }],
        searchAt: () => [near],
        llm: {
          create: vi.fn(() =>
            Promise.resolve(reply(intent({ kind, categories: ["cafes"], keywords: ["зарядка"] }))),
          ),
        },
      });
      await service.query(REGION, USER, ask(text, { origin: YAREMCHE_AT }));
      return repo.keywordMatches.mock.calls[0]![1].order;
    };
    expect(await run("зарядка")).toBe("distance");
    expect(await run("найкраща зарядка")).toBe("score");
    expect(await run("екскурсія", "tour")).toBe("score");
  });

  it("«найкращі кафе» → «а дешевші?»: порядок по рейтингу сохраняется (sort в намерении); «ближчі» — сброс", async () => {
    const mk = () =>
      setup({
        searchAt: () => [near, mid, far],
        enrichment: {
          [far.id]: { google: google({ rating: 5 }), wiki: null, ai: null },
          [mid.id]: { google: google({ rating: 3.9 }), wiki: null, ai: null },
          [near.id]: { google: google({ rating: 4.2 }), wiki: null, ai: null },
        },
        llm: { create: vi.fn(() => Promise.resolve(reply(intent({ categories: ["cafes"] })))) },
      });
    const first = await mk().service.query(REGION, USER, ask("найкращі кафе", { origin: YAREMCHE_AT }));
    expect(first.intent.sort).toBe("rating");
    const names = (r: { items: { place: PlaceSummaryDto }[] }) => r.items.map((i) => i.place.name.uk);
    const cheaper = await mk().service.query(
      REGION,
      USER,
      ask("а дешевші?", { origin: YAREMCHE_AT, previous: first.intent as AssistantIntent }),
    );
    expect(cheaper.intent.sort).toBe("rating");
    expect(names(cheaper)).toEqual(["Далека", "Близька", "Середня"]);
    const nearer = await mk().service.query(
      REGION,
      USER,
      ask("а ближчі?", { origin: YAREMCHE_AT, previous: first.intent as AssistantIntent }),
    );
    expect(nearer.intent.sort).toBeNull();
    expect(names(nearer)).toEqual(["Близька", "Середня", "Далека"]);
  });

  it("«топ кафе» → «де аптека» — новая тема по расстоянию; «кращі кафе поруч» — «поруч» главнее", async () => {
    const mk = (cats: string[]) =>
      setup({
        searchAt: () => [far, mid, near],
        enrichment: { [far.id]: { google: google({ rating: 5 }), wiki: null, ai: null } },
        llm: { create: vi.fn(() => Promise.resolve(reply(intent({ categories: cats })))) },
      });
    const top = await mk(["cafes"]).service.query(REGION, USER, ask("топ кафе", { origin: YAREMCHE_AT }));
    expect(top.intent.sort).toBe("rating");
    const pharmacy = await mk(["museums"]).service.query(
      REGION,
      USER,
      ask("де аптека", { origin: YAREMCHE_AT, previous: top.intent as AssistantIntent }),
    );
    expect(pharmacy.intent.sort).toBeNull();
    expect(pharmacy.items.map((i) => i.place.name.uk)).toEqual(["Близька", "Середня", "Далека"]);
    const nearBest = await mk(["cafes"]).service.query(
      REGION,
      USER,
      ask("кращі кафе поруч", { origin: YAREMCHE_AT }),
    );
    expect(nearBest.intent.sort).toBeNull();
  });

  it("«з дітьми» с точкой — строго по расстоянию (пригодность — метка)", async () => {
    const { service } = setup({
      searchAt: () => [far, near, mid],
      enrichment: { [far.id]: { google: google({ amenities: ["kids_menu"] }), wiki: null, ai: null } },
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ categories: ["cafes"], withKids: true })))) },
    });
    const res = await service.query(REGION, USER, ask("кафе з дітьми", { origin: YAREMCHE_AT }));
    expect(res.items.map((i) => [i.place.name.uk, i.kidsFriendly])).toEqual([
      ["Близька", false],
      ["Середня", false],
      ["Далека", true],
    ]);
  });

  it("nameQuery: совпавшие по названию выше совпавших по адресу, внутри — по расстоянию", async () => {
    const byAddress = place(1, {
      name: { uk: "Кафе Смерека" },
      address: { uk: "вул. Гуцулія, 1" },
      distanceMeters: 50,
    });
    const farNamed = place(2, { name: { uk: "Гуцулія" }, distanceMeters: 5000 });
    const nearNamed = place(3, { name: { uk: "Ресторан Гуцулія" }, distanceMeters: 900 });
    const { service } = setup({
      searchAt: () => [byAddress, farNamed, nearNamed],
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ categories: [], nameQuery: "Гуцулія" })))) },
    });
    const res = await service.query(REGION, USER, ask("де Гуцулія?", { origin: YAREMCHE_AT }));
    expect(res.items.map((i) => i.place.id)).toEqual([farNamed.id, nearNamed.id, byAddress.id]);
  });

  it("экскурсия: остановки по релевантности — водопад не вытесняется местом с одним упоминанием в отзыве", async () => {
    const waterfall = place(9, { name: { uk: "Водоспад Пробій" }, distanceMeters: 9000 });
    const mentions = Array.from({ length: 12 }, (_, i) => place(20 + i, { distanceMeters: 100 + i }));
    const { service } = setup({
      searchAt: () => [...mentions, waterfall],
      keywordMatches: () => [
        { id: waterfall.id, score: 9 },
        ...mentions.map((m) => ({ id: m.id, score: 1 })),
      ],
      llm: {
        create: vi.fn(() =>
          Promise.resolve(reply(intent({ kind: "tour", categories: ["cafes"], keywords: ["водоспад"] }))),
        ),
      },
    });
    const res = await service.query(REGION, USER, ask("екскурсія до водоспаду", { origin: YAREMCHE_AT }));
    expect(res.items.map((i) => i.place.id)).toContain(waterfall.id);
  });
});

describe("describe / shorten", () => {
  it("ИИ-текст → Вікіпедія → Google; длинный текст — по предложению", () => {
    expect(describePlace(undefined)).toEqual({ text: null, source: null, url: null });
    expect(describePlace({ google: google({ summary: "Опис Google" }), wiki: null, ai: null })).toEqual({
      text: "Опис Google",
      source: "google",
      url: null,
    });
    const long = `${"Перше речення про водоспад. ".repeat(10)}Кінець`;
    const s = shorten(long, 100);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith(".")).toBe(true);
    expect(shorten("слово ".repeat(40), 50).endsWith("…")).toBe(true);
  });
});

describe("названное место вне населённых пунктов (водоспад Гук, вершины)", () => {
  const huk = place(40, {
    name: { uk: "Водоспад Женецький Гук" },
    categoryId: NATURE,
    distanceMeters: 38_000,
  });
  const taxi = place(41, {
    name: { uk: "Таксі Татарів Заросляк Говерла Водоспад Гук Трансфер" },
    categoryId: TAXI,
    distanceMeters: 2000,
  });
  const mountHuk = place(42, { name: { uk: "Гора Гук" }, categoryId: NATURE, distanceMeters: 500 });
  const hoverla = place(43, { name: { uk: "Говерла" }, categoryId: NATURE, distanceMeters: 45_000 });
  const khomiak = place(44, { name: { uk: "Хомʼяк" }, categoryId: NATURE, distanceMeters: 41_000 });
  const brebeneskul = place(45, {
    name: { uk: "гора Бребенескул" },
    categoryId: NATURE,
    distanceMeters: 60_000,
  });
  const nearby = place(46, { name: { uk: "Водоспад Пробій" }, categoryId: NATURE, distanceMeters: 300 });
  // Магазин «Водоспад» (категория не природа) и кафе с точным названием — для поиска с типом места и без.
  const shop = place(47, { name: { uk: "Водоспад" }, categoryId: CAFES, distanceMeters: 100 });
  const smereka = place(48, { name: { uk: "Смерека" }, categoryId: CAFES, distanceMeters: 7000 });
  const bare = (t: string) => t.toLocaleLowerCase("uk").replace(/['ʼ’]/g, "");
  const all = [huk, taxi, mountHuk, hoverla, khomiak, brebeneskul, nearby, shop, smereka];
  // Как каталог: ILIKE по названию, радиус, пункт (у вершин и водопадов locality_id null — «Локація» их отсекает).
  const run = (text: string, over: Partial<AssistantIntent>, kind: "places" | "tour" = "places") => {
    const { service } = setup({
      searchAt: (s) =>
        all.filter(
          (p) =>
            (!s.text || bare(p.name.uk!).includes(bare(s.text))) &&
            (s.radius === undefined || (p.distanceMeters ?? 0) <= s.radius) &&
            (!s.categoryId || s.categoryId === NATURE || p.categoryId === s.categoryId),
        ),
      placeLocality: { [nearby.id]: YAREMCHE },
      llm: {
        create: vi.fn(() => Promise.resolve(reply(intent({ kind, categories: ["nature"], ...over })))),
      },
    });
    return service
      .query(REGION, USER, ask(text, { origin: YAREMCHE_AT, localityIds: [YAREMCHE] }))
      .then((r) => r.items.map((i) => i.place.name.uk));
  };

  it("«екскурсія на водоспад Гук» — экскурсия к нему, хотя он вне выбранного пункта и далеко", async () => {
    const names = await run("зроби мені екскурсію на водоспад Гук", { nameQuery: "водоспад Гук" }, "tour");
    expect(names).toContain("Водоспад Женецький Гук");
    expect(names).not.toContain("Гора Гук");
  });

  it("«водоспад Гук», «Женецький Гук», «як дістатися до Женецького Гуку» — водоспад первым (выше таксі)", async () => {
    for (const nameQuery of ["водоспад Гук", "Женецький Гук", "Женецького Гуку"])
      expect((await run(`де ${nameQuery}`, { nameQuery }))[0]).toBe("Водоспад Женецький Гук");
  });

  it("вершины без пункта: Говерла, Хом'як (другой апостроф), Бребенескул (падеж)", async () => {
    expect((await run("гора Говерла", { nameQuery: "гора Говерла" }))[0]).toBe("Говерла");
    expect((await run("екскурсія на Хом'як", { nameQuery: "Хом'як" }))[0]).toBe("Хомʼяк");
    expect((await run("на Бребенескула", { nameQuery: "Бребенескула" }))[0]).toBe("гора Бребенескул");
  });

  it("nameStems: падеж и родовые слова", () => {
    expect(nameStems("Женецького Гуку")).toEqual(["женецьк", "гук"]);
    expect(nameStems("водоспад Гук")).toEqual(["гук"]);
    expect(nameStems("гора Говерла")).toEqual(["говерл"]);
    expect(nameStems("озеро Синевир")).toEqual(["синевир"]);
    expect(nameStems("водопад Гук")).toEqual(["гук"]);
    expect(nameStems("Хом'як")).toEqual(["хомяк"]);
  });

  it("короткая основа — только с начала слова; апостроф не важен", () => {
    const named = (uk: string) => place(1, { name: { uk } });
    expect(nameHasStems(named("Водоспад Гук"), ["гук"])).toBe(true);
    expect(nameHasStems(named("Гуків"), ["гук"])).toBe(true);
    expect(nameHasStems(named("Чугуківка"), ["гук"])).toBe(false);
    expect(nameHasStems(named("Готель Буковель"), ["гук"])).toBe(false);
    expect(nameHasStems(named("Хомʼяк"), nameStems("Хомяк"))).toBe(true);
  });

  it("«Хомяк» без апострофа находит «Хомʼяк»", async () => {
    expect((await run("на Хомяк", { nameQuery: "Хомяк" }))[0]).toBe("Хомʼяк");
  });

  it("«водоспад» — тип места: водоспады, а не магазин «Водоспад» и не таксі «…Водоспад Гук»", async () => {
    const names = await run("водоспад", { nameQuery: "водоспад", categories: [] });
    expect(names).toContain("Водоспад Пробій");
    expect(names).toContain("Водоспад Женецький Гук");
    expect(names).not.toContain("Водоспад");
    expect(names).not.toContain("Таксі Татарів Заросляк Говерла Водоспад Гук Трансфер");
  });

  it("«екскурсія на водоспад Гук» с nameQuery «Гук» — тип из текста запроса: без таксі", async () => {
    const names = await run("екскурсія на водоспад Гук", { nameQuery: "Гук", categories: [] }, "tour");
    expect(names).toContain("Водоспад Женецький Гук");
    expect(names).not.toContain("Таксі Татарів Заросляк Говерла Водоспад Гук Трансфер");
  });

  it("тип не назван — точное название заведения находится в любой категории", async () => {
    expect(await run("де Смерека", { nameQuery: "Смерека", categories: [] })).toContain("Смерека");
  });

  it("тип в запросе и раздел намерения: кафе, если турист сам выбрал «Де поїсти»", async () => {
    const names = await run("кафе Водоспад", { nameQuery: "Водоспад", categories: ["cafes"] });
    expect(names).toContain("Водоспад");
  });

  it("placeTypeCategories: водоспад, вершина, озеро — категории; без типа — null", () => {
    expect([...placeTypeCategories("водоспад Гук")!].sort()).toEqual(["nature", "sights"]);
    expect(placeTypeCategories("на вершину Хом'як")!.has("peaks")).toBe(true);
    expect(placeTypeCategories("озеро Синевир")!.has("nature")).toBe(true);
    expect(placeTypeCategories("Суші Барберрі")).toBeNull();
    expect(placeTypeCategories("Гуцулія")).toBeNull();
  });

  it("«Вдсп», «вдсп.» в названии — водоспад (родовое слово совпадает)", () => {
    const named = (uk: string) => place(1, { name: { uk } });
    expect(nameHasStems(named("Вдсп. Женецький Гук"), ["водоспад", "гук"])).toBe(true);
    expect(nameHasStems(named("вдсп Капливець"), ["водоспад"])).toBe(true);
    expect(nameHasStems(named("Твдсп"), ["водоспад"])).toBe(false);
  });

  it("«найкращі» — названное место всё равно первым", async () => {
    expect((await run("найкращий водоспад Гук", { nameQuery: "водоспад Гук" }))[0]).toBe(
      "Водоспад Женецький Гук",
    );
  });
});

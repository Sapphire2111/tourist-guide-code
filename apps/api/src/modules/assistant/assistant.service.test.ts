// Unit (Claude, Speech-to-Text, каталог и БД подменены): ассистент подбирает только места каталога по намерению
// модели — категории, радиус, цены и «з дітьми» из обогащения, маршрут экскурсии; без ключа и сверх суточного
// предела — 503; сбои Claude — 502/504; ответ модели без инструмента — «уточніть».
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "../../common/http/index.js";
import type { GuideService, PlaceSummaryDto, ScheduleRows } from "../guide/index.js";
import type { AssistantRepository, KeywordQuery, PlaceEnrichmentFacts } from "./assistant.repository.js";
import type { RegionsRepository } from "../regions/index.js";
import { AssistantService, describe as describePlace, shorten } from "./assistant.service.js";
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
    expect(res.items[0]).toMatchObject({
      descriptionSource: "wikipedia",
      descriptionUrl: "https://uk.wikipedia.org/wiki/M",
    });
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

  it("«суші»: поиск по названию, типу, описаниям и отзывам во всём разделе «Де поїсти»; порядок — совпадение и рейтинг", async () => {
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
    expect(res.items.map((i) => i.place.name.uk)).toEqual(["Суши Кафе", "KUMA", "Family"]);
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

  function planSetup(i: AssistantIntent, notes: Promise<Anthropic.Message>) {
    const create = vi
      .fn<(p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>>()
      .mockResolvedValueOnce(reply(i))
      .mockReturnValueOnce(notes);
    const s = setup({ llm: { create }, searchAt: (q) => (q.categoryId ? bySection[q.categoryId] : []) });
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

    const weekend = planSetup(planIntent({ start: "weekend", days: 2 }), Promise.resolve(notesReply([])));
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

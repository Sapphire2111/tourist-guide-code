// Unit (Claude, Speech-to-Text, каталог и БД подменены): ассистент подбирает только места каталога по намерению
// модели — категории, радиус, цены и «з дітьми» из обогащения, маршрут экскурсии; без ключа и сверх суточного
// предела — 503; сбои Claude — 502/504; ответ модели без инструмента — «уточніть».
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "../../common/http/index.js";
import type { GuideService, PlaceSummaryDto } from "../guide/index.js";
import type { AssistantRepository, PlaceEnrichmentFacts } from "./assistant.repository.js";
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
  locality: null,
  radiusMeters: null,
  priceMin: null,
  priceMax: null,
  withKids: false,
  openNow: false,
  clarify: false,
  suggestions: ["cheaper"],
  ...over,
});

const reply = (input: unknown, stop: Anthropic.Message["stop_reason"] = "tool_use") =>
  ({
    content: [{ type: "tool_use", id: "t", name: INTENT_TOOL, input }],
    stop_reason: stop,
  }) as unknown as Anthropic.Message;

type SearchArg = { origin?: { lon: number; lat: number }; localityIds?: readonly string[] };

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
        ],
      }),
    ),
    search: vi.fn((_r: string, s: SearchArg) =>
      Promise.resolve({
        // Как каталог: localityIds — только места этих пунктов (place_id → locality_id из opts.placeLocality).
        items: (opts.searchAt?.(s) ?? opts.places ?? [place(1), place(2)]).filter(
          (p) => !s.localityIds?.length || s.localityIds.includes(opts.placeLocality?.[p.id] ?? ""),
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
    findById: vi.fn(() => Promise.resolve({ id: REGION, status: opts.regionStatus ?? "active" })),
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

  it("Буковель из Яремче при >50 местах категории рядом с туристом — места Буковеля не теряются", async () => {
    const near = Array.from({ length: 60 }, (_, i) => place(i + 1, { name: { uk: `Яремче ${i}` } }));
    const bukovel = place(99, {
      name: { uk: "Прокат у Буковелі" },
      location: BUKOVEL_AT,
      distanceMeters: 50,
    });
    const placeLocality: Record<string, string> = Object.fromEntries(near.map((p) => [p.id, YAREMCHE]));
    placeLocality[bukovel.id] = POLIANYTSIA;
    const { service } = setup({
      // Выдача от точки туриста — 60 мест Яремче (Буковеля в первых 50 нет); от центра Поляниці — Буковель.
      searchAt: (s) => (s.localityIds?.includes(POLIANYTSIA) ? [bukovel] : near.slice(0, 50)),
      llm: { create: vi.fn(() => Promise.resolve(reply(intent({ locality: "polianytsia" })))) },
      placeLocality,
    });
    const res = await service.query(REGION, USER, ask("прокат у Буковелі", { origin: YAREMCHE_AT }));
    expect(res.items.map((i) => i.place.name.uk)).toEqual(["Прокат у Буковелі"]);
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

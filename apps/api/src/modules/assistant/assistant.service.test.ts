// Unit (Claude, Speech-to-Text, каталог и БД подменены): ассистент подбирает только места каталога по намерению
// модели — категории, радиус, цены и «з дітьми» из обогащения, маршрут экскурсии; без ключа и сверх суточного
// предела — 503; сбои Claude — 502/504; ответ модели без инструмента — «уточніть».
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "../../common/http/index.js";
import type { GuideService, PlaceSummaryDto } from "../guide/index.js";
import type { AssistantRepository, PlaceEnrichmentFacts } from "./assistant.repository.js";
import { AssistantService, describe as describePlace, shorten } from "./assistant.service.js";
import { INTENT_TOOL, type AssistantIntent } from "./intent.js";
import { AssistantUpstreamError, type AssistantLlm, type AssistantSpeech } from "./providers.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
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

function setup(
  opts: {
    llm?: Partial<AssistantLlm>;
    speech?: Partial<AssistantSpeech>;
    places?: PlaceSummaryDto[];
    enrichment?: Record<string, PlaceEnrichmentFacts>;
    dailyLimit?: number;
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
    search: vi.fn(() =>
      Promise.resolve({ items: opts.places ?? [place(1), place(2)], nextOffset: null, radiusMeters: null }),
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
  };
  const service = new AssistantService(
    repo as unknown as AssistantRepository,
    guide as unknown as GuideService,
    llm as AssistantLlm,
    speech as AssistantSpeech,
    { dailyLimit: opts.dailyLimit },
  );
  return { service, guide, llm, speech, repo };
}

const ask = (text = "кав'ярня поруч", over: Partial<Parameters<AssistantService["query"]>[1]> = {}) => ({
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
    const res = await service.query(REGION, ask("кава", { origin: { lon: 24.5, lat: 48.4 } }));
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
    const res = await service.query(REGION, ask());
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
    const res = await service.query(REGION, ask());
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
    const res = await service.query(REGION, ask());
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
    const res = await service.query(REGION, ask("екскурсія", { origin: { lon: 24.5, lat: 48.4 } }));
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
        ask("як справи?", { previous: intent({ categories: ["museums"] }) }),
      );
      expect(res.intent.clarify).toBe(true);
      expect(res.items).toEqual([]);
      expect(guide.search).not.toHaveBeenCalled();
    }
  });

  it("без ключа Claude — 503 errors.assistant.unavailable, каталог и модель не трогаются", async () => {
    const { service, guide, llm } = setup({ llm: { enabled: false } });
    const err = await service.query(REGION, ask()).catch((e: unknown) => e);
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
      expect(status(await service.query(REGION, ask()).catch((e: unknown) => e))).toBe(code);
    }
  });

  it("суточный предел: сверх — 503, на следующие сутки снова можно", async () => {
    const { service, llm } = setup({ dailyLimit: 2 });
    service.now = () => new Date("2026-11-03T10:00:00Z");
    await service.query(REGION, ask());
    await service.transcribe(Buffer.from("x"), "audio/webm");
    expect(status(await service.query(REGION, ask()).catch((e: unknown) => e))).toBe(503);
    expect(llm.create).toHaveBeenCalledTimes(1);
    service.now = () => new Date("2026-11-04T00:00:01Z");
    await service.query(REGION, ask());
    expect(llm.create).toHaveBeenCalledTimes(2);
  });
});

describe("проживання", () => {
  it("«готель поруч»: категории проживания — в модель из каталога, поиск — по коду модели (hotels)", async () => {
    const hotel = place(1, { categoryId: HOTELS, name: { uk: "Готель «Карпати»" } });
    const create = vi.fn((_p: Anthropic.MessageCreateParamsNonStreaming) =>
      Promise.resolve(reply(intent({ categories: ["hotels"], radiusMeters: 1000 }))),
    );
    const { service, guide } = setup({ places: [hotel], llm: { create } });
    const res = await service.query(REGION, ask("готель поруч", { origin: { lon: 24.5, lat: 48.4 } }));
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

describe("AssistantService.transcribe", () => {
  it("текст распознавания; без ключа — 503; отклонённое аудио — 422", async () => {
    const ok = setup();
    expect(await ok.service.transcribe(Buffer.from("x"), "audio/ogg")).toBe("кава поруч");
    expect(ok.speech.recognize).toHaveBeenCalledWith(Buffer.from("x"), "audio/ogg");
    const off = setup({ speech: { enabled: false } });
    expect(
      status(await off.service.transcribe(Buffer.from("x"), "audio/webm").catch((e: unknown) => e)),
    ).toBe(503);
    const bad = setup({
      speech: { recognize: vi.fn(() => Promise.reject(new AssistantUpstreamError("rejected", 400))) },
    });
    expect(
      status(await bad.service.transcribe(Buffer.from("x"), "audio/webm").catch((e: unknown) => e)),
    ).toBe(422);
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

// Unit (без сети и БД): обогащение мест places:enrich — разбор Place Details («не выдумывает»: нет поля — пусто),
// кэш ответов Google (повторный прогон без запросов), режим оценки, Вікіпедія только при уверенном совпадении,
// ИИ-текст пакетом (мок Message Batches): мало фактов — без текста, ответ «НЕМАЄ ДАНИХ» и мусор — не принимаются.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GooglePlacesClient } from "../places-import/google-client.js";
import type { MappedPlace } from "../places-import/mapping.js";
import {
  acceptText,
  AI_NO_DATA,
  AiStore,
  buildFacts,
  factsHash,
  requestParams,
  runAi,
  type BatchesApi,
} from "./ai.js";
import { parseEnrichArgs } from "./args.js";
import { amenitiesOf, normalizeDetails } from "./details.js";
import { enrich } from "./enrich.js";
import { bestHit, findWikipedia, nameScore, transliterate, WikipediaClient } from "./wikipedia.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "tg-enrich-"));

const PLACE_ID = "ChIJ-YqOVmolN0cRIY6uqQPGF4k";
const DETAILS = {
  id: PLACE_ID,
  primaryTypeDisplayName: { text: "Піцерія", languageCode: "uk" },
  editorialSummary: { text: "Піцерія з дров'яною піччю." },
  priceLevel: "PRICE_LEVEL_MODERATE",
  rating: 4.8,
  userRatingCount: 1532,
  googleMapsUri: "https://maps.google.com/?cid=1",
  servesBreakfast: true,
  servesBeer: true,
  servesVegetarianFood: false,
  outdoorSeating: true,
  goodForChildren: true,
  parkingOptions: { freeParkingLot: true },
  accessibilityOptions: { wheelchairAccessibleEntrance: true },
  paymentOptions: { acceptsCreditCards: true, acceptsCashOnly: false },
  photos: [
    {
      name: `places/${PLACE_ID}/photos/AbC_1`,
      widthPx: 4032,
      heightPx: 3024,
      authorAttributions: [
        {
          displayName: "Олена",
          uri: "https://maps.google.com/maps/contrib/1",
          photoUri: "//lh3.googleusercontent.com/a/x",
        },
      ],
    },
    { name: "javascript:alert(1)" },
  ],
  reviews: [
    {
      rating: 5,
      text: { text: "Дуже смачна піца,\n\nшвидко принесли!", languageCode: "uk" },
      relativePublishTimeDescription: "2 місяці тому",
      publishTime: "2026-09-01T10:00:00Z",
      googleMapsUri: "https://www.google.com/maps/reviews/1",
      authorAttribution: {
        displayName: "Іван",
        uri: "javascript:alert(1)",
        photoUri: "https://evil.example/a.png",
      },
    },
    { rating: 4, text: { text: "Без автора" } },
  ],
};

describe("normalizeDetails", () => {
  it("берёт только данные Google: тип, описание, цена, рейтинг, удобства «да», фото и отзывы с авторами", () => {
    const g = normalizeDetails(DETAILS);
    expect(g).toMatchObject({
      typeLabel: "Піцерія",
      summary: "Піцерія з дров'яною піччю.",
      priceLevel: 2,
      rating: 4.8,
      ratingCount: 1532,
      mapsUri: "https://maps.google.com/?cid=1",
    });
    expect(g.amenities).toEqual([
      "breakfast",
      "beer",
      "outdoor_seating",
      "good_for_children",
      "parking_free",
      "wheelchair_entrance",
      "cards",
    ]);
    // Недопустимое имя фото отброшено; аватар без схемы — https; отзыв без автора — не показывается.
    expect(g.photos).toEqual([
      {
        name: `places/${PLACE_ID}/photos/AbC_1`,
        width: 4032,
        height: 3024,
        authors: [
          {
            name: "Олена",
            uri: "https://maps.google.com/maps/contrib/1",
            photoUri: "https://lh3.googleusercontent.com/a/x",
          },
        ],
      },
    ]);
    expect(g.reviews).toHaveLength(1);
    expect(g.reviews[0]).toMatchObject({
      text: "Дуже смачна піца,\nшвидко принесли!",
      rating: 5,
      relativeTime: "2 місяці тому",
      // javascript: и чужой хост аватара — не в карточку.
      author: { name: "Іван", uri: null, photoUri: null },
    });
  });

  it("пустой ответ — пустое обогащение: ничего не выдумывается", () => {
    expect(normalizeDetails({ id: PLACE_ID })).toEqual({
      typeLabel: null,
      summary: null,
      priceLevel: null,
      rating: null,
      ratingCount: null,
      mapsUri: null,
      amenities: [],
      reviews: [],
      photos: [],
    });
    // Рейтинг без числа оценок — не показывается.
    expect(normalizeDetails({ id: PLACE_ID, rating: 4.5 }).rating).toBeNull();
    expect(amenitiesOf({ servesBeer: false, outdoorSeating: "yes" })).toEqual([]);
  });
});

const place = (over: Partial<MappedPlace> = {}): MappedPlace => ({
  googlePlaceId: PLACE_ID,
  categoryCode: "restaurants",
  localityCode: "yaremche",
  name: "Woodstone",
  description: "Ресторан у Яремчі. Джерело: Google Maps.",
  address: "вулиця Свободи, 59/3, Яремче",
  at: { lon: 24.589416, lat: 48.4795574 },
  phone: null,
  website: null,
  week: null,
  photos: [],
  rating: 4.8,
  ratingCount: 1532,
  ...over,
});

const jsonRes = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("enrich — Place Details с кэшем", () => {
  it("первый прогон — один запрос Details с FieldMask, второй — из кэша без запросов", async () => {
    const cacheDir = await tmp();
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(DETAILS)));
    const client = () =>
      new GooglePlacesClient({ apiKey: "k", cacheDir, maxRequests: 10, fetch: fetchMock as typeof fetch });
    const c1 = client();
    const r1 = await enrich([place()], c1, undefined);
    expect(c1.requests.details).toBe(1);
    expect(r1.places[0]!.google?.typeLabel).toBe("Піцерія");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://places.googleapis.com/v1/places/${PLACE_ID}?languageCode=uk&regionCode=UA`);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Goog-FieldMask"]).toContain("reviews");
    expect(headers["X-Goog-FieldMask"]).toContain("servesBreakfast");
    const c2 = client();
    await enrich([place()], c2, undefined);
    expect(c2.requests.details).toBe(0);
    expect(c2.cacheHits).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("--plan: без сети, промахи кэша считаются; лимит запросов останавливает сбор", async () => {
    const cacheDir = await tmp();
    const fetchMock = vi.fn(() => Promise.resolve(jsonRes(DETAILS)));
    const plan = new GooglePlacesClient({
      apiKey: "k",
      cacheDir,
      maxRequests: 10,
      planOnly: true,
      fetch: fetchMock as typeof fetch,
    });
    const r = await enrich([place(), place({ googlePlaceId: "other" })], plan, undefined);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(plan.planned.details).toBe(2);
    expect(r.places.every((p) => p.google === null)).toBe(true);

    const limited = new GooglePlacesClient({
      apiKey: "k",
      cacheDir,
      maxRequests: 1,
      fetch: fetchMock as typeof fetch,
    });
    const r2 = await enrich([place(), place({ googlePlaceId: "other" })], limited, undefined);
    expect(r2.stats.googleLimitReached).toBe(true);
    expect(r2.stats.details).toBe(1);
  });

  it("фильтры: --limit, --skip-categories", async () => {
    const cacheDir = await tmp();
    const c = new GooglePlacesClient({ apiKey: undefined, cacheDir, maxRequests: 0, planOnly: true });
    const r = await enrich(
      [place(), place({ googlePlaceId: "a", categoryCode: "atm" }), place({ googlePlaceId: "b" })],
      c,
      undefined,
      { skipCategories: new Set(["atm"]), limit: 1 },
    );
    expect(r.places.map((p) => p.googlePlaceId)).toEqual([PLACE_ID]);
  });
});

describe("Вікіпедія — только уверенное совпадение", () => {
  it("nameScore: отличительные слова с падежами; общее слово одно — не совпадение", () => {
    expect(nameScore("Водоспад Пробій", "Пробій (водоспад)")).toBe(1);
    expect(nameScore("Музей Олекси Довбуша", "Музей Олекси Довбуша (Яремче)")).toBeGreaterThanOrEqual(0.66);
    expect(nameScore("Водоспад", "Водоспад Женецький Гук")).toBe(0);
    expect(nameScore("Скелі Довбуша", "Церква Різдва Пресвятої Богородиці")).toBe(0);
    expect(nameScore(transliterate("Водоспад Пробій"), "Probiy Waterfall")).toBe(1);
  });

  it("bestHit: дальше радиуса — нет", () => {
    const at = { lon: 24.55, lat: 48.45 };
    expect(
      bestHit("Водоспад Пробій", at, [{ title: "Пробій (водоспад)", lat: 48.6, lon: 24.55, dist: 0 }]),
    ).toBeNull();
    expect(
      bestHit("Водоспад Пробій", at, [{ title: "Пробій (водоспад)", lat: 48.451, lon: 24.55, dist: 0 }]),
    ).not.toBeNull();
  });

  const wikiFetch = (license: string) =>
    vi.fn((url: string) => {
      if (url.includes("list=geosearch") && url.startsWith("https://uk."))
        return Promise.resolve(
          jsonRes({
            query: {
              geosearch: [
                { title: "Яремче", lat: 48.45, lon: 24.55, dist: 300 },
                { title: "Пробій (водоспад)", lat: 48.4462, lon: 24.5532, dist: 120 },
              ],
            },
          }),
        );
      if (url.includes("/page/summary/"))
        return Promise.resolve(
          jsonRes({
            type: "standard",
            title: "Пробій (водоспад)",
            extract: "Пробій — водоспад в Українських Карпатах, на річці Прут. Розташований у місті Яремче.",
            content_urls: { mobile: { page: "https://uk.m.wikipedia.org/wiki/Пробій" } },
            originalimage: { source: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Probiy.jpg" },
          }),
        );
      if (url.startsWith("https://commons.wikimedia.org/"))
        return Promise.resolve(
          jsonRes({
            query: {
              pages: [
                {
                  imageinfo: [
                    {
                      thumburl:
                        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Probiy.jpg/1200px-Probiy.jpg",
                      thumbwidth: 1200,
                      thumbheight: 800,
                      descriptionurl: "https://commons.wikimedia.org/wiki/File:Probiy.jpg",
                      extmetadata: {
                        LicenseShortName: { value: license },
                        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:X">Taras</a>' },
                        LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
                      },
                    },
                  ],
                },
              ],
            },
          }),
        );
      return Promise.resolve(jsonRes({ query: { geosearch: [] } }));
    });

  it("находит статью uk с фото Commons, автором и лицензией", async () => {
    const f = wikiFetch("CC BY-SA 4.0");
    const client = new WikipediaClient({ cacheDir: await tmp(), maxRequests: 10, fetch: f as typeof fetch });
    const w = await findWikipedia(client, {
      name: "Водоспад Пробій",
      location: { lon: 24.553, lat: 48.446 },
    });
    expect(w).toMatchObject({
      lang: "uk",
      title: "Пробій (водоспад)",
      url: "https://uk.m.wikipedia.org/wiki/%D0%9F%D1%80%D0%BE%D0%B1%D1%96%D0%B9",
      image: {
        author: "Taras",
        license: "CC BY-SA 4.0",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Probiy.jpg",
      },
    });
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
      "User-Agent": expect.stringContaining("TouristGuide"),
    });
  });

  it("несвободная лицензия — без фото; нет совпадения — null", async () => {
    const client = new WikipediaClient({
      cacheDir: await tmp(),
      maxRequests: 10,
      fetch: wikiFetch("Fair use") as typeof fetch,
    });
    const w = await findWikipedia(client, {
      name: "Водоспад Пробій",
      location: { lon: 24.553, lat: 48.446 },
    });
    expect(w?.image).toBeNull();
    expect(
      await findWikipedia(client, { name: "Кав'ярня Ранок", location: { lon: 24.553, lat: 48.446 } }),
    ).toBeNull();
  });
});

describe("ИИ-текст", () => {
  const google = normalizeDetails(DETAILS);
  const input = {
    name: "Woodstone",
    category: "Ресторани",
    locality: "Яремче",
    address: null,
    google,
    wiki: null,
  };

  it("мало фактов — текста нет (модель не вызывается)", () => {
    expect(buildFacts({ ...input, google: normalizeDetails({ id: PLACE_ID }) })).toBeNull();
    expect(buildFacts({ ...input, google: null })).toBeNull();
  });

  it("факты — только собранные; промпт запрещает добавлять; модель claude-sonnet-5-5 на низком усилии", () => {
    const facts = buildFacts(input)!;
    expect(facts).toMatchObject({ назва: "Woodstone", "тип за Google": "Піцерія", ціни: "середні ціни" });
    expect(facts).not.toHaveProperty("Вікіпедія");
    const params = requestParams(facts);
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.output_config).toEqual({ effort: "low" });
    expect(String(params.system)).toContain("ЛИШЕ факти");
    expect(factsHash(facts)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("acceptText: «НЕМАЄ ДАНИХ», ссылки, разметка, слишком длинное — не принимаются", () => {
    expect(acceptText(AI_NO_DATA)).toBeNull();
    expect(acceptText("Дивіться https://x.ua — тут смачно і затишно, приходьте всі.")).toBeNull();
    expect(acceptText("**Піцерія** у Яремчі з терасою та дитячим меню, підходить для дітей.")).toBeNull();
    expect(acceptText("а".repeat(600))).toBeNull();
    expect(acceptText("«Піцерія у Яремчі з терасою. Відвідувачі хвалять піцу.»")).toBe(
      "Піцерія у Яремчі з терасою. Відвідувачі хвалять піцу.",
    );
  });

  function fakeBatches(text: string) {
    const created: { custom_id: string }[][] = [];
    let status: "in_progress" | "ended" = "in_progress";
    const api = {
      create: vi.fn((body: { requests: { custom_id: string }[] }) => {
        created.push(body.requests);
        return Promise.resolve({ id: "msgbatch_1" });
      }),
      retrieve: vi.fn(() =>
        Promise.resolve({ processing_status: status, request_counts: { processing: 1 } }),
      ),
      results: vi.fn(() =>
        Promise.resolve(
          (async function* () {
            for (const r of created.flat())
              yield {
                custom_id: r.custom_id,
                result: {
                  type: "succeeded",
                  message: {
                    model: "claude-sonnet-5-5",
                    stop_reason: "end_turn",
                    content: [{ type: "text", text }],
                    usage: { input_tokens: 500, output_tokens: 80 },
                  },
                },
              };
          })(),
        ),
      ),
    };
    return { api: api as unknown as BatchesApi, raw: api, end: () => (status = "ended") };
  }

  it("пакет: отправка, незавершённый — дособирается следующим прогоном; результат в кэше, повтор не платит", async () => {
    const store = new AiStore(await tmp());
    const facts = buildFacts(input)!;
    const items = [{ hash: factsHash(facts), facts }];
    const b = fakeBatches("Піцерія у Яремчі з терасою й дитячим меню. Відвідувачі хвалять піцу.");
    const s1 = await runAi(b.api, store, items, { maxNew: 3, wait: false });
    expect(s1).toMatchObject({ submitted: 1, stillProcessing: true, batchId: "msgbatch_1" });
    expect(await store.get(items[0]!.hash)).toBeNull();

    b.end();
    const s2 = await runAi(b.api, store, items, { maxNew: 3, wait: false });
    expect(s2).toMatchObject({ submitted: 0, accepted: 1, needed: 0 });
    expect(b.raw.create).toHaveBeenCalledTimes(1);
    expect((await store.get(items[0]!.hash))?.text).toContain("Піцерія у Яремчі");
    expect(await store.pending()).toBeNull();

    await runAi(b.api, store, items, { maxNew: 3, wait: false });
    expect(b.raw.create).toHaveBeenCalledTimes(1);
  });

  it("ответ «НЕМАЄ ДАНИХ» — сохраняется как null (в карточку не попадёт); maxNew ограничивает пакет", async () => {
    const store = new AiStore(await tmp());
    const facts = buildFacts(input)!;
    const items = [
      { hash: factsHash(facts), facts },
      { hash: factsHash({ ...facts, назва: "Інше" }), facts: { ...facts, назва: "Інше" } },
    ];
    const b = fakeBatches(AI_NO_DATA);
    b.end();
    const s = await runAi(b.api, store, items, { maxNew: 1, wait: true, pollMs: 1 });
    expect(s).toMatchObject({ needed: 2, submitted: 1, rejected: 1, accepted: 0 });
    expect((await store.get(items[0]!.hash))?.text).toBeNull();
  });
});

describe("parseEnrichArgs", () => {
  it("флаги и ограничения", () => {
    expect(parseEnrichArgs(["--plan"])).toMatchObject({ plan: true, ai: false, maxRequests: 100 });
    expect(
      parseEnrichArgs([
        "--dry-run",
        "--limit",
        "3",
        "--ai",
        "--max-ai=3",
        "--wait",
        "--skip-categories",
        "atm,fuel",
      ]),
    ).toMatchObject({
      dryRun: true,
      limit: 3,
      ai: true,
      maxAi: 3,
      wait: true,
      skipCategories: new Set(["atm", "fuel"]),
    });
    expect(() => parseEnrichArgs(["--ai"])).toThrow(/--max-ai/);
    expect(() => parseEnrichArgs(["--plan", "--dry-run"])).toThrow();
    expect(() => parseEnrichArgs(["--bogus"])).toThrow(/неизвестный/);
  });
});

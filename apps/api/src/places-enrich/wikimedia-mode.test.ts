// Unit (без сети и БД): режим --covers-source wikimedia — точность сопоставления, сохранность готовых текстов,
// устойчивость к сбоям Вікіпедії; обычный режим остаётся как был.
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../test/support/recording-db.js";
import { GooglePlacesClient } from "../places-import/google-client.js";
import type { MappedPlace } from "../places-import/mapping.js";
import {
  acceptText,
  aiEligible,
  AI_MODEL,
  AI_PROMPT_VERSION,
  AiStore,
  cachedTextAllowed,
  copiesSource,
  factsHash,
  requestParams,
  runAi,
  SYSTEM_PROMPT,
  WIKI_RULE,
  type BatchesApi,
} from "./ai.js";
import { parseEnrichArgs } from "./args.js";
import { runCovers, type Resize } from "./covers.js";
import { loadDbPlaces } from "./db-places.js";
import { enrich, type EnrichedPlace } from "./enrich.js";
import {
  allowedClasses,
  findWikipediaStrict,
  strictCandidates,
  strictNameScore,
  STRICT_MIN_SCORE,
  wikiRadius,
} from "./wiki-match.js";
import { WIKI_CATEGORIES, WikipediaClient, WikiLimitError, WikiUnavailableError } from "./wikipedia.js";
import { writeEnrichment, type EnrichWriteItem } from "./writer.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "tg-wm-"));
const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const AT = { lon: 24.55, lat: 48.45 };
const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
const noSleep = () => Promise.resolve();
const noGoogle = async () =>
  new GooglePlacesClient({ apiKey: undefined, cacheDir: await tmp(), maxRequests: 0 });

const place = (id: string, over: Partial<MappedPlace> = {}): MappedPlace => ({
  googlePlaceId: id,
  categoryCode: "nature",
  extraCategoryCodes: [],
  localityCode: "yaremche",
  name: `Місце ${id}`,
  description: "",
  address: "",
  at: AT,
  phone: null,
  website: null,
  week: null,
  photos: [],
  rating: null,
  ratingCount: null,
  ...over,
});

const claim = (value: unknown, rank = "normal") => ({ rank, mainsnak: { datavalue: { value } } });
const P31 = (...ids: string[]) => ids.map((id) => claim({ id }));

/** Фейк API Wikimedia: статьи по заголовку — { qid, p31, p18 }; вне списка запросов быть не должно. */
function wiki(
  articles: Record<
    string,
    { qid?: string; p31?: string[]; p18?: string | null; lat?: number; lon?: number; extract?: string }
  >,
  opts: { artist?: string | null; license?: string; search?: boolean } = {},
) {
  const byQid = new Map(Object.entries(articles).map(([, a]) => [a.qid, a]));
  const hits = Object.entries(articles).map(([title, a]) => ({
    title,
    lat: a.lat ?? AT.lat,
    lon: a.lon ?? AT.lon,
    dist: 10,
  }));
  return vi.fn((url: string) => {
    if (url.includes("list=geosearch"))
      return Promise.resolve(json({ query: { geosearch: opts.search ? [] : hits } }));
    if (url.includes("generator=search"))
      return Promise.resolve(
        json({
          query: { pages: hits.map((h) => ({ title: h.title, coordinates: [{ lat: h.lat, lon: h.lon }] })) },
        }),
      );
    if (url.includes("/page/summary/")) {
      const title = decodeURIComponent(url.split("/page/summary/")[1]!).replace(/_/g, " ");
      const a = articles[title];
      return Promise.resolve(
        json({
          type: "standard",
          title,
          extract: a?.extract ?? "Стаття про об'єкт.",
          content_urls: { mobile: { page: `https://uk.m.wikipedia.org/wiki/${title}` } },
          ...(a?.qid ? { wikibase_item: a.qid } : {}),
          originalimage: { source: "https://upload.wikimedia.org/wikipedia/commons/a/ab/ArticleImage.jpg" },
        }),
      );
    }
    if (url.startsWith("https://www.wikidata.org/")) {
      const a = byQid.get(/entity=(Q\d+)/.exec(url)![1]);
      return Promise.resolve(
        json({
          claims: url.endsWith("property=P31")
            ? { P31: P31(...(a?.p31 ?? [])) }
            : a?.p18
              ? { P18: [claim("Old.jpg", "deprecated"), claim(a.p18)] }
              : {},
        }),
      );
    }
    if (url.startsWith("https://commons.wikimedia.org/"))
      return Promise.resolve(
        json({
          query: {
            pages: [
              {
                imageinfo: [
                  {
                    thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/F.jpg/1200px-F.jpg",
                    descriptionurl: "https://commons.wikimedia.org/wiki/File:F.jpg",
                    extmetadata: {
                      LicenseShortName: { value: opts.license ?? "CC BY-SA 4.0" },
                      ...(opts.artist === null ? {} : { Artist: { value: opts.artist ?? "Taras" } }),
                    },
                  },
                ],
              },
            ],
          },
        }),
      );
    throw new Error(`Неожиданный запрос: ${url}`);
  });
}
const clientOf = async (f: unknown, over: Partial<ConstructorParameters<typeof WikipediaClient>[0]> = {}) =>
  new WikipediaClient({ cacheDir: await tmp(), maxRequests: 100, fetch: f as typeof fetch, ...over });
const find = (client: WikipediaClient, name: string, categoryCode = "nature") =>
  findWikipediaStrict(client, { name, location: AT, categoryCode });

const WATERFALL = "Q34038";
const MOUNTAIN = "Q8502";
const CITY = "Q515";
const HUMAN = "Q5";

describe("блокер 1: чужая статья и фото", () => {
  it.each([
    ["Говерла", "Говерла (готель)"],
    ["Гора Хом'як", "Хом'як (заказник)"],
    ["Сокільський хребет", "Сокільський (заказник)"],
    ["Яремче", "Яремче (станція)"],
    ["Петрос", "Петрос (фільм)"],
    ["Петрос", "Петрос (2005)"],
    ["Говерла", "Говерла (ФК)"],
    ["Гора Чорногора", "Чорноголова"],
    ["Яремче", "Яремчанський район"],
    ["Верховина", "Верхова"],
    ["Гора Близниця", "Скелі Близниці"],
    ["Водоспад Пробій", "Пробій (гора)"],
    ["гора Петрос", "Петрос (печера)"],
    ["Водоспад", "Водоспад Женецький Гук"],
    ["Велика Чорна Гора", "Чорна Гора"],
  ])("название: %s ≠ %s", (name, title) => {
    expect(strictNameScore(name, title)).toBeLessThan(STRICT_MIN_SCORE);
  });

  it.each([
    ["Гора Петрос", "Петрос (Чорногора)"],
    ["Хом'як", "Хом'як (гора)"],
    ["Сокільський", "Сокільський хребет"],
    ["Водоспад Пробій", "Пробій (водоспад)"],
    ["Скелі Довбуша", "Скелі Довбуша"],
    ["Скеля Довбуша", "Довбуш"], // по названию сходится — отсекает P31
    ["Говерла", "Говерла (Івано-Франківська область)"],
    ["Водоспад Пробій", "Пробою"],
  ])("название: %s = %s", (name, title) => {
    expect(strictNameScore(name, title)).toBeGreaterThanOrEqual(STRICT_MIN_SCORE);
  });

  it.each([
    ["Музей Яремче", "museums", "Яремче", CITY],
    ["Водоспад Яремче", "nature", "Яремче", CITY],
    ["Церква Ворохта", "sights", "Ворохта", "Q532"],
    ["Озеро Верховина", "nature", "Верховина", CITY],
    ["Водоспад Дзвінка", "nature", "Дзвінка", "Q4022"],
    ["Скеля Довбуша", "sights", "Довбуш", HUMAN],
  ])("тип P31: %s (%s) со статьёй «%s» — нет совпадения", async (name, cat, title, cls) => {
    const f = wiki({ [title]: { qid: "Q1", p31: [cls], p18: "F.jpg" } });
    const client = await clientOf(f);
    expect(await find(client, name, cat)).toBeNull();
    expect(client.typeRejects).toEqual([{ place: name, title, classes: [cls] }]);
    // Фото чужого объекта даже не запрашивается.
    expect(f.mock.calls.some((c) => c[0].startsWith("https://commons."))).toBe(false);
  });

  it("класс сверяется с типом места: водоспад со статьёй о горе — нет; гора — да", async () => {
    const f = () => wiki({ Дзвінка: { qid: "Q1", p31: [MOUNTAIN], p18: "F.jpg" } });
    expect(await find(await clientOf(f()), "Водоспад Дзвінка")).toBeNull();
    expect((await find(await clientOf(f()), "Гора Дзвінка"))?.title).toBe("Дзвінка");
    // В названии типа нет — по категории.
    expect((await find(await clientOf(f()), "Дзвінка", "nature"))?.title).toBe("Дзвінка");
    expect(await find(await clientOf(f()), "Дзвінка", "museums")).toBeNull();
  });

  it("неизвестный класс, нет P31, нет объекта Wikidata, неизвестная категория — нет совпадения", async () => {
    expect(
      await find(await clientOf(wiki({ Говерла: { qid: "Q1", p31: ["Q999999"] } })), "Говерла"),
    ).toBeNull();
    expect(await find(await clientOf(wiki({ Говерла: { qid: "Q1", p31: [] } })), "Говерла")).toBeNull();
    expect(await find(await clientOf(wiki({ Говерла: {} })), "Говерла")).toBeNull();
    const f = wiki({ Говерла: { qid: "Q1", p31: [MOUNTAIN] } });
    expect(await find(await clientOf(f), "Говерла", "restaurants")).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(allowedClasses("restaurants", "Говерла").size).toBe(0);
  });

  it("уверенное совпадение: статья uk, фото — только P18 (не картинка статьи), с автором и лицензией", async () => {
    const f = wiki({ "Пробій (водоспад)": { qid: "Q1", p31: [WATERFALL], p18: "Probiy.jpg" } });
    const w = await find(await clientOf(f), "Водоспад Пробій");
    expect(w).toMatchObject({
      lang: "uk",
      title: "Пробій (водоспад)",
      image: { author: "Taras", license: "CC BY-SA 4.0" },
    });
    const commons = f.mock.calls.map((c) => c[0]).find((u) => u.startsWith("https://commons."));
    expect(commons).toContain(encodeURIComponent("File:Probiy.jpg"));
  });

  it("нет P18 — статья без фото, картинка статьи не подставляется", async () => {
    const f = wiki({ Говерла: { qid: "Q1", p31: [MOUNTAIN], p18: null } });
    const w = await find(await clientOf(f), "Говерла");
    expect(w?.title).toBe("Говерла");
    expect(w?.image).toBeNull();
    expect(f.mock.calls.some((c) => c[0].startsWith("https://commons."))).toBe(false);
  });

  it("первая статья не подошла по типу — проверяется следующая", async () => {
    const f = wiki({
      Говерла: { qid: "Q1", p31: [CITY] },
      "Говерла (Чорногора)": { qid: "Q2", p31: [MOUNTAIN] },
    });
    expect((await find(await clientOf(f), "Говерла"))?.title).toBe("Говерла (Чорногора)");
  });

  it("радиус: природа — 3 км, остальное — 1,5 км; дальше — нет", () => {
    const hits = [{ title: "Пробій (водоспад)", lat: 48.4725, lon: 24.55, dist: 0 }];
    expect(strictCandidates("Водоспад Пробій", AT, hits, wikiRadius("museums"))).toEqual([]);
    expect(strictCandidates("Водоспад Пробій", AT, hits, wikiRadius("nature"))).toHaveLength(1);
    const far = [{ title: "Пробій (водоспад)", lat: 48.6, lon: 24.55, dist: 0 }];
    expect(strictCandidates("Водоспад Пробій", AT, far, wikiRadius("nature"))).toEqual([]);
  });

  it("geosearch не нашёл — поиск по названию, те же проверки", async () => {
    const f = wiki({ Говерла: { qid: "Q1", p31: [MOUNTAIN] } }, { search: true });
    expect((await find(await clientOf(f), "Говерла"))?.title).toBe("Говерла");
    expect(f.mock.calls[0]![0]).toContain("gsradius=3000&gslimit=100");
  });
});

describe("серьёзное 5: только uk", () => {
  it("нет статьи в uk — английская не запрашивается", async () => {
    const f = vi.fn(() => Promise.resolve(json({ query: { geosearch: [], pages: [] } })));
    expect(await find(await clientOf(f), "Водоспад Пробій")).toBeNull();
    const urls = (f.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("https://uk.wikipedia.org/"))).toBe(true);
  });
});

describe("серьёзное 8: автор и лицензия", () => {
  it.each([[null], [""], ["Unknown author"], ["Невідомий автор"]])(
    "автор %j — файл не принимается",
    async (artist) => {
      const f = wiki({ Говерла: { qid: "Q1", p31: [MOUNTAIN], p18: "F.jpg" } }, { artist });
      const w = await find(await clientOf(f), "Говерла");
      expect(w?.title).toBe("Говерла");
      expect(w?.image).toBeNull();
    },
  );

  it("обложка: файл без автора в данных места не ставится, Google не трогается", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(Buffer.from("img"), { status: 200 })));
    const google = await noGoogle();
    const inserts: unknown[] = [];
    const resize: Resize = () => Promise.resolve({ data: Buffer.from("w"), width: 1, height: 1 });
    const stats = await runCovers(
      [
        {
          ...place("x"),
          address: null,
          google: { photos: [{ name: "places/a/photos/p", width: 1, height: 1, authors: [] }] } as never,
          wiki: {
            lang: "uk",
            title: "T",
            url: "https://u",
            extract: "e",
            image: {
              url: "https://upload.wikimedia.org/x.jpg",
              width: 1,
              height: 1,
              author: null,
              license: "CC BY-SA 4.0",
              licenseUrl: null,
              sourceUrl: "https://commons.wikimedia.org/wiki/File:X",
            },
          },
        },
      ],
      {
        google,
        db: recordingDb({}, (q) => {
          if (q.sql.startsWith('insert into "place_cover_photos"')) inserts.push(q.parameters);
          return [];
        }).db,
        regionId: REGION,
        existing: new Set(),
        write: true,
        fetch: fetchImpl as unknown as typeof fetch,
        resize,
        wikimediaOnly: true,
      },
    );
    expect(stats).toMatchObject({ written: 0, needed: 0, noWikiImage: 1 });
    expect(inserts).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const writeOne = async (item: Partial<EnrichWriteItem>, wikimediaOnly = true) => {
  const sql: string[] = [];
  const { db } = recordingDb({}, (q) => {
    sql.push(q.sql);
    if (q.sql.startsWith('select "id", "google_place_id" from "places"'))
      return [{ id: "pid", google_place_id: "a" }];
    if (q.sql.startsWith('update "place_enrichments"')) return { rows: [], numAffectedRows: 1n };
    return [];
  });
  const stats = await writeEnrichment(
    db,
    REGION,
    [
      {
        googlePlaceId: "a",
        name: "Т",
        categoryCode: "nature",
        localityCode: "",
        address: null,
        google: null,
        wiki: undefined,
        ...item,
      },
    ],
    new Date(),
    { wikimediaOnly },
  );
  return { sql, stats };
};
const article = { lang: "uk", title: "T", url: "https://u", extract: "факт", image: null };
const clearsAi = (sql: string[]) =>
  sql.some(
    (s) =>
      /update "place_enrichments" set "ai_summary_uk" = \$1/.test(s) &&
      !s.includes('"ai_summary_uk" is null'),
  );
const insertsAi = (sql: string[]) => sql.some((s) => s.startsWith("insert") && s.includes("ai_summary_uk"));
const HASH = "a".repeat(32);

describe("блокер 3: готовые тексты ИИ не теряются", () => {
  it("нет google, нового текста нет (без --ai, вне --max-ai, без ожидания) — сохранённый не снимается", async () => {
    const { sql, stats } = await writeOne({ wiki: article, ai: { hash: HASH, result: null } });
    expect(clearsAi(sql)).toBe(false);
    expect(stats.aiCleared).toBe(0);
  });

  it("text:null (отклонён проверкой) — сохранённый не затирается", async () => {
    const { sql, stats } = await writeOne({
      wiki: article,
      ai: { hash: HASH, result: { text: null, model: "m", generatedAt: "2026-11-01T00:00:00Z" } },
    });
    expect(insertsAi(sql)).toBe(false);
    expect(clearsAi(sql)).toBe(false);
    expect(stats.aiWritten).toBe(0);
  });

  it("новый текст — только туда, где пусто", async () => {
    const { sql, stats } = await writeOne({
      wiki: article,
      ai: { hash: HASH, result: { text: "Пересказ.", model: "m", generatedAt: "2026-11-01T00:00:00Z" } },
    });
    expect(insertsAi(sql)).toBe(false);
    expect(sql.some((s) => s.includes('"ai_summary_uk" is null') && s.startsWith("update"))).toBe(true);
    expect(stats.aiWritten).toBe(1);
  });

  it("обычный режим по-прежнему снимает устаревший текст", async () => {
    const { sql } = await writeOne({ wiki: article, ai: { hash: HASH, result: null } }, false);
    expect(
      sql.some(
        (s) => s.startsWith('update "place_enrichments"') && s.includes('"ai_summary_uk" is not null'),
      ),
    ).toBe(true);
  });

  it("готовый текст — без пакета у всех мест, и с сохранённым Google, и без; без статьи — нет", () => {
    const withAi = new Set(["a"]);
    expect(aiEligible({ googlePlaceId: "a", wiki: article }, withAi, true)).toBe(false);
    expect(aiEligible({ googlePlaceId: "b", wiki: article }, withAi, true)).toBe(true);
    expect(aiEligible({ googlePlaceId: "b", wiki: null }, withAi, true)).toBe(false);
    // Обычный режим: как раньше — только для данных из кэша импорта.
    expect(aiEligible({ googlePlaceId: "a", wiki: article }, withAi, false)).toBe(true);
    expect(aiEligible({ googlePlaceId: "a", googleFromImport: true }, withAi, false)).toBe(false);
  });

  it("loadDbPlaces: hasAi — по сохранённому тексту, в том числе при google=NULL", async () => {
    const { db } = recordingDb({}, (q) =>
      q.sql.startsWith('select "places"."google_place_id"')
        ? [
            {
              google_place_id: "a",
              name_i18n: { uk: "Говерла" },
              address_i18n: null,
              category_code: "nature",
              locality_code: null,
              google: null,
              ai_summary_uk: "Готовий текст.",
              has_cover: false,
              at: AT,
            },
          ]
        : [],
    );
    expect((await loadDbPlaces(db, REGION))[0]).toMatchObject({ hasAi: true, savedGoogle: null });
  });
});

describe("серьёзное 9, мелкое: запись", () => {
  it("wiki=null не затирает сохранённую статью — и в обычном режиме", async () => {
    for (const mode of [true, false]) {
      const { sql } = await writeOne({ wiki: null }, mode);
      expect(sql.filter((s) => s.startsWith('insert into "place_enrichments"'))).toEqual([]);
    }
  });

  it("найденная статья записывается", async () => {
    const { sql, stats } = await writeOne({ wiki: article });
    expect(sql.some((s) => s.startsWith('insert into "place_enrichments"') && s.includes('"wiki"'))).toBe(
      true,
    );
    expect(stats.written).toBe(1);
  });

  it("google и google_fetched_at режим не трогает: запроса к Google не было", async () => {
    const google = { photos: [], reviews: [], amenities: [] } as never;
    const { sql } = await writeOne({ wiki: article, google });
    expect(sql.join("\n")).not.toContain("google_fetched_at");
    expect(sql.some((s) => s.startsWith("insert") && s.includes('"google"'))).toBe(false);
    // Обычный режим — как раньше.
    expect((await writeOne({ wiki: article, google }, false)).sql.join("\n")).toContain("google_fetched_at");
  });
});

describe("серьёзное 4: обычный режим как до режима Wikimedia", () => {
  const facts = { назва: "x", Вікіпедія: "y" };

  it("хэш и промпт обычного режима не изменились; правило пересказа — только в режиме", () => {
    expect(factsHash(facts)).toBe(
      createHash("sha256")
        .update(`${AI_MODEL}|${AI_PROMPT_VERSION}|${SYSTEM_PROMPT}|${JSON.stringify(facts)}`)
        .digest("hex")
        .slice(0, 32),
    );
    expect(requestParams(facts).system).toBe(SYSTEM_PROMPT);
    expect(requestParams(facts, true).system).toContain(WIKI_RULE);
    expect(factsHash(facts, true)).not.toBe(factsHash(facts));
  });

  it("категория markets — только в режиме", async () => {
    expect(WIKI_CATEGORIES.has("markets")).toBe(false);
    const f = vi.fn(() => Promise.resolve(json({ query: { geosearch: [] } })));
    const market = place("m", { categoryCode: "markets", name: "Ринок Косів" });
    await enrich([market], await noGoogle(), await clientOf(f), { details: false });
    expect(f).not.toHaveBeenCalled();
    await enrich([market], await noGoogle(), await clientOf(f), { details: false, wikimediaOnly: true });
    expect(f).toHaveBeenCalled();
  });

  it("без повторов и стопа: сбой на месте — следующее место снова запрашивается", async () => {
    const f = vi.fn(() => Promise.resolve(new Response("busy", { status: 429 })));
    const client = await clientOf(f);
    const r = await enrich([place("a"), place("b")], await noGoogle(), client, { details: false });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.stats.wikiUnavailable).toBe(2);
    expect(client.retries).toBe(0);
  });
});

describe("серьёзное 6: устойчивый сбой Вікіпедії", () => {
  const stopping = { retryDelaysMs: [5000, 20000, 60000], stopOnUnavailable: true };

  it("429 на 10 местах: 4 запроса HTTP, 85 с, счётчик 4, остальные места — «недоступна»", async () => {
    let slept = 0;
    const f = vi.fn(() => Promise.resolve(new Response("busy", { status: 429 })));
    const client = await clientOf(f, {
      ...stopping,
      sleep: (ms) => {
        slept += ms;
        return Promise.resolve();
      },
    });
    const log = vi.fn();
    const r = await enrich(
      Array.from({ length: 10 }, (_, i) => place(`p${i}`, { name: `Гора Х${i}` })),
      await noGoogle(),
      client,
      { details: false, wikimediaOnly: true, log },
    );
    expect(f).toHaveBeenCalledTimes(4);
    expect(slept).toBe(85_000);
    expect(client.requests).toBe(4);
    expect(client.retries).toBe(3);
    expect(r.stats).toMatchObject({ wikiSearched: 0, wikiUnavailable: 10 });
    expect(r.places.every((p) => p.wiki === undefined)).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("повторы входят в --max-wiki-requests", async () => {
    const f = vi.fn(() => Promise.resolve(new Response("busy", { status: 429 })));
    const client = await clientOf(f, { ...stopping, maxRequests: 2, sleep: noSleep });
    await expect(client.geosearch("uk", AT)).rejects.toBeInstanceOf(WikiLimitError);
    expect(f).toHaveBeenCalledTimes(2);
    expect(client.requests).toBe(2);
  });

  it("повтор помог — сети не останавливается, Retry-After учтён; после стопа кэш работает", async () => {
    const sleeps: number[] = [];
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "7" } }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(json({ query: { geosearch: [] } }))
      .mockResolvedValue(new Response("busy", { status: 503 }));
    const client = await clientOf(f, {
      retryDelaysMs: [1000, 2000],
      stopOnUnavailable: true,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(await client.geosearch("uk", AT)).toEqual([]);
    expect(sleeps).toEqual([7000, 2000]);
    expect(client.stopped).toBeNull();
    expect(client.requests).toBe(3);
    await expect(client.geosearch("uk", { lon: 25, lat: 49 })).rejects.toBeInstanceOf(WikiUnavailableError);
    expect(client.stopped).toContain("503");
    const calls = f.mock.calls.length;
    expect(await client.geosearch("uk", AT)).toEqual([]);
    await expect(client.geosearch("uk", { lon: 26, lat: 49 })).rejects.toBeInstanceOf(WikiUnavailableError);
    expect(f).toHaveBeenCalledTimes(calls);
  });

  it("сеть недоступна — тоже стоп", async () => {
    const f = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const client = await clientOf(f, { retryDelaysMs: [1], stopOnUnavailable: true, sleep: noSleep });
    await expect(client.geosearch("uk", AT)).rejects.toBeInstanceOf(WikiUnavailableError);
    expect(client.stopped).not.toBeNull();
  });

  it("обложки: 5xx после повторов — стоп до конца прогона, а не паузы на каждом месте", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("", { status: 503 })));
    const image = {
      url: "https://upload.wikimedia.org/h.jpg",
      width: 1,
      height: 1,
      author: "MSha",
      license: "CC BY-SA 4.0",
      licenseUrl: null,
      sourceUrl: "https://commons.wikimedia.org/wiki/File:H.jpg",
    };
    const places: EnrichedPlace[] = ["a", "b", "c"].map((id) => ({
      ...place(id),
      address: null,
      google: null,
      wiki: { ...article, image },
    }));
    const stats = await runCovers(places, {
      google: await noGoogle(),
      db: recordingDb().db,
      regionId: REGION,
      existing: new Set(),
      write: true,
      fetch: fetchImpl as unknown as typeof fetch,
      wikimediaOnly: true,
      retryDelaysMs: [1],
      sleep: noSleep,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stats.wikiUnavailable).toBe(3);
  });

  it("место, которое не искали из-за сбоя, — не «нет фото»", async () => {
    const stats = await runCovers([{ ...place("a"), address: null, google: null, wiki: undefined }], {
      google: await noGoogle(),
      existing: new Set(),
      write: false,
      wikimediaOnly: true,
    });
    expect(stats.noWikiImage).toBe(0);
  });
});

describe("серьёзное 7: дословная копия статьи", () => {
  const EX =
    "Пробій — водоспад в Українських Карпатах, на річці Прут. Розташований у місті Яремче, Івано-Франківська область. Висота падіння води становить близько восьми метрів, поруч є сувенірний ринок.";

  it("копия, копия с другим регистром и знаками, переставленные предложения — не принимаются", () => {
    expect(acceptText(EX, EX)).toBeNull();
    expect(acceptText(EX.toUpperCase().replace(/[,.—]/g, " "), EX)).toBeNull();
    const [a, b, c] = EX.split(". ");
    expect(acceptText(`${c}. ${a}. ${b}.`, EX)).toBeNull();
  });

  it("одно предложение дословно посреди своего текста (8 слов подряд) — не принимается", () => {
    const text =
      "Туристи приїжджають сюди заради гучного потоку серед скель і фотографій. Висота падіння води становить близько восьми метрів, поруч є сувенірний ринок. Дорога зручна для всієї родини влітку.";
    expect(copiesSource(text, EX)).toBe(true);
  });

  it("пересказ с общими фактами и названиями — принимается", () => {
    const text =
      "Пробій — бурхливий потік на Пруті просто в Яремчі, вода тут падає приблизно на вісім метрів. Біля нього торгують сувенірами, тож зупинка зручна для короткої прогулянки.";
    expect(acceptText(text, EX)).toBe(text);
  });

  it("одна общая фраза из пяти слов — не копия", () => {
    const text =
      "Варто приїхати сюди заради гучного потоку й скель. Це водоспад в Українських Карпатах, до якого легко дістатися без спеціального спорядження, а поруч продають сувеніри.";
    expect(copiesSource(text, EX)).toBe(false);
  });

  it("нет статьи или она очень короткая — проверка копии не мешает", () => {
    expect(copiesSource(EX, null)).toBe(false);
    expect(copiesSource(EX, "Пробій — водоспад.")).toBe(false);
  });

  it("пакет: копия статьи отклоняется и не попадает в кэш как текст", async () => {
    const facts = { назва: "Пробій", Вікіпедія: EX };
    const hash = factsHash(facts, true);
    const api = {
      create: vi.fn(() => Promise.resolve({ id: "b1" })),
      retrieve: vi.fn(() =>
        Promise.resolve({ processing_status: "ended", request_counts: { processing: 0 } }),
      ),
      results: vi.fn(async function* () {
        yield {
          custom_id: hash,
          result: {
            type: "succeeded",
            message: {
              stop_reason: "end_turn",
              model: AI_MODEL,
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [{ type: "text", text: EX }],
            },
          },
        };
      }),
    } as unknown as BatchesApi;
    const store = new AiStore(await tmp());
    const stats = await runAi(api, store, [{ hash, facts, paraphrase: true }], { maxNew: 1, wait: true });
    expect(stats).toMatchObject({ accepted: 0, rejected: 1 });
    expect((await store.get(hash))?.text).toBeNull();
    const body = vi.mocked(api.create).mock.calls[0]![0];
    expect(body.requests[0]!.params.system).toContain(WIKI_RULE);
  });

  it("кэш результатов: копия из прошлых прогонов не пишется", () => {
    const r = { text: EX, model: "m", generatedAt: "2026-11-01T00:00:00Z" };
    expect(cachedTextAllowed(r, EX)?.text).toBeNull();
    const ok = { ...r, text: "Свій текст про водоспад без дослівних зворотів зі статті." };
    expect(cachedTextAllowed(ok, EX)).toBe(ok);
    expect(cachedTextAllowed(null, EX)).toBeNull();
  });
});

describe("мелкое: аргументы, --limit, не-JSON", () => {
  it("--covers-source wikimedia — только с --covers и без --no-wiki", () => {
    expect(() => parseEnrichArgs(["--covers-source", "wikimedia"])).toThrow(/--covers/);
    expect(() => parseEnrichArgs(["--covers", "--covers-source", "wikimedia", "--no-wiki"])).toThrow(
      /--no-wiki/,
    );
    expect(parseEnrichArgs(["--covers", "--covers-source", "wikimedia"]).coversSource).toBe("wikimedia");
    expect(() => parseEnrichArgs(["--covers", "--covers-source", "wikimedia", "--plan"])).toThrow(/--plan/);
    // Обычный режим не затронут.
    expect(parseEnrichArgs(["--no-wiki"]).wiki).toBe(false);
  });

  it("--limit: подходящие категории, рестораны не занимают выборку и не попадают в запись", async () => {
    const google = await noGoogle();
    const r = await enrich(
      [
        place("r1", { categoryCode: "restaurants", ratingCount: 900 }),
        place("r2", { categoryCode: "hotels", ratingCount: 800 }),
        place("n", { categoryCode: "nature", name: "Водоспад Пробій" }),
        place("m", { categoryCode: "markets", name: "Ринок" }),
      ],
      google,
      undefined,
      { details: false, prioritize: true, wikimediaOnly: true, limit: 1 },
    );
    expect(r.places.map((p) => p.googlePlaceId)).toEqual(["n"]);
    expect(r.stats.skippedByCategory).toBe(2);
  });

  it("не-JSON ответ — место «недоступна», прогон не падает и не кэширует мусор", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>", { status: 200 }))
      .mockResolvedValue(json({ query: { geosearch: [] } }));
    const client = await clientOf(f);
    const r = await enrich([place("a", { name: "Гора Х" })], await noGoogle(), client, { details: false });
    expect(r.stats.wikiUnavailable).toBe(1);
    expect(client.stopped).toBeNull();
    await expect(client.geosearch("uk", AT, 1500, 30)).resolves.toEqual([]);
  });
});

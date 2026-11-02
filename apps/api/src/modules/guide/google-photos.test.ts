// Unit (без сети и БД): прокси фото Google — адрес файла запрашивается у Google один раз (дальше память и БД),
// ключ уходит только заголовком, ответ не с хоста Google не отдаётся, суточный предел, без ключа — без запросов.
// Картка місця с обогащением и без («нет данных — пусто»).
import { describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { usageDb } from "../../../test/support/usage-db.js";
import type { EmergencyContactsRepository } from "../emergency-contacts/index.js";
import type { MediaService } from "../media/index.js";
import type { RegionsRepository } from "../regions/index.js";
import type { GuideRepository } from "./guide.repository.js";
import { coverEtag, GuideService, isAutoDescription } from "./guide.service.js";
import { GooglePhotosService } from "./google-photos.js";

const NAME = "places/ChIJ-YqOVmolN0cRIY6uqQPGF4k/photos/AbC_1";
const URI = "https://lh3.googleusercontent.com/places/abc=w400";

const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

function photos(
  opts: {
    apiKey?: string;
    dailyLimit?: number;
    monthlyLimit?: number;
    dbRow?: { photo_uri: string; fetched_at: Date };
    usage?: Map<string, number>;
    usageFails?: boolean;
  } = {},
) {
  const usage = opts.usage ?? new Map<string, number>();
  const { db, queries } = usageDb(usage, {
    fails: opts.usageFails,
    extra: (q) => (q.sql.startsWith("select") && opts.dbRow ? [opts.dbRow] : []),
  });
  const fetchMock = vi.fn(() => Promise.resolve(ok({ photoUri: URI, name: NAME })));
  const svc = new GooglePhotosService(db, {
    apiKey: "apiKey" in opts ? opts.apiKey : "secret-key",
    dailyLimit: opts.dailyLimit,
    monthlyLimit: opts.monthlyLimit,
    apiBaseUrl: "https://api.example/",
    fetch: fetchMock as typeof fetch,
  });
  return { svc, fetchMock, queries };
}

describe("GooglePhotosService", () => {
  it("первый запрос — к Google с ключом в заголовке, адрес в БД; повтор — из памяти без запросов", async () => {
    const { svc, fetchMock, queries } = photos();
    expect(await svc.uri(NAME, 400)).toBe(URI);
    expect(await svc.uri(NAME, 400)).toBe(URI);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://places.googleapis.com/v1/${NAME}/media?maxWidthPx=400&skipHttpRedirect=true`);
    expect(url).not.toContain("secret-key");
    expect(init.headers).toEqual({ "X-Goog-Api-Key": "secret-key" });
    expect(queries.some((q) => q.sql.startsWith('insert into "google_photo_uris"'))).toBe(true);
  });

  it("свежий адрес в БД — без запроса к Google (перезапуск api не стоит денег)", async () => {
    const { svc, fetchMock } = photos({ dbRow: { photo_uri: URI, fetched_at: new Date() } });
    expect(await svc.uri(NAME, 1200)).toBe(URI);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("одновременные запросы одного фото — один запрос к Google", async () => {
    const { svc, fetchMock } = photos();
    await Promise.all([svc.uri(NAME, 400), svc.uri(NAME, 400), svc.uri(NAME, 400)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("недопустимые имя/ширина, адрес не Google, нет ключа, суточный предел — null", async () => {
    const a = photos();
    expect(await a.svc.uri("places/x/photos/../../etc", 400)).toBeNull();
    expect(await a.svc.uri(NAME, 999 as 400)).toBeNull();
    a.fetchMock.mockResolvedValueOnce(ok({ photoUri: "https://evil.example/x.jpg" }));
    expect(await a.svc.uri(NAME, 1200)).toBeNull();

    const noKey = photos({ apiKey: undefined });
    expect(noKey.svc.enabled).toBe(false);
    expect(await noKey.svc.uri(NAME, 400)).toBeNull();
    expect(noKey.fetchMock).not.toHaveBeenCalled();

    const down = photos({ usageFails: true });
    expect(await down.svc.uri(NAME, 400)).toBeNull();
    expect(down.fetchMock).not.toHaveBeenCalled();
  });

  it("суточный предел — счётчик в БД: переживает рестарт api (новый экземпляр сервиса)", async () => {
    const usage = new Map<string, number>();
    const first = photos({ dailyLimit: 1, usage });
    expect(await first.svc.uri(NAME, 400)).toBe(URI);
    expect(await first.svc.uri(NAME, 1200)).toBeNull();
    const restarted = photos({ dailyLimit: 1, usage });
    expect(await restarted.svc.uri(NAME, 1200)).toBeNull();
    expect(first.fetchMock).toHaveBeenCalledTimes(1);
    expect(restarted.fetchMock).not.toHaveBeenCalled();
    expect([...usage.entries()].sort()).toEqual([
      [`${new Date().toISOString().slice(0, 7)}-01|place_photos_month`, 1],
      [`${new Date().toISOString().slice(0, 10)}|place_photos`, 1],
    ]);
    expect(await restarted.svc.exhausted()).toBe(true);
  });

  it("месячный предел (общий с CLI): исчерпан — без запросов, и сутки не тратятся", async () => {
    const usage = new Map<string, number>([
      [`${new Date().toISOString().slice(0, 7)}-01|place_photos_month`, 5],
    ]);
    const p = photos({ monthlyLimit: 5, usage });
    expect(await p.svc.uri(NAME, 400)).toBeNull();
    expect(p.fetchMock).not.toHaveBeenCalled();
    expect(await p.svc.exhausted()).toBe(true);
    const fresh = photos({ monthlyLimit: 5 });
    expect(await fresh.svc.exhausted()).toBe(false);
  });

  it("ошибка Google по фото запоминается на 6 ч: повтор в окне — без запроса, после — снова", async () => {
    const { svc, fetchMock } = photos();
    let t = Date.parse("2026-11-03T10:00:00Z");
    svc.now = () => new Date(t);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await svc.uri(NAME, 400)).toBeNull();
    expect(await svc.uri(NAME, 400)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    t += 6 * 3600_000 + 1;
    expect(await svc.uri(NAME, 400)).toBe(URI);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ссылка карточки — на прокси api, без ключа", () => {
    const { svc } = photos();
    expect(svc.proxyUrl("r1", "p1", 2, 1200, NAME)).toMatch(
      /^https:\/\/api\.example\/places\/p1\/google-photos\/2\?regionId=r1&w=1200&v=[0-9a-f]{8}$/,
    );
  });
});

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";

function guide(enrichment: unknown, photosSvc?: GooglePhotosService) {
  const { db } = recordingDb({});
  const repo: Partial<GuideRepository> = {
    findPublished: () =>
      Promise.resolve({
        id: PLACE,
        region_id: REGION,
        category_id: PLACE,
        name_i18n: { uk: "Woodstone" },
        address_i18n: null,
        description_i18n: { uk: "Ресторан у Яремчі. Джерело: Google Maps." },
        phone: null,
        website: null,
        telegram: null,
        verified_at: null,
        source: "google",
        recommended: false,
        location: { lon: 24.58, lat: 48.47 },
        distance: null,
      }),
    findCategory: () => Promise.resolve(undefined),
    placeTags: () => Promise.resolve([]),
    photos: () => Promise.resolve([]),
    schedules: () => Promise.resolve(new Map()),
    adLabels: () => Promise.resolve(new Map()),
    isFavorite: () => Promise.resolve(false),
    coverMeta: () => Promise.resolve([]),
    enrichment: () => Promise.resolve(enrichment as never),
  };
  return new GuideService(
    db,
    repo as GuideRepository,
    {
      findById: (id: string) => Promise.resolve({ id, status: "active", timezone: "Europe/Kyiv" }),
    } as unknown as RegionsRepository,
    {} as EmergencyContactsRepository,
    { links: () => Promise.resolve([]) } as unknown as MediaService,
    photosSvc,
  );
}

describe("GuideService.place — богатая карточка", () => {
  it("без обогащения — пустые поля (ничего не выдумывается)", async () => {
    const card = await guide(undefined, photos().svc).place(REGION, PLACE, {});
    expect(card).toMatchObject({
      typeLabel: null,
      summary: null,
      aiSummary: null,
      priceLevel: null,
      amenities: [],
      rating: null,
      reviews: [],
      googlePhotos: [],
      googleMapsUri: null,
      wikipedia: null,
    });
  });

  it("с обогащением: тип, рейтинг Google, ИИ-текст с моделью, фото через прокси с авторами", async () => {
    const enrichment = {
      google: {
        typeLabel: "Піцерія",
        summary: null,
        priceLevel: 2,
        rating: 4.8,
        ratingCount: 1532,
        mapsUri: "https://maps.google.com/?cid=1",
        amenities: ["beer"],
        reviews: [],
        photos: [
          { name: NAME, width: 4032, height: 3024, authors: [{ name: "Олена", uri: null, photoUri: null }] },
        ],
      },
      wiki: null,
      ai_summary_uk: "Піцерія у Яремчі.",
      ai_model: "claude-sonnet-5-5",
      ai_generated_at: new Date("2026-11-02T10:00:00Z"),
    };
    const card = await guide(enrichment, photos().svc).place(REGION, PLACE, {});
    expect(card).toMatchObject({
      typeLabel: "Піцерія",
      rating: { value: 4.8, count: 1532, source: "google" },
      aiSummary: {
        text: "Піцерія у Яремчі.",
        model: "claude-sonnet-5-5",
        generatedAt: "2026-11-02T10:00:00.000Z",
      },
      amenities: ["beer"],
      googlePhotos: [
        {
          url: expect.stringContaining(
            `https://api.example/places/${PLACE}/google-photos/0?regionId=${REGION}&w=400&v=`,
          ) as unknown as string,
          largeUrl: expect.stringContaining("&w=1200&v=") as unknown as string,
          authors: [{ name: "Олена" }],
        },
      ],
    });
    // Без ключа (сервис фото выключен) — фото Google не отдаются.
    expect(
      (await guide(enrichment, photos({ apiKey: undefined }).svc).place(REGION, PLACE, {}))?.googlePhotos,
    ).toEqual([]);
  });

  it("googlePhoto: n-е фото места → адрес файла; нет фото — undefined", async () => {
    const enrichment = { google: { photos: [{ name: NAME }] } };
    const svc = guide(enrichment, photos().svc);
    expect(await svc.googlePhoto(REGION, PLACE, 0, 400)).toBe(URI);
    expect(await svc.googlePhoto(REGION, PLACE, 3, 400)).toBeUndefined();
  });
});

describe("обложка у нас в выдаче", () => {
  it("coverPhoto: ссылка на /cover с версией, подпись автора; нет обложки — null", async () => {
    const svc = guide(undefined, photos().svc);
    (svc as unknown as { repo: Partial<GuideRepository> }).repo.coverMeta = () =>
      Promise.resolve([
        {
          place_id: PLACE,
          width: 400,
          height: 300,
          author_attributions: [{ name: "Олена", uri: null, photoUri: null }],
          license: null,
          source_url: null,
          source: "google" as const,
          photo_name: NAME,
          fetched_at: new Date("2026-11-03T00:00:00Z"),
        },
      ]);
    const card = await svc.place(REGION, PLACE, {});
    expect(card?.coverPhoto).toMatchObject({
      url: expect.stringMatching(
        /^https:\/\/api\.example\/places\/.+\/cover\?regionId=.+&v=[0-9a-f]{16}$/,
      ) as unknown,
      source: "google",
      authors: [{ name: "Олена" }],
    });
    expect((await guide(undefined, photos().svc).place(REGION, PLACE, {}))?.coverPhoto).toBeNull();
  });
});

describe("GET /cover в сервисе", () => {
  it("версия совпала (If-None-Match) — байты из БД не читаются; иначе — файл", async () => {
    const svc = guide(undefined, photos().svc);
    const repo = (svc as unknown as { repo: Partial<GuideRepository> }).repo;
    const fetchedAt = new Date("2026-11-03T00:00:00Z");
    repo.coverVersion = () =>
      Promise.resolve({ mime: "image/webp", photo_name: NAME, fetched_at: fetchedAt });
    const coverBytes = vi.fn(() =>
      Promise.resolve({
        bytes: Buffer.from("webp"),
        mime: "image/webp",
        photo_name: NAME,
        fetched_at: fetchedAt,
      }),
    );
    repo.coverBytes = coverBytes;
    const etag = coverEtag(NAME, fetchedAt);
    expect(await svc.cover(REGION, PLACE, (v) => v === etag)).toEqual({
      bytes: null,
      mime: "image/webp",
      etag,
    });
    expect(coverBytes).not.toHaveBeenCalled();
    expect((await svc.cover(REGION, PLACE))?.bytes?.toString()).toBe("webp");
    expect(coverBytes).toHaveBeenCalledTimes(1);
    // Повтор той же версии — из памяти, без bytea из БД; новая версия — снова из БД.
    expect((await svc.cover(REGION, PLACE))?.bytes?.toString()).toBe("webp");
    expect(coverBytes).toHaveBeenCalledTimes(1);
    const later = new Date("2026-11-04T00:00:00Z");
    repo.coverVersion = () => Promise.resolve({ mime: "image/webp", photo_name: NAME, fetched_at: later });
    coverBytes.mockResolvedValue({
      bytes: Buffer.from("new"),
      mime: "image/webp",
      photo_name: NAME,
      fetched_at: later,
    });
    expect((await svc.cover(REGION, PLACE))?.bytes?.toString()).toBe("new");
    expect(coverBytes).toHaveBeenCalledTimes(2);
  });
});

describe("descriptionAuto — скрывать можно только автоописание импорта", () => {
  it("импорт Google с подписью источника — авто; ручное описание (админка) — нет", async () => {
    expect(isAutoDescription("google", { uk: "Ресторан у Яремчі. Джерело: Google Maps." })).toBe(true);
    expect(isAutoDescription("google", { uk: "Наш ресторан з терасою — описав власник." })).toBe(false);
    expect(isAutoDescription("manual", { uk: "Ресторан у Яремчі. Джерело: Google Maps." })).toBe(false);
    expect(isAutoDescription("google", null)).toBe(false);
    expect((await guide(undefined).place(REGION, PLACE, {}))?.descriptionAuto).toBe(true);
  });
});

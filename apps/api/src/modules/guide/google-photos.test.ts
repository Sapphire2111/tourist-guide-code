// Unit (без сети и БД): прокси фото Google — адрес файла запрашивается у Google один раз (дальше память и БД),
// ключ уходит только заголовком, ответ не с хоста Google не отдаётся, суточный предел, без ключа — без запросов.
// Картка місця с обогащением и без («нет данных — пусто»).
import { describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import type { EmergencyContactsRepository } from "../emergency-contacts/index.js";
import type { MediaService } from "../media/index.js";
import type { RegionsRepository } from "../regions/index.js";
import type { GuideRepository } from "./guide.repository.js";
import { GuideService } from "./guide.service.js";
import { GooglePhotosService } from "./google-photos.js";

const NAME = "places/ChIJ-YqOVmolN0cRIY6uqQPGF4k/photos/AbC_1";
const URI = "https://lh3.googleusercontent.com/places/abc=w400";

const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

function photos(
  opts: { apiKey?: string; dailyLimit?: number; dbRow?: { photo_uri: string; fetched_at: Date } } = {},
) {
  const { db, queries } = recordingDb({}, (q) =>
    q.sql.startsWith("select") && opts.dbRow ? [opts.dbRow] : [],
  );
  const fetchMock = vi.fn(() => Promise.resolve(ok({ photoUri: URI, name: NAME })));
  const svc = new GooglePhotosService(db, {
    apiKey: "apiKey" in opts ? opts.apiKey : "secret-key",
    dailyLimit: opts.dailyLimit,
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

    const limited = photos({ dailyLimit: 1 });
    expect(await limited.svc.uri(NAME, 400)).toBe(URI);
    expect(await limited.svc.uri(NAME, 1200)).toBeNull();
    expect(limited.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ссылка карточки — на прокси api, без ключа", () => {
    const { svc } = photos();
    expect(svc.proxyUrl("r1", "p1", 2, 1200)).toBe(
      "https://api.example/places/p1/google-photos/2?regionId=r1&w=1200",
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
          url: `https://api.example/places/${PLACE}/google-photos/0?regionId=${REGION}&w=400`,
          largeUrl: `https://api.example/places/${PLACE}/google-photos/0?regionId=${REGION}&w=1200`,
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

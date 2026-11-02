// Адаптер GuideApi поверх @tg/api-client: DTO публичного каталога (блок 4) → модель экранов (types.ts).
// Регион — query regionId из контекста входа (GET /context); без региона гид не работает.
import type { ApiClient, ApiSchemas } from "@tg/api-client";
import {
  NotFoundError,
  UnauthorizedError,
  type EmergencyContact,
  type GuideApi,
  type Photo,
  type PlaceDetail,
  type PlaceSummary,
} from "./types.js";

type PhotoDto = ApiSchemas["PlacePhotoDto"];
type SummaryDto = ApiSchemas["PlaceSummaryDto"];
type CardDto = ApiSchemas["PlaceCardDto"];

/** Вариант фото под мобильный экран: w800, иначе ближайший по ширине. */
export function photoOf(dto: PhotoDto | null): Photo | null {
  if (!dto || dto.variants.length === 0) return null;
  const v =
    dto.variants.find((x) => x.name === "w800") ??
    [...dto.variants].sort((a, b) => Math.abs((a.width ?? 0) - 800) - Math.abs((b.width ?? 0) - 800))[0]!;
  return { url: v.url, alt: dto.alt };
}

export function summaryOf(dto: SummaryDto): PlaceSummary {
  return {
    id: dto.id,
    name: dto.name,
    categoryId: dto.categoryId,
    address: dto.address ?? null,
    location: dto.location ? { lat: dto.location.lat, lng: dto.location.lon } : null,
    distanceMeters: dto.distanceMeters,
    cover: photoOf(dto.cover),
    openNow: dto.openNow,
    recommended: dto.recommended,
    adLabel: dto.adLabel,
  };
}

export function cardOf(dto: CardDto): PlaceDetail {
  return {
    ...summaryOf(dto),
    description: dto.description,
    address: dto.address,
    phone: dto.phone,
    // Внешние ссылки — только https:// и корректное имя Telegram (javascript:/data: не попадут в href).
    website: dto.website && /^https:\/\//i.test(dto.website) ? dto.website : null,
    telegram: dto.telegram && /^[A-Za-z0-9_]{4,32}$/.test(dto.telegram) ? dto.telegram : null,
    photos: dto.photos.map(photoOf).filter((p): p is Photo => p !== null),
    schedule: dto.schedule.weekly.map((w) => ({
      weekday: w.dayOfWeek,
      opens: w.opensAt,
      closes: w.closesAt,
    })),
    tags: dto.tags.map((t) => t.name),
    verifiedAt: dto.verifiedAt,
    openUntil: dto.openUntil,
    favorite: dto.favorite,
  };
}

/** Ответ api: data при 2xx; 404 — NotFoundError; прочее — ошибка. */
async function ok<T>(p: Promise<{ data?: T; response: Response }>): Promise<T> {
  const res = await p;
  if (res.response.status === 404) throw new NotFoundError();
  if (res.response.status === 401) throw new UnauthorizedError();
  if (!res.response.ok || res.data === undefined) throw new Error(`HTTP ${res.response.status}`);
  return res.data;
}

async function done(p: Promise<{ response: Response }>): Promise<void> {
  const res = await p;
  if (res.response.status === 404) throw new NotFoundError();
  if (res.response.status === 401) throw new UnauthorizedError();
  if (!res.response.ok) throw new Error(`HTTP ${res.response.status}`);
}

export function createGuideApi(api: ApiClient, regionId: string | null): GuideApi {
  const region = () => {
    if (!regionId) throw new Error("no region");
    return regionId;
  };
  return {
    categories: async () => {
      const data = await ok(api.GET("/categories", { params: { query: { regionId: region() } } }));
      return data.items.map((c) => ({
        id: c.id,
        parentId: c.parentId,
        name: c.name,
        homeSection: c.homeSection,
      }));
    },
    search: async ({ point, radius, categoryId, q }) => {
      const query = {
        regionId: region(),
        ...(point ? { lat: point.lat, lng: point.lng } : {}),
        ...(point && radius ? { radius } : {}),
        ...(categoryId ? { category: categoryId } : {}),
        ...(q ? { q } : {}),
        limit: 50,
      };
      const data = await ok(api.GET("/places/search", { params: { query } }));
      return data.items.map(summaryOf);
    },
    place: async (id) =>
      cardOf(await ok(api.GET("/places/{id}", { params: { path: { id }, query: { regionId: region() } } }))),
    favorites: async () => {
      const data = await ok(api.GET("/favorites", { params: { query: { regionId: region() } } }));
      return data.items.map(summaryOf);
    },
    addFavorite: async (placeId) => done(api.POST("/favorites", { body: { regionId: region(), placeId } })),
    removeFavorite: async (placeId) =>
      done(
        api.DELETE("/favorites/{placeId}", {
          params: { path: { placeId }, query: { regionId: region() } },
        }),
      ),
    emergencyContacts: async () => {
      const data = await ok(api.GET("/emergency-contacts", { params: { query: { regionId: region() } } }));
      return data.items.map(
        (c): EmergencyContact => ({
          id: c.id,
          kind: c.kind,
          name: c.name,
          phone: c.phone,
          description: c.description,
        }),
      );
    },
  };
}

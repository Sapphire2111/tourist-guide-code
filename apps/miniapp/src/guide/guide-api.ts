// Адаптер GuideApi поверх @tg/api-client: DTO публичного каталога (блок 4) → модель экранов (types.ts).
// Регион — query regionId из контекста входа (GET /context); без региона гид не работает.
import type { ApiClient, ApiSchemas } from "@tg/api-client";
import {
  NotFoundError,
  UnauthorizedError,
  type Author,
  type EmergencyContact,
  type GuideApi,
  type Peak,
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

/**
 * Путь на нашем api ("/places/…"); protocol-relative "//host/…", "/\host" и строки с управляющими символами
 * (браузер вырезает \t и \n: "/\t/host" → "//host") — чужой хост, отсекаются.
 */
function sameOrigin(url: string): string | null {
  // eslint-disable-next-line no-control-regex
  return /^\/(?![/\\])/.test(url) && !/[\x00-\x1f\x7f]/.test(url) ? url : null;
}

/** Обложка у нас (Google/Wikimedia) — с подписью автора; api без поля — null. */
export function coverPhotoOf(dto: SummaryDto["coverPhoto"] | undefined): Photo | null {
  if (!dto) return null;
  const url = https(dto.url) ?? sameOrigin(dto.url);
  if (!url) return null;
  return {
    url,
    alt: null,
    credit: {
      authors: dto.authors.map(authorOf),
      license: dto.license,
      sourceUrl: https(dto.sourceUrl),
      source: dto.source,
    },
  };
}

export function summaryOf(dto: SummaryDto): PlaceSummary {
  return {
    id: dto.id,
    name: dto.name,
    categoryId: dto.categoryId,
    address: dto.address ?? null,
    location: dto.location ? { lat: dto.location.lat, lng: dto.location.lon } : null,
    googlePlaceId: (dto as { googlePlaceId?: string | null }).googlePlaceId ?? null,
    distanceMeters: dto.distanceMeters,
    cover: photoOf(dto.cover) ?? coverPhotoOf((dto as Partial<SummaryDto>).coverPhoto),
    openNow: dto.openNow,
    recommended: dto.recommended,
    adLabel: dto.adLabel,
    peak: peakOf((dto as Partial<SummaryDto>).peak),
    hasOffer: (dto as Partial<SummaryDto>).hasOffer === true,
  };
}

/** Вершина из api; ссылки источников — только https. api старее схемы — null. */
export function peakOf(dto: SummaryDto["peak"] | undefined): Peak | null {
  if (!dto) return null;
  return {
    slug: dto.slug,
    heightM: dto.heightM,
    range: dto.range,
    difficulty: dto.difficulty,
    route: dto.route
      ? {
          start: dto.route.start,
          startLocation: dto.route.startLocation,
          roundTripKm: dto.route.roundTripKm,
          elevationGainM: dto.route.elevationGainM,
          gainKind: dto.route.gainKind,
          upHours: dto.route.upHours,
          downHours: dto.route.downHours,
          totalHours: dto.route.totalHours,
          trail: dto.route.trail,
        }
      : null,
    note: dto.note,
    warnings: dto.warnings,
    sources: dto.sources.flatMap((s) => {
      const url = https(s.url);
      return url ? [{ title: s.title, url }] : [];
    }),
    weatherPoint: dto.weatherPoint,
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
    // Источник reviews — по отзывам Google (places:amenities): отдельно, с пометкой в карточке.
    tags: dto.tags.filter((t) => t.source !== "reviews").map((t) => t.name),
    reviewTags: dto.tags.filter((t) => t.source === "reviews").map((t) => t.name),
    timezone: dto.schedule.timezone,
    offers: ((dto as Partial<CardDto>).offers ?? []).map((o) => ({
      id: o.id,
      title: o.title,
      description: o.description,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
    })),
    verifiedAt: dto.verifiedAt,
    openUntil: dto.openUntil,
    favorite: dto.favorite,
    // Старый сервер без поля — ссылки «Це мій заклад?» нет.
    claimable: dto.claimable === true,
    hasPriceList: (dto as Partial<CardDto>).hasPriceList ?? false,
    ...richOf(dto),
  };
}

/** Внешняя ссылка — только https:// (javascript:/data: не попадут в href/src). */
export const https = (u: string | null | undefined): string | null =>
  typeof u === "string" && /^https:\/\//i.test(u) ? u : null;

const authorOf = (a: { name: string; uri: string | null; photoUri: string | null }): Author => ({
  name: a.name,
  uri: https(a.uri),
  photoUri: https(a.photoUri),
});

/** Поля богатой карточки; api старее этой схемы (без полей) — пусто. */
function richOf(dto: Partial<CardDto>): Partial<PlaceDetail> {
  const wiki = dto.wikipedia ?? null;
  const wikiUrl = https(wiki?.url);
  return {
    descriptionAuto: dto.descriptionAuto ?? false,
    typeLabel: dto.typeLabel ?? null,
    summary: dto.summary ?? null,
    aiSummary: dto.aiSummary ? { text: dto.aiSummary.text, model: dto.aiSummary.model } : null,
    priceLevel: dto.priceLevel ?? null,
    amenities: dto.amenities ?? [],
    rating: dto.rating ? { value: dto.rating.value, count: dto.rating.count } : null,
    reviews: (dto.reviews ?? []).map((r) => ({
      author: authorOf(r.author),
      rating: r.rating,
      text: r.text,
      relativeTime: r.relativeTime,
      uri: https(r.uri),
    })),
    googlePhotos: (dto.googlePhotos ?? []).flatMap((p) => {
      const url = https(p.url) ?? sameOrigin(p.url);
      const largeUrl = https(p.largeUrl) ?? sameOrigin(p.largeUrl);
      return url && largeUrl ? [{ url, largeUrl, authors: p.authors.map(authorOf) }] : [];
    }),
    googleMapsUri: https(dto.googleMapsUri),
    wikipedia:
      wiki && wikiUrl
        ? {
            title: wiki.title,
            url: wikiUrl,
            image:
              wiki.image && https(wiki.image.url) && https(wiki.image.sourceUrl)
                ? {
                    url: wiki.image.url,
                    author: wiki.image.author,
                    license: wiki.image.license,
                    sourceUrl: wiki.image.sourceUrl,
                  }
                : null,
          }
        : null,
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
        code: c.code,
        name: c.name,
        homeSection: c.homeSection,
      }));
    },
    localities: async () => {
      const data = await ok(api.GET("/localities", { params: { query: { regionId: region() } } }));
      return data.items.map((l) => ({
        id: l.id,
        name: l.name,
        placeCount: l.placeCount,
        location: l.location ? { lat: l.location.lat, lng: l.location.lon } : null,
      }));
    },
    search: async ({
      point,
      radius,
      categoryId,
      q,
      excludeSections,
      localityIds,
      tags,
      limit,
      max,
      signal,
      onPartial,
    }) => {
      const query = {
        regionId: region(),
        ...(point ? { lat: point.lat, lng: point.lng } : {}),
        ...(point && radius ? { radius } : {}),
        ...(categoryId ? { category: categoryId } : {}),
        ...(q ? { q } : {}),
        ...(excludeSections?.length ? { exclude_section: [...excludeSections] } : {}),
        ...(localityIds?.length ? { localityIds: [...localityIds] } : {}),
        ...(tags?.length ? { tags: [...tags] } : {}),
        limit: limit ?? 50,
      };
      // max — догрузка страниц (страница — limit, по умолчанию 50) до max мест: карта «Де жити» со всеми местами.
      const items: PlaceSummary[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        // Не throwIfAborted: его нет в Safari iOS < 15.4.
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        let data: { items: SummaryDto[]; nextOffset: number | null };
        try {
          data = await ok(
            api.GET("/places/search", { params: { query: offset ? { ...query, offset } : query }, signal }),
          );
        } catch (error) {
          // Сбой догрузки (не первой страницы и не отмена) — показываем уже загруженное.
          if (items.length === 0 || signal?.aborted) throw error;
          onPartial?.("failed");
          break;
        }
        items.push(...data.items.map(summaryOf));
        offset = max && items.length < max ? data.nextOffset : null;
        // Дошли до max, а сервер говорит, что места есть ещё, — список усечён.
        if (max && items.length >= max && data.nextOffset !== null) onPartial?.("truncated");
      }
      return max ? items.slice(0, max) : items;
    },
    // Те же параметры, что у search (точка, радиус, текст): счётчики совпадают со списком.
    tagCounts: async ({ categoryId, localityIds, q, point, radius }) => {
      const data = await ok(
        api.GET("/places/tag-counts", {
          params: {
            query: {
              regionId: region(),
              ...(point ? { lat: point.lat, lng: point.lng } : {}),
              ...(point && radius ? { radius } : {}),
              ...(categoryId ? { category: categoryId } : {}),
              ...(q ? { q } : {}),
              ...(localityIds?.length ? { localityIds: [...localityIds] } : {}),
            },
          },
        }),
      );
      return Object.fromEntries(data.items.map((i) => [i.code, i.count]));
    },
    place: async (id) =>
      cardOf(await ok(api.GET("/places/{id}", { params: { path: { id }, query: { regionId: region() } } }))),
    priceList: async (id) => {
      const data = await ok(
        api.GET("/places/{id}/price-list", { params: { path: { id }, query: { regionId: region() } } }),
      );
      return {
        sections: data.sections.map((s) => ({
          id: s.id,
          title: s.title,
          items: s.items.map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description,
            priceMinor: i.priceMinor,
            priceFrom: i.priceFrom,
            unit: i.unit,
          })),
        })),
      };
    },
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

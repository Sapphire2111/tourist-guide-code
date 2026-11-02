// Клиент Google Places API (New) для импорта: Text Search и Place Photos. Каждый ответ кэшируется в файл каталога
// кэша (вне репозитория): повторный прогон берёт ответ из кэша и не тратит квоту. Ключ API — только в заголовке
// запроса; в кэш, ошибки и логи он не попадает.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_UPLOAD_BYTES } from "@tg/media";
import type { GooglePlace } from "./mapping.js";

const API = "https://places.googleapis.com/v1";

/**
 * Только нужные поля (FieldMask определяет и стоимость запроса): данные карточки, часы, фото, статус. Детали
 * (Place Details) отдельно не запрашиваются — Text Search возвращает те же поля.
 */
export const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.shortFormattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.businessStatus",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.regularOpeningHours.periods",
  "places.rating",
  "places.userRatingCount",
  "places.editorialSummary",
  "places.photos.name",
  "nextPageToken",
].join(",");

export type SearchTextRequest = {
  textQuery: string;
  languageCode: string;
  regionCode: string;
  pageSize: number;
  pageToken?: string;
  locationRestriction: {
    rectangle: {
      low: { latitude: number; longitude: number };
      high: { latitude: number; longitude: number };
    };
  };
};

export type SearchTextResponse = { places?: GooglePlace[]; nextPageToken?: string };

/**
 * Поля Place Details для богатой карточки (places:enrich). Отзывы, удобства и ценовой уровень — SKU «Place Details
 * Enterprise + Atmosphere» (самый дорогой): запрос один на место, ответ кэшируется. Часы, телефон, сайт, рейтинг
 * уже есть из Text Search импорта и здесь не запрашиваются повторно.
 */
export const DETAILS_FIELD_MASK = [
  "id",
  "primaryTypeDisplayName",
  "editorialSummary",
  "priceLevel",
  "rating",
  "userRatingCount",
  "googleMapsUri",
  "reviews",
  "photos",
  "servesBreakfast",
  "servesBrunch",
  "servesLunch",
  "servesDinner",
  "servesCoffee",
  "servesDessert",
  "servesBeer",
  "servesWine",
  "servesCocktails",
  "servesVegetarianFood",
  "dineIn",
  "takeout",
  "delivery",
  "curbsidePickup",
  "reservable",
  "outdoorSeating",
  "liveMusic",
  "menuForChildren",
  "goodForChildren",
  "goodForGroups",
  "goodForWatchingSports",
  "allowsDogs",
  "restroom",
  "parkingOptions",
  "accessibilityOptions",
  "paymentOptions",
].join(",");

/** Исчерпан лимит запросов к Google (--max-requests): импорт останавливает выгрузку и работает с тем, что есть. */
export class RequestLimitError extends Error {
  override readonly name = "RequestLimitError";
}

export class GoogleApiError extends Error {
  override readonly name = "GoogleApiError";
  /** status — HTTP-статус ответа Google (нет — ошибка не HTTP). */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type GoogleClientOptions = {
  /** Ключ нужен только для запросов мимо кэша. */
  apiKey: string | undefined;
  cacheDir: string;
  /** Предел запросов к Google за прогон (ответы из кэша не считаются). */
  maxRequests: number;
  fetch?: typeof fetch;
  /** Таймаут одного запроса, мс. */
  timeoutMs?: number;
  /** Только оценка: в сеть не ходить, промахи кэша считать в planned (places:enrich --plan). */
  planOnly?: boolean;
};

/** Режим planOnly: ответа нет в кэше, запрос только учтён. */
export class PlannedRequest extends Error {
  override readonly name = "PlannedRequest";
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

const DEFAULT_TIMEOUT_MS = 20_000;
/** Сколько редиректов фото проходить вручную (каждый — тоже только на хост Google). */
const MAX_PHOTO_REDIRECTS = 3;

/** Адрес файла фото: только https и только хосты Google (photoUri приходит из ответа или кэша — не доверяем вслепую). */
export function isAllowedPhotoUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return ["googleusercontent.com", "ggpht.com"].some((d) => host === d || host.endsWith(`.${d}`));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Минимальная проверка формы ответа Text Search (в т. ч. из кэша): не та — запрос заново / ошибка. */
const isSearchResponse = (v: unknown): v is SearchTextResponse =>
  isObject(v) &&
  (v.places === undefined ||
    (Array.isArray(v.places) && v.places.every((p) => isObject(p) && typeof p.id === "string"))) &&
  (v.nextPageToken === undefined || typeof v.nextPageToken === "string");

/** Ответ Place Details: объект с id (остальное разбирает places-enrich/details.ts). */
const isDetailsResponse = (v: unknown): v is Record<string, unknown> & { id: string } =>
  isObject(v) && typeof v.id === "string";

const isPhotoMediaResponse = (v: unknown): v is { photoUri?: string } =>
  isObject(v) && (v.photoUri === undefined || typeof v.photoUri === "string");

/** Тело ответа, но не больше `limit` байт: поток обрывается, а не буферизуется целиком. */
async function readLimited(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel();
    throw new GoogleApiError(`Фото больше ${limit} байт`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new GoogleApiError(`Фото больше ${limit} байт`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export class GooglePlacesClient {
  /** Запросов к Google за прогон (по видам). */
  readonly requests = { search: 0, photoMedia: 0, photoDownload: 0, details: 0 };
  cacheHits = 0;
  /** Режим оценки (planOnly): ответов нет в кэше — сколько запросов понадобилось бы (по видам), без сети. */
  readonly planned = { search: 0, photoMedia: 0, photoDownload: 0, details: 0 };
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GoogleClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get totalRequests(): number {
    return (
      this.requests.search + this.requests.photoMedia + this.requests.photoDownload + this.requests.details
    );
  }

  /**
   * Place Details (New) на uk: поля DETAILS_FIELD_MASK. null — в режиме planOnly ответа нет в кэше (запрос учтён
   * в planned) или Google не знает такого места (404).
   */
  async placeDetails(placeId: string): Promise<(Record<string, unknown> & { id: string }) | null> {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(placeId)) throw new GoogleApiError("Недопустимый id места Google");
    const file = path.join(this.options.cacheDir, `details-${hash(`${placeId}|${DETAILS_FIELD_MASK}`)}.json`);
    try {
      return await this.cached(file, "details", isDetailsResponse, async (key) => {
        const res = await this.fetch(`${API}/places/${placeId}?languageCode=uk&regionCode=UA`, {
          headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAILS_FIELD_MASK },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        return this.json(res, "place details", isDetailsResponse);
      });
    } catch (err) {
      if (err instanceof PlannedRequest) return null;
      if (err instanceof GoogleApiError && err.status === 404) return null;
      throw err;
    }
  }

  private searchFile(body: SearchTextRequest): string {
    return path.join(this.options.cacheDir, `search-${hash(JSON.stringify(body))}.json`);
  }

  searchText(body: SearchTextRequest): Promise<SearchTextResponse> {
    return this.cached(this.searchFile(body), "search", isSearchResponse, async (key) => {
      const res = await this.fetch(`${API}/places:searchText`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": SEARCH_FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return this.json(res, "searchText", isSearchResponse);
    });
  }

  /** Убрать ответ из кэша (страница, чей токен следующей страницы устарел). */
  async forgetSearch(body: SearchTextRequest): Promise<void> {
    await rm(this.searchFile(body), { force: true });
  }

  /**
   * Адрес файла фото (photoUri) по имени фото places/…/photos/…: skipHttpRedirect — JSON вместо редиректа, чтобы
   * закэшировать ответ.
   */
  async photoUri(photoName: string, maxWidthPx: number): Promise<string | null> {
    if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(photoName))
      throw new GoogleApiError("Недопустимое имя фото Google");
    const file = path.join(this.options.cacheDir, `photo-${hash(`${photoName}|${maxWidthPx}`)}.json`);
    const r = await this.cached(file, "photoMedia", isPhotoMediaResponse, async (key) => {
      const url = `${API}/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`;
      const res = await this.fetch(url, {
        headers: { "X-Goog-Api-Key": key },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return this.json(res, "photo media", isPhotoMediaResponse);
    });
    return r.photoUri ?? null;
  }

  /**
   * Содержимое фото по photoUri (без ключа); кэшируется по имени фото. Только https на хостах Google; редиректы —
   * вручную и тоже только на них; таймаут; не больше `maxBytes`.
   */
  async photoBytes(photoName: string, photoUri: string, maxBytes = MAX_UPLOAD_BYTES): Promise<Buffer> {
    const file = path.join(this.options.cacheDir, `photo-${hash(photoName)}.bin`);
    try {
      const data = await readFile(file);
      if (data.length > 0 && data.length <= maxBytes) {
        this.cacheHits++;
        return data;
      }
    } catch {
      // нет в кэше
    }
    let url = photoUri;
    for (let hop = 0; ; hop++) {
      if (!isAllowedPhotoUrl(url)) throw new GoogleApiError("Адрес фото не https или не на хосте Google");
      this.take("photoDownload");
      const res = await this.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location || hop >= MAX_PHOTO_REDIRECTS)
          throw new GoogleApiError("Фото: редирект без адреса или слишком много редиректов", res.status);
        url = new URL(location, url).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new GoogleApiError(`Фото: HTTP ${res.status}`, res.status);
      }
      const data = await readLimited(res, maxBytes);
      await mkdir(this.options.cacheDir, { recursive: true });
      await writeFile(file, data);
      return data;
    }
  }

  private take(kind: keyof GooglePlacesClient["requests"]): void {
    if (this.totalRequests >= this.options.maxRequests)
      throw new RequestLimitError(`Достигнут лимит запросов к Google: ${this.options.maxRequests}`);
    this.requests[kind]++;
  }

  private async cached<T>(
    file: string,
    kind: keyof GooglePlacesClient["requests"],
    valid: (v: unknown) => v is T,
    load: (apiKey: string) => Promise<T>,
  ): Promise<T> {
    try {
      const data: unknown = JSON.parse(await readFile(file, "utf8"));
      if (valid(data)) {
        this.cacheHits++;
        return data;
      }
    } catch {
      // нет в кэше (или файл испорчен) — запрос
    }
    if (this.options.planOnly) {
      this.planned[kind]++;
      throw new PlannedRequest();
    }
    const key = this.options.apiKey;
    if (!key) throw new GoogleApiError("Нет GOOGLE_MAPS_API_KEY, а ответа нет в кэше");
    this.take(kind);
    const data = await load(key);
    await mkdir(this.options.cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify(data));
    return data;
  }

  private async json<T>(res: Response, what: string, valid: (v: unknown) => v is T): Promise<T> {
    if (res.ok) {
      const data: unknown = await res.json();
      if (!valid(data)) throw new GoogleApiError(`Google ${what}: неожиданный формат ответа`);
      return data;
    }
    // Тело ошибки Google ключа не содержит; обрезаем на всякий случай.
    const text = (await res.text()).slice(0, 500);
    throw new GoogleApiError(`Google ${what}: HTTP ${res.status} ${text}`, res.status);
  }
}

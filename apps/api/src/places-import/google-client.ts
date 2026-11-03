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
  override readonly name: string = "RequestLimitError";
}

export class GoogleApiError extends Error {
  override readonly name: string = "GoogleApiError";
  /** status — HTTP-статус ответа Google (нет — ошибка не HTTP). */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Google 429 с поминутной квотой не снялся за все повторы: место откладывается, прогон продолжается. */
export class GoogleRateLimitedError extends GoogleApiError {
  override readonly name = "GoogleRateLimitedError";
}

/** Нет GOOGLE_MAPS_API_KEY, а ответа нет в кэше (необязательный шаг можно пропустить). */
export class NoApiKeyError extends GoogleApiError {}

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
  /**
   * Учёт платного SKU перед запросом мимо кэша (месячный предел в БД, places-enrich/quota.ts): false — предел
   * исчерпан, запрос не делается (RequestLimitError). Бесплатные виды (поиск в кэше, IDs Only) не учитываются.
   */
  quota?: (sku: "place_details" | "place_photos") => Promise<boolean>;
  /** Запросов в минуту к Google (равномерный темп); не задан или 0 — без темпа. */
  rpm?: number;
  /** Повторов при 429 с поминутной квотой (по умолчанию 5). */
  maxRateRetries?: number;
  /** Подмены для тестов: пауза, часы, джиттер. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: (s: string) => void;
};

/** Месячный (суточный) предел SKU в google_api_usage исчерпан — продолжить в следующем месяце. */
export class MonthlyLimitError extends RequestLimitError {
  override readonly name = "MonthlyLimitError";
}

/** Суточная/месячная квота Google исчерпана (429 per day/month): до конца прогона запросы к Google не делаются. */
export class GoogleDailyQuotaError extends RequestLimitError {
  override readonly name = "GoogleDailyQuotaError";
}

/** Режим planOnly: ответа нет в кэше, запрос только учтён. */
export class PlannedRequest extends Error {
  override readonly name = "PlannedRequest";
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RATE_RETRIES = 5;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const MINUTE_MS = 60_000;

/** 429 по суточной/месячной квоте (а не поминутной): ждать бесполезно. */
export const isLongQuota429 = (body: string): boolean =>
  /per\s*day|per\s*month|PerDay|PerMonth|daily|monthly/i.test(body) &&
  !/RATE_LIMIT_EXCEEDED|per\s*minute|PerMinute/i.test(body);
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
  readonly requests = { search: 0, photoMedia: 0, photoDownload: 0, details: 0, detailsIds: 0 };
  cacheHits = 0;
  /** Режим оценки (planOnly): ответов нет в кэше — сколько запросов понадобилось бы (по видам), без сети. */
  readonly planned = { search: 0, photoMedia: 0, photoDownload: 0, details: 0, detailsIds: 0 };
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  /** Сколько мс ждали (темп --rpm и повторы после 429) и сколько раз был 429 с поминутной квотой. */
  waitedMs = 0;
  rateLimitHits = 0;
  /** Места/фото, отложенные из-за поминутной квоты после всех повторов. */
  rateLimitedGiveUps = 0;
  private nextSlot = 0;
  private longQuota: GoogleDailyQuotaError | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;

  constructor(private readonly options: GoogleClientOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = options.now ?? Date.now;
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async pause(ms: number): Promise<void> {
    if (ms <= 0) return;
    this.waitedMs += ms;
    await this.sleep(ms);
  }

  /**
   * Запрос к API Google: равномерный темп (rpm), при 429 с поминутной квотой — ожидание (Retry-After или 60 с +
   * джиттер) и повтор; суточная/месячная квота — GoogleDailyQuotaError (дальше запросы не идут).
   */
  private async googleFetch(url: string, init: RequestInit): Promise<Response> {
    if (this.longQuota) throw this.longQuota;
    const retries = this.options.maxRateRetries ?? DEFAULT_RATE_RETRIES;
    const interval = this.options.rpm && this.options.rpm > 0 ? MINUTE_MS / this.options.rpm : 0;
    for (let attempt = 0; ; attempt++) {
      if (interval) {
        const now = this.clock();
        const start = Math.max(now, this.nextSlot);
        this.nextSlot = start + interval;
        await this.pause(start - now);
      }
      const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status !== 429) return res;
      const text = (await res.text()).slice(0, 500);
      if (isLongQuota429(text)) {
        this.longQuota = new GoogleDailyQuotaError(
          `Суточная/месячная квота Google исчерпана (HTTP 429): запросы к Google остановлены. ${text.slice(0, 200)}`,
        );
        throw this.longQuota;
      }
      this.rateLimitHits++;
      if (attempt >= retries) {
        this.rateLimitedGiveUps++;
        throw new GoogleRateLimitedError(
          `Google: поминутная квота, ${retries} повторов не помогли — отложено. ${text.slice(0, 200)}`,
          429,
        );
      }
      const ra = Number(res.headers.get("retry-after"));
      const wait =
        Number.isFinite(ra) && ra > 0
          ? Math.min(ra * 1000, MAX_RETRY_AFTER_MS)
          : MINUTE_MS + Math.floor((this.options.random ?? Math.random)() * 5000);
      this.options.log?.(
        `Google 429 (поминутная квота): жду ${Math.round(wait / 1000)} с, повтор ${attempt + 1}/${retries}`,
      );
      this.nextSlot = Math.max(this.nextSlot, this.clock() + wait);
      await this.pause(wait);
    }
  }

  get totalRequests(): number {
    return (
      this.requests.search +
      this.requests.photoMedia +
      this.requests.photoDownload +
      this.requests.details +
      this.requests.detailsIds
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
        const res = await this.googleFetch(`${API}/places/${placeId}?languageCode=uk&regionCode=UA`, {
          headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAILS_FIELD_MASK },
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
      const res = await this.googleFetch(`${API}/places:searchText`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": SEARCH_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
      return this.json(res, "searchText", isSearchResponse);
    });
  }

  /** Убрать ответ из кэша (страница, чей токен следующей страницы устарел). */
  async forgetSearch(body: SearchTextRequest): Promise<void> {
    await rm(this.searchFile(body), { force: true });
  }

  /**
   * Только фото места с авторами — Place Details с FieldMask «id,photos» (SKU Essentials IDs Only, бесплатный по
   * прейскуранту Google). null — в planOnly нет в кэше или места нет у Google.
   */
  async placePhotos(placeId: string): Promise<(Record<string, unknown> & { id: string }) | null> {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(placeId)) throw new GoogleApiError("Недопустимый id места Google");
    const mask = "id,photos";
    const file = path.join(this.options.cacheDir, `details-ids-${hash(`${placeId}|${mask}`)}.json`);
    try {
      return await this.cached(file, "detailsIds", isDetailsResponse, async (key) => {
        const res = await this.googleFetch(`${API}/places/${placeId}`, {
          headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask },
        });
        return this.json(res, "place photos (ids only)", isDetailsResponse);
      });
    } catch (err) {
      if (err instanceof PlannedRequest) return null;
      if (err instanceof GoogleApiError && err.status === 404) return null;
      throw err;
    }
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
      const res = await this.googleFetch(url, {
        headers: { "X-Goog-Api-Key": key },
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

  /** Запросов, кроме бесплатных IDs Only. */
  get paidRequests(): number {
    return this.totalRequests - this.requests.detailsIds;
  }

  private take(kind: keyof GooglePlacesClient["requests"]): void {
    if (kind !== "detailsIds" && this.paidRequests >= this.options.maxRequests)
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
    if (!key) throw new NoApiKeyError("Нет GOOGLE_MAPS_API_KEY, а ответа нет в кэше");
    // Бесплатные запросы (IDs Only) в --max-requests не входят — он страхует платные.
    if (kind !== "detailsIds" && this.paidRequests >= this.options.maxRequests)
      throw new RequestLimitError(`Достигнут лимит запросов к Google: ${this.options.maxRequests}`);
    const sku = kind === "details" ? "place_details" : kind === "photoMedia" ? "place_photos" : null;
    if (sku && this.options.quota && !(await this.options.quota(sku)))
      throw new MonthlyLimitError(`Исчерпан месячный предел Google (${sku})`);
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

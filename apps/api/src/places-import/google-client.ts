// Клиент Google Places API (New) для импорта: Text Search и Place Photos. Каждый ответ кэшируется в файл каталога
// кэша (вне репозитория): повторный прогон берёт ответ из кэша и не тратит квоту. Ключ API — только в заголовке
// запроса; в кэш, ошибки и логи он не попадает.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

/** Исчерпан лимит запросов к Google (--max-requests): импорт останавливает выгрузку и работает с тем, что есть. */
export class RequestLimitError extends Error {
  override readonly name = "RequestLimitError";
}

export class GoogleApiError extends Error {
  override readonly name = "GoogleApiError";
}

export type GoogleClientOptions = {
  /** Ключ нужен только для запросов мимо кэша. */
  apiKey: string | undefined;
  cacheDir: string;
  /** Предел запросов к Google за прогон (ответы из кэша не считаются). */
  maxRequests: number;
  fetch?: typeof fetch;
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export class GooglePlacesClient {
  /** Запросов к Google за прогон (по видам). */
  readonly requests = { search: 0, photoMedia: 0, photoDownload: 0 };
  cacheHits = 0;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: GoogleClientOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  get totalRequests(): number {
    return this.requests.search + this.requests.photoMedia + this.requests.photoDownload;
  }

  searchText(body: SearchTextRequest): Promise<SearchTextResponse> {
    return this.cached(`search-${hash(JSON.stringify(body))}.json`, "search", async (key) => {
      const res = await this.fetch(`${API}/places:searchText`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": SEARCH_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
      return this.json<SearchTextResponse>(res, "searchText");
    });
  }

  /**
   * Адрес файла фото (photoUri) по имени фото places/…/photos/…: skipHttpRedirect — JSON вместо редиректа, чтобы
   * закэшировать ответ.
   */
  async photoUri(photoName: string, maxWidthPx: number): Promise<string | null> {
    if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(photoName))
      throw new GoogleApiError("Недопустимое имя фото Google");
    const r = await this.cached(
      `photo-${hash(`${photoName}|${maxWidthPx}`)}.json`,
      "photoMedia",
      async (key) => {
        const url = `${API}/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`;
        const res = await this.fetch(url, { headers: { "X-Goog-Api-Key": key } });
        return this.json<{ photoUri?: string }>(res, "photo media");
      },
    );
    return r.photoUri ?? null;
  }

  /** Содержимое фото по photoUri (googleusercontent, без ключа); кэшируется по имени фото. */
  async photoBytes(photoName: string, photoUri: string): Promise<Buffer> {
    const file = path.join(this.options.cacheDir, `photo-${hash(photoName)}.bin`);
    try {
      const data = await readFile(file);
      this.cacheHits++;
      return data;
    } catch {
      // нет в кэше
    }
    this.take("photoDownload");
    const res = await this.fetch(photoUri);
    if (!res.ok) throw new GoogleApiError(`Фото: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    await mkdir(this.options.cacheDir, { recursive: true });
    await writeFile(file, data);
    return data;
  }

  private take(kind: keyof GooglePlacesClient["requests"]): void {
    if (this.totalRequests >= this.options.maxRequests)
      throw new RequestLimitError(`Достигнут лимит запросов к Google: ${this.options.maxRequests}`);
    this.requests[kind]++;
  }

  private async cached<T>(
    name: string,
    kind: keyof GooglePlacesClient["requests"],
    load: (apiKey: string) => Promise<T>,
  ): Promise<T> {
    const file = path.join(this.options.cacheDir, name);
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as T;
      this.cacheHits++;
      return data;
    } catch {
      // нет в кэше — запрос
    }
    const key = this.options.apiKey;
    if (!key) throw new GoogleApiError("Нет GOOGLE_MAPS_API_KEY, а ответа нет в кэше");
    this.take(kind);
    const data = await load(key);
    await mkdir(this.options.cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify(data));
    return data;
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (res.ok) return (await res.json()) as T;
    // Тело ошибки Google ключа не содержит; обрезаем на всякий случай.
    const text = (await res.text()).slice(0, 500);
    throw new GoogleApiError(`Google ${what}: HTTP ${res.status} ${text}`);
  }
}

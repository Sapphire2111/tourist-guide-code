// Прокси фото Google для карточки места: по имени фото (places/…/photos/…, из place_enrichments.google) api
// получает у Places API (New) адрес файла (…/media?maxWidthPx=…&skipHttpRedirect=true → photoUri) и отдаёт туристу
// редирект на него — файл грузится браузером прямо с googleusercontent.com, к себе не копируется. Ключ
// GOOGLE_MAPS_API_KEY остаётся на сервере (в photoUri его нет). Адреса кэшируются: в памяти процесса и в БД
// (google_photo_uris) — повторные просмотры и перезапуск api не стоят запросов. Суточный предел запросов к Google —
// страховка бюджета: счётчик в БД (google_api_usage, переживает рестарт и засыпание Render); сверх него фото без
// кэша не отдаются (404, карточка покажет меньше фото). Ошибка Google по фото запоминается на FAILURE_TTL — повторные
// просмотры в этом окне не тратят запросы.
import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { sql } from "kysely";
import { InjectDb, type Db } from "../../db/index.js";
import { GOOGLE_FREE_MONTHLY, GoogleQuota } from "../../places-enrich/quota.js";
import { isAllowedPhotoUrl } from "../../places-import/google-client.js";

/** Допустимые ширины: превью галереи и полноэкранный просмотр. */
export const GOOGLE_PHOTO_WIDTHS = [400, 1200] as const;
export type GooglePhotoWidth = (typeof GOOGLE_PHOTO_WIDTHS)[number];

export const GOOGLE_PHOTOS_CONFIG = Symbol("GOOGLE_PHOTOS_CONFIG");

export type GooglePhotosConfig = {
  apiKey?: string | undefined;
  /** Публичный адрес api (PUBLIC_API_URL) — для ссылок на прокси фото в карточке. */
  apiBaseUrl?: string;
  /** Запросов к Google Place Photos в сутки (UTC) не больше. */
  dailyLimit?: number;
  /** И в месяц не больше (общий счётчик с CLI; по умолчанию — бесплатный объём Google, 1000). */
  monthlyLimit?: number;
  /** Срок жизни закэшированного адреса, ч. */
  ttlHours?: number;
  fetch?: typeof fetch;
};

export const GOOGLE_PHOTO_DAILY_LIMIT_DEFAULT = 300;
export const GOOGLE_PHOTO_TTL_HOURS_DEFAULT = 24;
/** Сколько помнить ошибку Google по фото (без повторных запросов). */
export const GOOGLE_PHOTO_FAILURE_TTL_MS = 6 * 3600_000;
const MEMORY_MAX = 5000;
const TIMEOUT_MS = 8000;
const PHOTO_NAME = /^places\/[A-Za-z0-9_-]{1,255}\/photos\/[A-Za-z0-9_-]{1,1024}$/;

@Injectable()
export class GooglePhotosService {
  private readonly log = new Logger("GooglePhotos");
  private readonly memory = new Map<string, { uri: string; expires: number }>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  /** Ошибки Google по `name|w` до момента повтора. */
  private readonly failures = new Map<string, number>();
  private exhaustedCache: { value: boolean; until: number } | null = null;
  private readonly quota: GoogleQuota;
  private readonly cfg: GooglePhotosConfig & { dailyLimit: number; monthlyLimit: number; ttlHours: number };

  constructor(
    @InjectDb() private readonly db: Db,
    @Optional() @Inject(GOOGLE_PHOTOS_CONFIG) config?: GooglePhotosConfig,
  ) {
    this.cfg = {
      ...config,
      dailyLimit: config?.dailyLimit ?? GOOGLE_PHOTO_DAILY_LIMIT_DEFAULT,
      monthlyLimit: config?.monthlyLimit ?? GOOGLE_FREE_MONTHLY,
      ttlHours: config?.ttlHours ?? GOOGLE_PHOTO_TTL_HOURS_DEFAULT,
    };
    this.quota = new GoogleQuota(db, () => this.now());
  }

  /** Часы (подменяются в тестах). */
  now: () => Date = () => new Date();

  /** Публичный адрес api без завершающего «/» (ссылки на прокси и обложки). */
  get apiBaseUrl(): string {
    return (this.cfg.apiBaseUrl ?? "").replace(/\/+$/, "");
  }

  /** Фото Google в карточке только при ключе: без него прокси не сможет получить новые адреса. */
  get enabled(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  /**
   * Ссылка карточки на прокси фото: GET /places/{id}/google-photos/{n}?regionId=…&w=…&v=…. v — отпечаток имени фото:
   * после обновления обогащения n-е фото может стать другим, и кэш браузера не покажет его с чужим автором.
   */
  proxyUrl(
    regionId: string,
    placeId: string,
    index: number,
    width: GooglePhotoWidth,
    photoName: string,
  ): string {
    const base = (this.cfg.apiBaseUrl ?? "").replace(/\/+$/, "");
    const v = createHash("sha256").update(photoName).digest("hex").slice(0, 8);
    return `${base}/places/${placeId}/google-photos/${index}?regionId=${regionId}&w=${width}&v=${v}`;
  }

  /** Адрес файла фото у Google или null (нет ключа, предел на сутки, ошибка Google, недопустимый ответ). */
  async uri(photoName: string, width: GooglePhotoWidth): Promise<string | null> {
    if (!PHOTO_NAME.test(photoName) || !GOOGLE_PHOTO_WIDTHS.includes(width)) return null;
    const key = `${photoName}|${width}`;
    const now = this.now().getTime();
    const hit = this.memory.get(key);
    if (hit && hit.expires > now) return hit.uri;
    const failedUntil = this.failures.get(key);
    if (failedUntil !== undefined) {
      if (failedUntil > now) return null;
      this.failures.delete(key);
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.resolve(photoName, width, now).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private remember(key: string, uri: string, fetchedAt: number): void {
    if (this.memory.size >= MEMORY_MAX) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(key, { uri, expires: fetchedAt + this.cfg.ttlHours * 3600_000 });
  }

  private async resolve(photoName: string, width: GooglePhotoWidth, now: number): Promise<string | null> {
    const key = `${photoName}|${width}`;
    const fresh = new Date(now - this.cfg.ttlHours * 3600_000);
    const row = await this.db
      .selectFrom("google_photo_uris")
      .select(["photo_uri", "fetched_at"])
      .where("photo_name", "=", photoName)
      .where("max_width", "=", width)
      .where("fetched_at", ">", fresh)
      .executeTakeFirst();
    if (row && isAllowedPhotoUrl(row.photo_uri)) {
      this.remember(key, row.photo_uri, row.fetched_at.getTime());
      return row.photo_uri;
    }
    const uri = await this.fetchFromGoogle(photoName, width, now);
    if (uri === "limit") return null;
    if (!uri) {
      if (this.failures.size >= MEMORY_MAX) this.failures.clear();
      this.failures.set(key, now + GOOGLE_PHOTO_FAILURE_TTL_MS);
      return null;
    }
    this.remember(key, uri, now);
    try {
      await this.db
        .insertInto("google_photo_uris")
        .values({ photo_name: photoName, max_width: width, photo_uri: uri, fetched_at: new Date(now) })
        .onConflict((oc) =>
          oc
            .columns(["photo_name", "max_width"])
            .doUpdateSet({ photo_uri: uri, fetched_at: sql`excluded.fetched_at` }),
        )
        .execute();
    } catch (err) {
      // Кэш в БД — оптимизация: не записался — адрес всё равно отдаётся (и остаётся в памяти).
      this.log.warn(`Кэш фото Google не записан: ${err instanceof Error ? err.message : "ошибка"}`);
    }
    return uri;
  }

  /** Занять запрос Place Photos: суточный и месячный предел (общий с CLI places:enrich --covers). */
  takeDailyQuota(): Promise<boolean> {
    return this.quota.take("place_photos", { daily: this.cfg.dailyLimit, monthly: this.cfg.monthlyLimit });
  }

  /**
   * Предел запросов фото на сегодня/месяц исчерпан: карточка не отдаёт галерею Google (только обложку). Проверка
   * кэшируется на минуту — не лишний запрос к БД на каждую карточку.
   */
  async exhausted(): Promise<boolean> {
    const now = this.now().getTime();
    if (this.exhaustedCache && this.exhaustedCache.until > now) return this.exhaustedCache.value;
    let value = true;
    try {
      const u = await this.quota.used("place_photos");
      value = u.today >= this.cfg.dailyLimit || u.month >= this.cfg.monthlyLimit;
    } catch (err) {
      this.log.warn(`Учёт запросов Google недоступен: ${err instanceof Error ? err.message : "ошибка"}`);
      value = true;
    }
    this.exhaustedCache = { value, until: now + 60_000 };
    return value;
  }

  /** Адрес файла у Google; "limit" — предел на сутки (не ошибка фото); null — ошибка Google/ответа. */
  private async fetchFromGoogle(
    photoName: string,
    width: number,
    now: number,
  ): Promise<string | null | "limit"> {
    const apiKey = this.cfg.apiKey;
    if (!apiKey) return "limit";
    if (!(await this.takeDailyQuota())) {
      this.exhaustedCache = { value: true, until: now + 60_000 };
      this.log.warn("Предел запросов фото Google (сутки/месяц) исчерпан");
      return "limit";
    }
    try {
      const res = await (this.cfg.fetch ?? fetch)(
        `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${width}&skipHttpRedirect=true`,
        { headers: { "X-Goog-Api-Key": apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!res.ok) {
        await res.body?.cancel();
        this.log.warn(`Google Place Photos: HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { photoUri?: unknown };
      return typeof data.photoUri === "string" && isAllowedPhotoUrl(data.photoUri) ? data.photoUri : null;
    } catch (err) {
      this.log.warn(`Google Place Photos: ${err instanceof Error ? err.name : "ошибка"}`);
      return null;
    }
  }
}

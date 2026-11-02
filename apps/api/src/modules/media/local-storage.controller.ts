import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Controller, Get, HttpCode, Inject, Logger, Param, Put, Query, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import {
  isValidStorageKey,
  LOCAL_STORAGE_ROUTE,
  LocalStorageDriver,
  LocalObjectExistsError,
  LocalUploadSizeError,
  type Storage,
} from "@tg/media";
import type { Readable, Writable } from "node:stream";
import { ApiError } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { RateLimit, SkipRateLimit } from "../rate-limit/index.js";
import { MEDIA_STORAGE } from "./media.service.js";

/**
 * Ссылки local-драйвера (T1-20, ADR-0013): аналог подписанных URL S3 на самом api. Доступ — только по подписи
 * HMAC (без сессии): нет подписи, чужая или просроченная — 403. Ключ — один сегмент пути (слэши закодированы).
 * Отдача — с запретом исполнения (CSP sandbox, nosniff): файлы идут с origin api.
 */
/** Структурные типы Express (без @types/express): тело запроса — поток, ответ — поток с заголовками. */
type StreamRequest = Readable & { headers: Record<string, string | string[] | undefined> };
type StreamResponse = Writable & {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
};

/** Лимит загрузок по подписанным ссылкам local: 30 PUT в минуту с IP. */
export const LOCAL_PUT_RATE_LIMIT = { limit: 30, windowSec: 60 } as const;

@ApiExcludeController()
@Controller(LOCAL_STORAGE_ROUTE)
@WithoutTenantContext()
export class LocalStorageController {
  private readonly driver: LocalStorageDriver;
  private readonly logger = new Logger("LocalStorage");

  // Подключается только при STORAGE_DRIVER=local (MediaModule.forRoot).
  constructor(@Inject(MEDIA_STORAGE) storage: Storage) {
    if (!(storage.driver instanceof LocalStorageDriver))
      throw new Error("LocalStorageController подключается только с драйвером local");
    this.driver = storage.driver;
  }

  /**
   * Загрузка: свой лимит на IP × маршрут (тело до 10 МиБ на free-инстансе); общий лимит на IP тоже действует.
   * Ссылку выдаёт только POST /media/uploads под сессией и его лимитами — подпись уже ограничивает число загрузок.
   */
  @Put(":key")
  @RateLimit(LOCAL_PUT_RATE_LIMIT)
  @HttpCode(200)
  async put(
    @Param("key") key: string,
    @Query() query: Record<string, unknown>,
    @Req() req: StreamRequest,
  ): Promise<void> {
    const params = this.verify("put", key, query);
    const ct = String(req.headers["content-type"] ?? "")
      .trim()
      .toLowerCase();
    if (ct !== params.ct) throw new ApiError("BAD_REQUEST", { details: { reason: "content_type_mismatch" } });
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) !== params.len)
      throw new ApiError("BAD_REQUEST", { status: 413, details: { reason: "size_mismatch" } });
    try {
      await this.driver.writeStream(key, req, params.len);
    } catch (e) {
      // Повторный PUT по живой ссылке не перезаписывает загруженное (проверка при подтверждении идёт по копии).
      if (e instanceof LocalObjectExistsError)
        throw new ApiError("CONFLICT", { details: { reason: "already_uploaded" }, cause: e });
      if (e instanceof LocalUploadSizeError)
        throw new ApiError("BAD_REQUEST", { status: 413, details: { reason: "size_mismatch" }, cause: e });
      throw e;
    }
  }

  /**
   * Отдача без rate limit: доступ решает подпись (короткий срок), а страница каталога грузит десятки превью с одного
   * IP (NAT отеля) — общий лимит на IP отсекал бы картинки. Только local-драйвер (staging); в prod — s3/CDN.
   */
  @Get(":key")
  @SkipRateLimit()
  async get(
    @Param("key") key: string,
    @Query() query: Record<string, unknown>,
    @Res() res: StreamResponse,
  ): Promise<void> {
    const params = this.verify("get", key, query);
    const size = await this.driver.size(key);
    if (size === null) throw new ApiError("NOT_FOUND");
    const maxAge = Math.max(0, params.exp - Math.floor(Date.now() / 1000));
    res.status(200);
    res.setHeader("Content-Type", params.ct);
    res.setHeader("Content-Length", String(size));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", params.dl ? "private, no-store" : `private, max-age=${maxAge}`);
    if (params.dl) res.setHeader("Content-Disposition", "attachment");
    try {
      await pipeline(createReadStream(this.driver.path(key)), res);
    } catch (err) {
      // Заголовки уже ушли: ответ ошибкой невозможен — обрыв соединения (клиент ушёл или файл исчез на ходу).
      this.logger.debug(`Отдача ${key} прервана: ${(err as Error).message}`);
      res.destroy();
    }
  }

  private verify(op: "put" | "get", key: string, query: Record<string, unknown>) {
    if (!isValidStorageKey(key)) throw new ApiError("NOT_FOUND");
    const r = this.driver.verify(op, key, query);
    if (!r.ok) throw new ApiError("FORBIDDEN", { details: { reason: r.reason } });
    return r.params;
  }
}

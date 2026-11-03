import { UnrecoverableError } from "bullmq";
import {
  toAnalyticsEventRow,
  type AnalyticsEventRow,
  type BookingsDueProcessor,
  type JobContext,
  type JobName,
  type JobPayloads,
} from "@tg/queue-contract";
import {
  ImageRejectError,
  processImage,
  type MediaRejectReason,
  type StorageDriver,
  type StoredVariants,
} from "@tg/media";
import { analyticsEventSchema, describeAnalyticsIssues } from "@tg/shared";

/** Минимальный логгер обработчика (совместим с Nest Logger и console). */
export interface JobLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Что обработчик знает о выполнении, кроме payload. */
export interface HandlerContext {
  readonly context: JobContext;
  readonly jobId: string;
  /** Номер текущей попытки, с 1. */
  readonly attempt: number;
  readonly logger: JobLogger;
}

/**
 * Обработчик задачи. Правило идемпотентности: доставка «как минимум один раз» — обработчик может
 * быть вызван повторно для той же задачи (ретрай после ошибки, зависшая задача после падения процесса).
 * Поэтому эффект привязывается к стабильному ключу (id сущности / ключ идемпотентности) и проверяется
 * перед применением: upsert, уникальный ключ, условие по состоянию (`WHERE status = 'pending'`),
 * внешние вызовы — с тем же ключом идемпотентности. Ошибка → throw (ретрай); заведомо безнадёжная
 * ошибка → UnrecoverableError из bullmq (сразу в dead-letter, без ретраев).
 */
export type JobHandler<N extends JobName> = (
  payload: JobPayloads[N],
  ctx: HandlerContext,
) => Promise<unknown>;

/** Обработчик для каждой задачи контракта — пропуск ловит typecheck. */
export type JobHandlers = { [N in JobName]: JobHandler<N> };

/** Очистка ПДн аудита с истёкшим сроком (функция БД audit_purge_expired_pii, миграция api 0004). */
export interface AuditPiiPurger {
  /** Удаляет истёкшие строки пачками; возвращает общее число удалённых. */
  purgeExpired(): Promise<number>;
}

/** Запись события в analytics_events (функция БД analytics_record_event, миграция api 0007). */
export interface AnalyticsWriter {
  /** true — строка вставлена, false — событие с этим id уже записано (повтор доставки). */
  record(row: AnalyticsEventRow): Promise<boolean>;
}

/** Обезличивание заявок гостиницы старше срока хранения (функция БД service_requests_anonymize_expired, 0015). */
export interface ServiceRequestsAnonymizer {
  /** Обезличивает закрытые заявки старше срока; возвращает их число. */
  anonymizeExpired(): Promise<number>;
}

export type { BookingsDueProcessor, BookingsDueResult } from "@tg/queue-contract";

/** Очистка dead-letter от записей с истёкшим сроком хранения (dead-letter.ts, DEAD_LETTER_RETENTION_MS). */
export interface DeadLetterPurger {
  /** Удаляет истёкшие записи; возвращает их число. */
  purgeExpired(): Promise<number>;
}

/** Строка media_assets, взятая в обработку (функция БД media_asset_claim_processing, миграция api 0009). */
export interface ClaimedMediaAsset {
  status: string;
  kind: string;
  regionId: string;
  originalKey: string;
  /** Заявленный тип (проверен по сигнатуре при подтверждении): формат декодера обязан совпасть. */
  mime: string;
}

/** Состояние файлов для ресайза — только функции БД из миграции api 0009 (как запись событий). */
export interface MediaAssetStore {
  /** uploaded/processing → processing; возвращает текущее состояние; нет строки — null. */
  claim(id: string): Promise<ClaimedMediaAsset | null>;
  /** processing → ready с вариантами; false — уже не processing. */
  complete(id: string, width: number, height: number, variants: StoredVariants): Promise<boolean>;
  /** → rejected; false — уже ready/rejected. */
  reject(id: string, reason: MediaRejectReason): Promise<boolean>;
}

/** Ресайз фото: строка в БД и объектное хранилище. */
export interface MediaDeps {
  readonly assets: MediaAssetStore;
  readonly storage: StorageDriver;
}

/** Внешние зависимости обработчиков; без зависимости задача, которой она нужна, падает без ретраев. */
export interface HandlerDeps {
  readonly auditPii?: AuditPiiPurger;
  readonly analytics?: AnalyticsWriter;
  readonly deadLetter?: DeadLetterPurger;
  readonly media?: MediaDeps;
  readonly serviceRequests?: ServiceRequestsAnonymizer;
  readonly bookings?: BookingsDueProcessor;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Коды PostgreSQL, повтор при которых даст ту же ошибку: данные задачи не подходят к БД, а не сбой связи/нагрузки.
 * 23503 — FK (несуществующий регион), 23514 — CHECK, 23502 — NOT NULL, 22P02 — неверный текст для типа (uuid),
 * 22007/22008 — дата/время, 22023 — неверный параметр (analytics_record_event: не объект).
 */
export const PERMANENT_DB_ERROR_CODES: ReadonlySet<string> = new Set([
  "23503",
  "23514",
  "23502",
  "22P02",
  "22007",
  "22008",
  "22023",
]);

/** Постоянная ошибка БД → UnrecoverableError (код и ограничение, без значений: в detail может оказаться ПДн). */
export function unrecoverableIfPermanentDbError(err: unknown): unknown {
  const { code, constraint } = (err ?? {}) as { code?: unknown; constraint?: unknown };
  if (typeof code !== "string" || !PERMANENT_DB_ERROR_CODES.has(code)) return err;
  return new UnrecoverableError(
    `постоянная ошибка БД ${code}${typeof constraint === "string" ? ` (${constraint})` : ""}`,
  );
}

/**
 * Рабочие обработчики. Тестовые задачи без побочных эффектов; очистка ПДн удаляет только истёкшие строки —
 * повтор безопасен.
 */
export function createHandlers(deps: HandlerDeps = {}): JobHandlers {
  return {
    "system.ping": async (payload, { context }) => ({
      pong: true,
      message: payload.message ?? null,
      regionId: context.regionId,
    }),
    "system.heartbeat": async (_payload, { logger, jobId }) => {
      const at = new Date().toISOString();
      logger.log(`heartbeat ${jobId} at ${at}`);
      return { at };
    },
    "service-requests.anonymize-expired": async (_payload, { logger }) => {
      if (!deps.serviceRequests)
        throw new UnrecoverableError("Обезличивание заявок: у воркера нет подключения к БД (DATABASE_URL)");
      const anonymized = await deps.serviceRequests.anonymizeExpired();
      logger.log(`Заявки гостиницы: обезличено по сроку хранения — ${anonymized}`);
      return { anonymized };
    },
    // Повтор безопасен: функции БД берут только брони с наступившим сроком в текущем статусе (SKIP LOCKED).
    "bookings.process-due": async (_payload, { logger }) => {
      if (!deps.bookings)
        throw new UnrecoverableError("Сроки броней: у воркера нет подключения к БД (DATABASE_URL)");
      const result = await deps.bookings.processDue();
      const n = result.notifications;
      if (
        result.expired > 0 ||
        result.completed > 0 ||
        result.reminded > 0 ||
        n.sent + n.failed + n.skipped > 0
      )
        logger.log(
          `Брони: истекло по сроку — ${result.expired}, автозавершено — ${result.completed}, напоминаний — ` +
            `${result.reminded}; уведомления: отправлено ${n.sent}, ошибок ${n.failed}, пропущено ${n.skipped}`,
        );
      if (n.failed > 0)
        logger.warn(`Брони: не отправлено уведомлений — ${n.failed} (строки notifications failed)`);
      return result;
    },
    "audit.purge-expired-pii": async (_payload, { logger }) => {
      if (!deps.auditPii)
        throw new UnrecoverableError("Очистка ПДн аудита: у воркера нет подключения к БД (DATABASE_URL)");
      const deleted = await deps.auditPii.purgeExpired();
      logger.log(`ПДн аудита: удалено истёкших строк — ${deleted}`);
      return { deleted };
    },
    // Событие из Redis проверяется повторно: продюсер мог быть другой версии. Невалидное — в лог (без значений,
    // только пути и коды ошибок: в значениях может оказаться ПДн) и сразу в dead-letter. Повтор — no-op по id.
    // Регион контекста задачи обязан совпадать с regionId события (иначе задача поставлена не тем продюсером).
    // Постоянные ошибки БД (несуществующий регион и т. п.) — сразу в dead-letter, без 5 ретраев.
    "analytics.record": async (payload, { logger, jobId, context }) => {
      const parsed = analyticsEventSchema.safeParse(payload?.event);
      if (!parsed.success) {
        const reason = `событие отклонено схемой: ${describeAnalyticsIssues(parsed.error.issues)}`;
        logger.warn(`analytics.record ${jobId}: ${reason}`);
        throw new UnrecoverableError(reason);
      }
      if ((context.regionId?.toLowerCase() ?? null) !== (parsed.data.regionId?.toLowerCase() ?? null)) {
        const reason = "регион контекста задачи не совпадает с regionId события";
        logger.warn(`analytics.record ${jobId}: ${reason}`);
        throw new UnrecoverableError(reason);
      }
      if (!deps.analytics)
        throw new UnrecoverableError("Запись событий: у воркера нет подключения к БД (DATABASE_URL)");
      try {
        const inserted = await deps.analytics.record(toAnalyticsEventRow(parsed.data));
        return { eventId: parsed.data.eventId, inserted };
      } catch (err) {
        const mapped = unrecoverableIfPermanentDbError(err);
        if (mapped !== err) logger.warn(`analytics.record ${jobId}: ${(mapped as Error).message}`);
        throw mapped;
      }
    },
    // Ресайз фото (T1-20, ADR-0013). Идемпотентность — по статусу строки: claim берёт только uploaded/processing,
    // ready/rejected — повтор без эффекта (у ready ещё раз удаляется оригинал: сбой мог случиться между отметкой и
    // удалением); ключи вариантов детерминированы — повторная запись тех же файлов. pending — подтверждение ещё не
    // закоммичено api: обычная ошибка, ретрай. Не изображение, не тот формат (SVG/GIF/TIFF за верной сигнатурой),
    // слишком большое, нет оригинала — rejected с причиной и удаление оригинала, без ретраев.
    "media.process-image": async (payload, { logger, jobId, context }) => {
      const id = payload?.assetId;
      if (typeof id !== "string" || !UUID.test(id))
        throw new UnrecoverableError("media.process-image: некорректный assetId");
      if (!deps.media)
        throw new UnrecoverableError(
          "Ресайз фото: у воркера нет подключения к БД (DATABASE_URL) или хранилища",
        );
      const { assets, storage } = deps.media;
      let row: ClaimedMediaAsset | null;
      try {
        row = await assets.claim(id);
      } catch (err) {
        throw unrecoverableIfPermanentDbError(err);
      }
      if (!row) throw new UnrecoverableError(`media.process-image: файл ${id} не найден`);
      if ((context.regionId?.toLowerCase() ?? null) !== row.regionId.toLowerCase())
        throw new UnrecoverableError("регион контекста задачи не совпадает с регионом файла");
      if (row.status === "pending") throw new Error(`файл ${id} ещё не подтверждён (pending) — повтор позже`);
      if (row.status === "ready") {
        await storage.delete(row.originalKey);
        return { assetId: id, status: "ready", repeated: true };
      }
      if (row.status !== "processing") return { assetId: id, status: row.status, repeated: true };
      let result;
      try {
        result = await processImage(storage, {
          id,
          regionId: row.regionId,
          originalKey: row.originalKey,
          mime: row.mime,
        });
      } catch (err) {
        if (!(err instanceof ImageRejectError)) throw err;
        logger.warn(`media.process-image ${jobId}: отклонено — ${err.reason}`);
        // Оригинал — только если отметка применилась: иначе строку уже отметила другая задача (она и удалит).
        if (await assets.reject(id, err.reason)) await storage.delete(row.originalKey);
        return { assetId: id, status: "rejected" };
      }
      // Оригинал (с EXIF/GPS) после ready не нужен: наружу — только варианты. Удаляется после COMMIT отметки (функция
      // БД — отдельный запрос в автокоммите) и только если отметка применилась: старая задача, чью строку уже
      // отметила новая (перезапуск зависшей), исходник не трогает.
      if (await assets.complete(id, result.width, result.height, result.variants))
        await storage.delete(row.originalKey);
      return { assetId: id, status: "ready", variants: Object.keys(result.variants) };
    },
    "dead-letter.purge-expired": async (_payload, { logger }) => {
      if (!deps.deadLetter)
        throw new UnrecoverableError("Очистка dead-letter: очередь dead-letter не открыта");
      const removed = await deps.deadLetter.purgeExpired();
      logger.log(`dead-letter: удалено записей с истёкшим сроком — ${removed}`);
      return { removed };
    },
  };
}

/** Обработчики без внешних зависимостей (задачи, которым нужна БД, падают без ретраев). */
export const defaultHandlers: JobHandlers = createHandlers();

import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { uuidv7 } from "@tg/media";
import { z } from "@tg/server-config";
import { ANALYTICS_SCHEMA_VERSION, type AnalyticsSource } from "@tg/shared";
import {
  InjectDb,
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
  type EntryType,
  type LocalizedText,
  type QrPointType,
  type QrScanResult,
} from "../../db/index.js";
import { AnalyticsService } from "../analytics/index.js";
import { QrContextRepository, type ContextRegion, type ResolvedQrPoint } from "./qr-context.repository.js";
import { checkStartParam } from "./start-param.js";

/**
 * Код региона нейтрального контекста (seed: «Тестовий регіон»). Нет такого активного — самый ранний активный регион
 * (пилотный регион D-01 появится в блоке 3 — тогда код станет настройкой).
 */
export const DEFAULT_CONTEXT_REGION_CODE = "test-region";

/**
 * anonymousId — та же проверка, что у конверта аналитики (@tg/shared, z.uuid() zod 4: версия 1–8 и вариант RFC):
 * uuid, принятый здесь, примут и qr_scanned, и последующие POST /analytics/events.
 */
const anonymousIdSchema = z.uuid();

export type QrContextInput = {
  /** Параметр из пути как пришёл (ещё не проверен). */
  startParam: string;
  /** Пользователь сессии, если запрос с Bearer-токеном. */
  userId?: string;
  /** Анонимное устройство от клиента (query anonymousId); не uuid — игнорируется. */
  anonymousId?: string;
};

/** Карточка «Про заклад» для QR отеля (venue_* точки; Place — с блока 3). */
export type QrVenue = {
  name: LocalizedText;
  description: LocalizedText | null;
  address: LocalizedText | null;
  phone: string | null;
  website: string | null;
  telegram: string | null;
};

export type QrContextResult = {
  status: QrScanResult;
  entryType: EntryType;
  region: ContextRegion | null;
  /** Только при ok: неактивная точка не подставляется (S-01, «чужая точка не подставляется»). */
  point: { id: string; type: QrPointType; placeId: string | null; campaign: string | null } | null;
  venue: QrVenue | null;
  entryContextId: string | null;
  /** Анонимный id устройства: присланный клиентом или новый — клиент хранит его и шлёт в аналитике. */
  anonymousId: string;
};

type Resolution = { status: QrScanResult; point: ResolvedQrPoint | undefined };

function resolution(
  check: ReturnType<typeof checkStartParam>,
  point: ResolvedQrPoint | undefined,
): Resolution {
  if (!check.valid) return { status: "invalid", point: undefined };
  if (!point) return { status: "not_found", point: undefined };
  return { status: point.active && point.region_status === "active" ? "ok" : "inactive", point };
}

function venueOf(point: ResolvedQrPoint): QrVenue | null {
  if (point.type !== "hotel" || !point.venue_name_i18n) return null;
  return {
    name: point.venue_name_i18n,
    description: point.venue_description_i18n,
    address: point.venue_address_i18n,
    phone: point.venue_phone,
    website: point.venue_website,
    telegram: point.venue_telegram,
  };
}

/**
 * QR-контекст входа (блок 2, S-01; ADR-0016): start_param → точка → регион и объект. Любое открытие пишет
 * QRScanEvent и AttributionTouch (D-29 — все касания), при известном регионе — EntryContext; затем событие
 * qr_scanned. Невалидный, неизвестный и неактивный параметр — нейтральный контекст региона, не ошибка.
 */
@Injectable()
export class QrContextService {
  private readonly logger = new Logger("QrContext");

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(QrContextRepository) private readonly repo: QrContextRepository,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}

  async resolve(input: QrContextInput): Promise<QrContextResult> {
    const check = checkStartParam(input.startParam);
    const anonymousId =
      input.anonymousId !== undefined && anonymousIdSchema.safeParse(input.anonymousId).success
        ? input.anonymousId.toLowerCase()
        : randomUUID();
    const userId = input.userId ?? null;

    // Одна транзакция SYSTEM: поиск по коду кросс-tenant, регион записей — из найденной точки или регион по
    // умолчанию (на сервере, не от клиента); составные FK не дают связать точку с журналом другого региона.
    const result = await withTenant(this.db, SYSTEM_CONTEXT, async () => {
      const { status, point } = resolution(
        check,
        check.valid ? await this.repo.findPointByCode(check.code) : undefined,
      );
      const ok = status === "ok" && point !== undefined;
      // Нейтральный контекст неактивной точки — её регион, если он активен; иначе — регион по умолчанию.
      const region =
        (point && point.region_status === "active"
          ? await this.repo.findRegion(point.region_id)
          : undefined) ?? (await this.repo.findDefaultRegion(DEFAULT_CONTEXT_REGION_CODE));
      // Журнал — в регионе точки (если найдена), иначе в регионе контекста.
      const journalRegionId = point?.region_id ?? region?.id ?? null;
      const scan = await this.repo.insertScanEvent({
        region_id: journalRegionId,
        qr_point_id: point?.id ?? null,
        raw_start_param: check.valid ? check.code : null,
        result: status,
        user_id: userId,
        anonymous_id: anonymousId,
      });
      const entryType: EntryType = ok ? point.type : "default";
      const entry = region
        ? await this.repo.insertEntryContext({
            region_id: region.id,
            qr_point_id: ok ? point.id : null,
            place_id: ok ? point.place_id : null,
            entry_type: entryType,
            source: "qr" satisfies AnalyticsSource,
            qr_scan_event_id: scan.id,
            user_id: userId,
            anonymous_id: anonymousId,
          })
        : undefined;
      await this.repo.insertAttributionTouch({
        region_id: journalRegionId,
        user_id: userId,
        anonymous_id: anonymousId,
        source: "qr" satisfies AnalyticsSource,
        qr_point_id: point?.id ?? null,
        campaign: ok ? point.campaign : null,
        qr_scan_event_id: scan.id,
        entry_context_id: entry?.id ?? null,
      });
      return {
        status,
        entryType,
        region: region ?? null,
        point: ok
          ? { id: point.id, type: point.type, placeId: point.place_id, campaign: point.campaign }
          : null,
        venue: ok ? venueOf(point) : null,
        entryContextId: entry?.id ?? null,
        anonymousId,
        qrPointId: point?.id,
      };
    });

    const { qrPointId, ...response } = result;
    await this.emitScanned(response, qrPointId);
    return response;
  }

  /** qr_scanned (ТЗ §15.1) после фиксации журнала; сбой аналитики не ломает вход — предупреждение в лог. */
  private async emitScanned(ctx: QrContextResult, qrPointId: string | undefined): Promise<void> {
    try {
      await this.analytics.emit({
        eventId: uuidv7(),
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        occurredAt: new Date().toISOString(),
        anonymousId: ctx.anonymousId,
        regionId: ctx.region?.id ?? null,
        source: "qr",
        entryContextId: ctx.entryContextId,
        placeId: ctx.point?.placeId ?? null,
        event: "qr_scanned",
        props: { ...(qrPointId ? { qrPointId } : {}), result: ctx.status },
      });
    } catch (err) {
      this.logger.warn(`qr_scanned не записано: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  type AttributionTouch,
  type Db,
  type EntryContext,
  type NewAttributionTouch,
  type NewEntryContext,
  type NewQrScanEvent,
  type QrPoint,
  type QrScanEvent,
  type Region,
} from "../../db/index.js";

/** Регион контекста — только то, что нужно экрану C01 (без служебных полей). */
export type ContextRegion = Pick<
  Region,
  "id" | "code" | "name_i18n" | "status" | "timezone" | "default_language"
>;

/** Точка вместе со статусом её региона (неактивный регион = точка не действует). */
export type ResolvedQrPoint = QrPoint & { region_status: Region["status"] };

/**
 * Данные QR-контекста (миграция 0011, ADR-0016). Поиск точки по коду кросс-tenant (код уникален в платформе,
 * регион ещё не известен), поэтому сервис вызывает репозиторий в withTenant(SYSTEM) — как аудит и seed; регион
 * берётся из найденной точки на сервере, клиент его не передаёт.
 */
@Injectable()
export class QrContextRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  findPointByCode(code: string): Promise<ResolvedQrPoint | undefined> {
    return currentDb(this.db)
      .selectFrom("qr_points")
      .innerJoin("regions", "regions.id", "qr_points.region_id")
      .selectAll("qr_points")
      .select("regions.status as region_status")
      .where("qr_points.code", "=", code)
      .executeTakeFirst();
  }

  findRegion(id: string): Promise<ContextRegion | undefined> {
    return this.regionQuery().where("id", "=", id).executeTakeFirst();
  }

  /**
   * Регион нейтрального контекста: активный регион с кодом preferredCode, иначе самый ранний активный (один
   * пилотный регион — D-01), иначе undefined.
   */
  async findDefaultRegion(preferredCode: string): Promise<ContextRegion | undefined> {
    const preferred = await this.regionQuery()
      .where("code", "=", preferredCode)
      .where("status", "=", "active")
      .executeTakeFirst();
    return (
      preferred ??
      this.regionQuery()
        .where("status", "=", "active")
        .orderBy("created_at")
        .orderBy("id")
        .limit(1)
        .executeTakeFirst()
    );
  }

  insertScanEvent(row: NewQrScanEvent): Promise<QrScanEvent> {
    return currentDb(this.db)
      .insertInto("qr_scan_events")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertEntryContext(row: NewEntryContext): Promise<EntryContext> {
    return currentDb(this.db)
      .insertInto("entry_contexts")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertAttributionTouch(row: NewAttributionTouch): Promise<AttributionTouch> {
    return currentDb(this.db)
      .insertInto("attribution_touches")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private regionQuery() {
    return currentDb(this.db)
      .selectFrom("regions")
      .select(["id", "code", "name_i18n", "status", "timezone", "default_language"]);
  }
}

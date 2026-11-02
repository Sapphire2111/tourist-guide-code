import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  type Db,
  type NewQrPoint,
  type QrPoint,
  type QrPointType,
  type QrPointUpdate,
} from "../../db/index.js";

export type QrPointFilter = { type?: QrPointType; active?: boolean; campaign?: string };

/**
 * QR-точки для админки (tenant, миграция 0011). Вызывается в транзакции запроса (TenantContextInterceptor):
 * в контексте региона TenantGuardPlugin добавляет `region_id = :регион` в каждый запрос (чужая точка — не найдена),
 * в INSERT подставляет регион; второй рубеж — RLS. PLATFORM (SUPERADMIN без выбранного региона) видит все регионы.
 */
@Injectable()
export class QrPointsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Страница от новых к старым по id (uuidv7), курсор — id последней записи. */
  list(filter: QrPointFilter, page: { limit: number; beforeId?: string }): Promise<QrPoint[]> {
    let q = currentDb(this.db).selectFrom("qr_points").selectAll();
    if (filter.type !== undefined) q = q.where("type", "=", filter.type);
    if (filter.active !== undefined) q = q.where("active", "=", filter.active);
    if (filter.campaign !== undefined) q = q.where("campaign", "=", filter.campaign);
    if (page.beforeId !== undefined) q = q.where("id", "<", page.beforeId);
    return q.orderBy("id", "desc").limit(page.limit).execute();
  }

  findById(id: string): Promise<QrPoint | undefined> {
    return currentDb(this.db).selectFrom("qr_points").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /**
   * Вставка; занятый код (уникален во всей платформе, в том числе в чужом регионе) — undefined без ошибки
   * (ON CONFLICT DO NOTHING не прерывает транзакцию запроса): вызывающий генерирует новый код.
   */
  insertIfCodeFree(row: NewQrPoint): Promise<QrPoint | undefined> {
    return currentDb(this.db)
      .insertInto("qr_points")
      .values(row)
      .onConflict((oc) => oc.column("code").doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  update(id: string, patch: QrPointUpdate): Promise<QrPoint | undefined> {
    return currentDb(this.db)
      .updateTable("qr_points")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }
}

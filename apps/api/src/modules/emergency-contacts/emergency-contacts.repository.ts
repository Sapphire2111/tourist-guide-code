import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  type Db,
  type EmergencyContact,
  type EmergencyContactKind,
  type EmergencyContactUpdate,
  type NewEmergencyContact,
} from "../../db/index.js";

/** Контактов в регионе — единицы; верхняя граница выдачи на случай ошибки наполнения. */
export const EMERGENCY_CONTACTS_MAX = 200;

export type EmergencyContactFilter = { kind?: EmergencyContactKind; active?: boolean };

/**
 * Экстренные контакты (tenant, миграция 0013). Вызывается в транзакции с tenant-контекстом: в контексте региона
 * TenantGuardPlugin ограничивает каждый запрос регионом (чужой контакт — не найден) и подставляет регион в INSERT;
 * второй рубеж — RLS.
 */
@Injectable()
export class EmergencyContactsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  /** По порядку показа (sort_order, затем id). */
  list(filter: EmergencyContactFilter): Promise<EmergencyContact[]> {
    let q = currentDb(this.db).selectFrom("emergency_contacts").selectAll();
    if (filter.kind !== undefined) q = q.where("kind", "=", filter.kind);
    if (filter.active !== undefined) q = q.where("active", "=", filter.active);
    return q.orderBy("sort_order").orderBy("id").limit(EMERGENCY_CONTACTS_MAX).execute();
  }

  findById(id: string): Promise<EmergencyContact | undefined> {
    return currentDb(this.db)
      .selectFrom("emergency_contacts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
  }

  create(row: NewEmergencyContact): Promise<EmergencyContact> {
    return currentDb(this.db)
      .insertInto("emergency_contacts")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  update(id: string, patch: EmergencyContactUpdate): Promise<EmergencyContact | undefined> {
    return currentDb(this.db)
      .updateTable("emergency_contacts")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  delete(id: string): Promise<EmergencyContact | undefined> {
    return currentDb(this.db)
      .deleteFrom("emergency_contacts")
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }
}

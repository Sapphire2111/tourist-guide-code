import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  InjectDb,
  type Db,
  type PlaceClaim,
  type PlaceClaimPhoneSource,
  type PlaceClaimRole,
  type PlaceClaimStatus,
} from "../../db/index.js";

/** Заявка с названием места, организации и именами заявителя/модератора. */
export type PlaceClaimRow = PlaceClaim & {
  place_name: { uk: string; en?: string };
  organization_name: string | null;
  claimant_name: string | null;
  claimant_username: string | null;
  decided_by_name: string | null;
};

/** Место для проверки заявки модератором. */
export type ClaimPlaceRow = {
  id: string;
  name_i18n: { uk: string; en?: string };
  status: string;
  source: string;
  address_i18n: { uk: string; en?: string } | null;
  phone: string | null;
  website: string | null;
  google_place_id: string | null;
  organization_id: string | null;
  organization_name: string | null;
  category_name: { uk: string; en?: string } | null;
  maps_uri: string | null;
};

/**
 * Данные заявок «Це мій заклад» (0031). Запросы — в транзакции региона (withTenant): RLS и TenantGuardPlugin;
 * функция app_place_claim_region (режим SYSTEM) — регион заявки вне транзакции.
 */
@Injectable()
export class PlaceClaimsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  private get q(): Db {
    return currentDb(this.db);
  }

  async claimRegion(claimId: string): Promise<string | undefined> {
    const row = await this.q
      .selectNoFrom(sql<string | null>`app_place_claim_region(${claimId}::uuid)`.as("region_id"))
      .executeTakeFirst();
    return row?.region_id ?? undefined;
  }

  insert(row: {
    place_id: string;
    user_id: string;
    organization_id: string | null;
    new_organization_name: string | null;
    claimant_role: PlaceClaimRole;
    phone: string;
    phone_source: PlaceClaimPhoneSource;
    comment: string | null;
  }): Promise<PlaceClaim> {
    return this.q.insertInto("place_claims").values(row).returningAll().executeTakeFirstOrThrow();
  }

  find(id: string, lock = false): Promise<PlaceClaim | undefined> {
    let q = this.q.selectFrom("place_claims").selectAll().where("id", "=", id);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** Решение по заявке на рассмотрении; уже решённая — undefined (гонка двух модераторов). */
  decide(
    id: string,
    patch: {
      status: Extract<PlaceClaimStatus, "approved" | "rejected">;
      organization_id?: string;
      decision_comment: string | null;
      decided_by: string;
    },
  ): Promise<PlaceClaim | undefined> {
    return this.q
      .updateTable("place_claims")
      .set({ ...patch, decided_at: new Date() })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
  }

  /** Отклонить остальные заявки места на рассмотрении (одобрена другая); заявители — для уведомления. */
  rejectCompeting(
    placeId: string,
    exceptId: string,
    patch: { decision_comment: string; decided_by: string },
  ): Promise<{ id: string; user_id: string }[]> {
    return this.q
      .updateTable("place_claims")
      .set({ ...patch, status: "rejected", decided_at: new Date() })
      .where("place_id", "=", placeId)
      .where("id", "<>", exceptId)
      .where("status", "=", "pending")
      .returning(["id", "user_id"])
      .execute();
  }

  /** Заявитель отзывает свою заявку на рассмотрении; иначе — undefined. */
  withdraw(id: string, userId: string): Promise<PlaceClaim | undefined> {
    return this.q
      .updateTable("place_claims")
      .set({ status: "withdrawn", withdrawn_at: new Date() })
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
  }

  /** Модератор отменяет одобрение; не одобренная (уже отменена) — undefined. */
  revoke(id: string, patch: { revoked_by: string; revoke_reason: string }): Promise<PlaceClaim | undefined> {
    return this.q
      .updateTable("place_claims")
      .set({ ...patch, status: "revoked", revoked_at: new Date() })
      .where("id", "=", id)
      .where("status", "=", "approved")
      .returningAll()
      .executeTakeFirst();
  }

  /** Снять организацию заявки с места (только если место всё ещё за ней); иначе — undefined. */
  unassignPlace(placeId: string, organizationId: string): Promise<{ id: string } | undefined> {
    return this.q
      .updateTable("places")
      .set({ organization_id: null, partner_template_id: null })
      .where("id", "=", placeId)
      .where("organization_id", "=", organizationId)
      .returning("id")
      .executeTakeFirst();
  }

  /**
   * Данные партнёра на месте после отмены одобрения (иначе они вернулись бы при следующем владельце): акции и прайс
   * (разделы и позиции) — в архив, ресурсы бронирования организации — в архив, фото, загруженные людьми организации,
   * — откреплены от места (сам файл остаётся). Возвращает id изменённого — в аудит.
   */
  async cleanupPartnerData(
    placeId: string,
    organizationId: string,
    memberIds: readonly string[],
  ): Promise<{
    offers: string[];
    priceSections: string[];
    priceItems: string[];
    resources: string[];
    media: string[];
  }> {
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const offers = await this.q
      .updateTable("offers")
      .set({ status: "archived" })
      .where("place_id", "=", placeId)
      .where("status", "<>", "archived")
      .returning("id")
      .execute();
    const priceItems = await this.q
      .updateTable("price_list_items")
      .set((eb) => ({ status: "archived", version: eb("version", "+", 1) }))
      .where("place_id", "=", placeId)
      .where("status", "<>", "archived")
      .returning("id")
      .execute();
    const priceSections = await this.q
      .updateTable("price_list_sections")
      .set((eb) => ({ status: "archived", version: eb("version", "+", 1) }))
      .where("place_id", "=", placeId)
      .where("status", "<>", "archived")
      .returning("id")
      .execute();
    const resources = await this.q
      .updateTable("resources")
      .set({ status: "archived" })
      .where("place_id", "=", placeId)
      .where("organization_id", "=", organizationId)
      .where("status", "<>", "archived")
      .returning("id")
      .execute();
    const media =
      memberIds.length === 0
        ? []
        : await this.q
            .deleteFrom("place_media")
            .where("place_id", "=", placeId)
            .where((eb) =>
              eb(
                "media_asset_id",
                "in",
                eb
                  .selectFrom("media_assets")
                  .select("id")
                  .where("created_by", "in", [...memberIds]),
              ),
            )
            .returning("media_asset_id as id")
            .execute();
    return {
      offers: ids(offers),
      priceSections: ids(priceSections),
      priceItems: ids(priceItems),
      resources: ids(resources),
      media: ids(media),
    };
  }

  /** Сколько мест у организации (любой статус). */
  async placeCount(organizationId: string): Promise<number> {
    const row = await this.q
      .selectFrom("places")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Привязать место без организации; уже с организацией — undefined. */
  assignPlace(
    placeId: string,
    organizationId: string,
    templateId: string | null,
  ): Promise<{ id: string } | undefined> {
    return this.q
      .updateTable("places")
      .set({
        organization_id: organizationId,
        ...(templateId ? { partner_template_id: templateId } : {}),
      })
      .where("id", "=", placeId)
      .where("organization_id", "is", null)
      .returning("id")
      .executeTakeFirst();
  }

  /** Заявки пользователя в регионе (новые сверху): на рассмотрении и решённые не раньше since. */
  mine(userId: string, since: Date): Promise<PlaceClaimRow[]> {
    return this.rows()
      .where("c.user_id", "=", userId)
      .where((eb) => eb.or([eb("c.status", "=", "pending"), eb("c.updated_at", ">=", since)]))
      .orderBy("c.created_at", "desc")
      .limit(50)
      .execute() as Promise<PlaceClaimRow[]>;
  }

  /** Очередь: на рассмотрении — старые сверху; решённые — новые сверху. */
  queue(filter: { statuses: readonly PlaceClaimStatus[]; limit: number }): Promise<PlaceClaimRow[]> {
    const pending = filter.statuses.length === 1 && filter.statuses[0] === "pending";
    return this.rows()
      .where("c.status", "in", [...filter.statuses])
      .orderBy("c.created_at", pending ? "asc" : "desc")
      .orderBy("c.id", pending ? "asc" : "desc")
      .limit(filter.limit)
      .execute() as Promise<PlaceClaimRow[]>;
  }

  row(id: string): Promise<PlaceClaimRow | undefined> {
    return this.rows().where("c.id", "=", id).executeTakeFirst() as Promise<PlaceClaimRow | undefined>;
  }

  /** Другие заявки места (новые сверху). */
  ofPlace(placeId: string, exceptId: string): Promise<PlaceClaimRow[]> {
    return this.rows()
      .where("c.place_id", "=", placeId)
      .where("c.id", "<>", exceptId)
      .orderBy("c.created_at", "desc")
      .limit(20)
      .execute() as Promise<PlaceClaimRow[]>;
  }

  /** Место заявки для модератора: контакты, категория, ссылка Google Maps (обогащение), организация. */
  claimPlace(placeId: string): Promise<ClaimPlaceRow | undefined> {
    return this.q
      .selectFrom("places as p")
      .leftJoin("organizations as o", (j) =>
        j.onRef("o.id", "=", "p.organization_id").onRef("o.region_id", "=", "p.region_id"),
      )
      .leftJoin("categories as cat", "cat.id", "p.category_id")
      .leftJoin("place_enrichments as e", "e.place_id", "p.id")
      .select([
        "p.id",
        "p.name_i18n",
        "p.status",
        "p.source",
        "p.address_i18n",
        "p.phone",
        "p.website",
        "p.google_place_id",
        "p.organization_id",
        "o.name as organization_name",
        "cat.name_i18n as category_name",
        sql<string | null>`e.google ->> 'mapsUri'`.as("maps_uri"),
      ])
      .where("p.id", "=", placeId)
      .executeTakeFirst() as Promise<ClaimPlaceRow | undefined>;
  }

  private rows() {
    return this.q
      .selectFrom("place_claims as c")
      .innerJoin("places as p", (j) =>
        j.onRef("p.id", "=", "c.place_id").onRef("p.region_id", "=", "c.region_id"),
      )
      .leftJoin("organizations as o", (j) =>
        j.onRef("o.id", "=", "c.organization_id").onRef("o.region_id", "=", "c.region_id"),
      )
      .leftJoin("users as u", "u.id", "c.user_id")
      .leftJoin("telegram_accounts as ta", "ta.user_id", "c.user_id")
      .leftJoin("users as du", "du.id", "c.decided_by")
      .leftJoin("admin_credentials as ac", "ac.user_id", "c.decided_by")
      .selectAll("c")
      .select([
        "p.name_i18n as place_name",
        (eb) => eb.fn.coalesce("o.name", "c.new_organization_name").as("organization_name"),
        "u.display_name as claimant_name",
        "ta.username as claimant_username",
        (eb) => eb.fn.coalesce("du.display_name", "ac.login").as("decided_by_name"),
      ]);
  }
}

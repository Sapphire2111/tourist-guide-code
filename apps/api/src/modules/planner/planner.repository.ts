import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  InjectDb,
  lonLatOf,
  type Db,
  type LocalizedText,
  type LonLat,
  type PromotionAdLabel,
  type Scenario,
  type ScenarioItem,
  type ScenarioStatus,
  type UserPlan,
  type UserPlanItemRecord,
} from "../../db/index.js";

// Данные планировщика (миграция 0015, ADR-0020). Вызывается в withTenant(региона): TenantGuardPlugin + RLS.

export type PlanPlaceRow = {
  id: string;
  category_id: string;
  name_i18n: LocalizedText;
  address_i18n: LocalizedText | null;
  location: LonLat | null;
  status: string;
};

export type ScenarioWrite = {
  code: string;
  title_i18n: LocalizedText;
  description_i18n: LocalizedText | null;
  days: number;
  tags: string[];
  is_sponsored: boolean;
  ad_label: PromotionAdLabel | null;
  sort_order: number;
};

export type ScenarioItemWrite = {
  day_no: number;
  position: number;
  place_id: string;
  time_hint: string | null;
  duration_min: number | null;
  note_i18n: LocalizedText | null;
  alternatives: string[];
};

@Injectable()
export class PlannerRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  private get q(): Db {
    return currentDb(this.db);
  }

  // --- сценарии ---

  listScenarios(filter: { status?: ScenarioStatus; tag?: string; days?: number }): Promise<Scenario[]> {
    let q = this.q.selectFrom("scenarios").selectAll();
    if (filter.status) q = q.where("status", "=", filter.status);
    if (filter.tag) q = q.where(sql<boolean>`${filter.tag} = ANY(tags)`);
    if (filter.days !== undefined) q = q.where("days", "=", filter.days);
    return q.orderBy("sort_order").orderBy("code").limit(200).execute();
  }

  findScenario(id: string): Promise<Scenario | undefined> {
    return this.q.selectFrom("scenarios").selectAll().where("id", "=", id).executeTakeFirst();
  }

  items(scenarioIds: readonly string[]): Promise<ScenarioItem[]> {
    if (scenarioIds.length === 0) return Promise.resolve([]);
    return this.q
      .selectFrom("scenario_items")
      .selectAll()
      .where("scenario_id", "in", [...scenarioIds])
      .orderBy("scenario_id")
      .orderBy("day_no")
      .orderBy("position")
      .execute();
  }

  /** Места по id (любой статус — сервис решает, что доступно туристу). */
  places(ids: readonly string[]): Promise<PlanPlaceRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return (
      this.q
        .selectFrom("places")
        .innerJoin("categories", "categories.id", "places.category_id")
        .select(["places.id", "places.category_id", "places.name_i18n", "places.address_i18n"])
        .select((eb) => lonLatOf(eb.ref("places.location")).as("location"))
        // Доступно туристу — как в каталоге гида: опубликовано, точка есть, категория активна.
        .select(
          sql<string>`CASE WHEN places.status = 'published' AND places.location IS NOT NULL AND categories.active
          THEN 'published' ELSE 'unavailable' END`.as("status"),
        )
        .where("places.id", "in", [...new Set(ids)])
        .execute() as Promise<PlanPlaceRow[]>
    );
  }

  createScenario(w: ScenarioWrite, createdBy: string | null): Promise<Scenario> {
    return this.q
      .insertInto("scenarios")
      .values({ ...w, created_by: createdBy })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateScenario(id: string, w: ScenarioWrite): Promise<Scenario | undefined> {
    return this.q
      .updateTable("scenarios")
      .set({ ...w, version: sql<number>`version + 1` })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  setStatus(id: string, status: ScenarioStatus): Promise<Scenario | undefined> {
    return this.q
      .updateTable("scenarios")
      .set({ status })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  async replaceItems(scenarioId: string, items: readonly ScenarioItemWrite[]): Promise<void> {
    await this.q.deleteFrom("scenario_items").where("scenario_id", "=", scenarioId).execute();
    if (items.length)
      await this.q
        .insertInto("scenario_items")
        .values(items.map((i) => ({ ...i, scenario_id: scenarioId })))
        .execute();
  }

  async itemCounts(scenarioIds: readonly string[]): Promise<Map<string, number>> {
    if (scenarioIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("scenario_items")
      .select(["scenario_id", (eb) => eb.fn.countAll<string>().as("n")])
      .where("scenario_id", "in", [...scenarioIds])
      .groupBy("scenario_id")
      .execute();
    return new Map(rows.map((r) => [r.scenario_id, Number(r.n)]));
  }

  // --- планы пользователя ---

  listPlans(userId: string, limit: number): Promise<UserPlan[]> {
    return this.q
      .selectFrom("user_plans")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
  }

  countPlans(userId: string): Promise<number> {
    return this.q
      .selectFrom("user_plans")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.n));
  }

  findPlan(userId: string, id: string, forUpdate = false): Promise<UserPlan | undefined> {
    let q = this.q.selectFrom("user_plans").selectAll().where("id", "=", id).where("user_id", "=", userId);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  createPlan(row: {
    user_id: string;
    scenario_id: string;
    scenario_version: number;
    title_i18n: LocalizedText;
    start_date: string | null;
    items: UserPlanItemRecord[];
  }): Promise<UserPlan> {
    return this.q
      .insertInto("user_plans")
      .values({ ...row, items: JSON.stringify(row.items) })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updatePlan(
    id: string,
    patch: { start_date?: string | null; items?: UserPlanItemRecord[] },
  ): Promise<UserPlan | undefined> {
    return this.q
      .updateTable("user_plans")
      .set({
        ...(patch.start_date !== undefined ? { start_date: patch.start_date } : {}),
        ...(patch.items !== undefined ? { items: JSON.stringify(patch.items) } : {}),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  async deletePlan(userId: string, id: string): Promise<boolean> {
    const r = await this.q
      .deleteFrom("user_plans")
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return r.numDeletedRows > 0n;
  }

  scenarioVersions(ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return Promise.resolve(new Map());
    return this.q
      .selectFrom("scenarios")
      .select(["id", "version"])
      .where("id", "in", [...new Set(ids)])
      .execute()
      .then((rows) => new Map(rows.map((r) => [r.id, r.version])));
  }
}

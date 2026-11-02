// Учёт платных запросов к Google по SKU в БД (google_api_usage, 0018): суточный и месячный предел, общие для api
// (прокси фото) и CLI places:enrich. Бесплатный объём Google — 1000 запросов в месяц на SKU Enterprise: месячный
// предел держит расход в нём. Увеличение атомарное (INSERT … ON CONFLICT DO UPDATE … WHERE count < предел
// RETURNING count): нет строки — предел исчерпан. Ошибка БД — отказ (бюджет важнее данных).
import { sql } from "kysely";
import type { Db } from "../db/index.js";

/** SKU Google, которые считаются: Place Details Enterprise + Atmosphere и Place Photos. */
export type GoogleSku = "place_details" | "place_photos";

/** Бесплатный месячный объём Google на SKU (прейскурант с 03.2025). */
export const GOOGLE_FREE_MONTHLY = 1000;

const dayOf = (now: Date) => now.toISOString().slice(0, 10);
/** Строка месяца: первое число месяца (UTC), вид `<sku>_month`. */
const monthOf = (now: Date) => `${now.toISOString().slice(0, 7)}-01`;

export type QuotaLimits = { daily?: number; monthly: number };

export class GoogleQuota {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Занять один запрос: в пределах месяца (и суток, если задан daily). false — предел или ошибка БД. */
  async take(sku: GoogleSku, limits: QuotaLimits): Promise<boolean> {
    if (limits.monthly <= 0 || (limits.daily !== undefined && limits.daily <= 0)) return false;
    const now = this.now();
    try {
      if (!(await this.inc(monthOf(now), `${sku}_month`, limits.monthly))) return false;
      if (limits.daily !== undefined && !(await this.inc(dayOf(now), sku, limits.daily))) {
        // Сутки исчерпаны — месячный запрос возвращается.
        await this.db
          .updateTable("google_api_usage")
          .set({ count: sql`count - 1` })
          .where("day", "=", monthOf(now))
          .where("kind", "=", `${sku}_month`)
          .where("count", ">", 0)
          .execute();
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async inc(day: string, kind: string, limit: number): Promise<boolean> {
    const row = await this.db
      .insertInto("google_api_usage")
      .values({ day, kind, count: 1 })
      .onConflict((oc) =>
        oc
          .columns(["day", "kind"])
          .doUpdateSet({ count: sql`google_api_usage.count + 1` })
          .where("google_api_usage.count", "<", limit),
      )
      .returning("count")
      .executeTakeFirst();
    return Boolean(row && row.count <= limit);
  }

  /** Использовано в этом месяце и сегодня по SKU. */
  async used(sku: GoogleSku): Promise<{ month: number; today: number }> {
    const now = this.now();
    const rows = await this.db
      .selectFrom("google_api_usage")
      .select(["kind", "count"])
      .where((eb) =>
        eb.or([
          eb.and([eb("day", "=", monthOf(now)), eb("kind", "=", `${sku}_month`)]),
          eb.and([eb("day", "=", dayOf(now)), eb("kind", "=", sku)]),
        ]),
      )
      .execute();
    return {
      month: rows.find((r) => r.kind === `${sku}_month`)?.count ?? 0,
      today: rows.find((r) => r.kind === sku)?.count ?? 0,
    };
  }
}

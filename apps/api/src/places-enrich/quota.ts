// Учёт платных запросов к Google по SKU в БД (google_api_usage, 0018): суточный и месячный предел, общие для api
// (прокси фото) и CLI places:enrich. Бесплатный объём Google — 1000 запросов в месяц на SKU Enterprise: месячный
// предел держит расход в нём. Увеличение атомарное (INSERT … ON CONFLICT DO UPDATE … WHERE count < предел
// RETURNING count): нет строки — предел исчерпан. Ошибка БД — отказ (бюджет важнее данных).
import { sql } from "kysely";
import type { Db } from "../db/index.js";

/** SKU Google, которые считаются: Place Details Enterprise + Atmosphere, Place Photos и Weather (сейчас + по дням). */
export type GoogleSku = "place_details" | "place_photos" | "weather";

/** Бесплатный месячный объём Google на SKU (прейскурант с 03.2025). */
export const GOOGLE_FREE_MONTHLY = 1000;

/** Google сбрасывает бесплатный объём и суточные квоты по тихоокеанскому времени — сутки и месяц считаются в нём. */
export const GOOGLE_QUOTA_TZ = "America/Los_Angeles";
const pacificDate = new Intl.DateTimeFormat("en-US", {
  timeZone: GOOGLE_QUOTA_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
/** Дата YYYY-MM-DD по America/Los_Angeles. */
export const dayOf = (now: Date) => {
  const parts = pacificDate.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};
/** Строка месяца: первое число месяца (America/Los_Angeles), вид `<sku>_month`. */
export const monthOf = (now: Date) => `${dayOf(now).slice(0, 7)}-01`;

export type QuotaLimits = { daily?: number; monthly: number };

export class GoogleQuota {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Занять units запросов (по умолчанию один) разом: в пределах месяца (и суток, если задан daily) — или ни одного.
   * false — предел или ошибка БД.
   */
  async take(sku: GoogleSku, limits: QuotaLimits, units = 1): Promise<boolean> {
    if (!Number.isInteger(units) || units < 1) return false;
    if (limits.monthly < units || (limits.daily !== undefined && limits.daily < units)) return false;
    const now = this.now();
    try {
      if (!(await this.inc(monthOf(now), `${sku}_month`, limits.monthly, units))) return false;
      if (limits.daily !== undefined && !(await this.inc(dayOf(now), sku, limits.daily, units))) {
        // Сутки исчерпаны — месячные запросы возвращаются.
        await this.db
          .updateTable("google_api_usage")
          .set({ count: sql`count - ${units}` })
          .where("day", "=", monthOf(now))
          .where("kind", "=", `${sku}_month`)
          .where("count", ">=", units)
          .execute();
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** +units атомарно, только если не выйдет за предел (units ≤ limit проверено в take). */
  private async inc(day: string, kind: string, limit: number, units: number): Promise<boolean> {
    const row = await this.db
      .insertInto("google_api_usage")
      .values({ day, kind, count: units })
      .onConflict((oc) =>
        oc
          .columns(["day", "kind"])
          .doUpdateSet({ count: sql`google_api_usage.count + ${units}` })
          .where("google_api_usage.count", "<=", limit - units),
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

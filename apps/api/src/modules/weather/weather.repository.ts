import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { InjectDb, lonLatOf, SYSTEM_CONTEXT, withTenant, type Db, type JsonObject } from "../../db/index.js";
import type { WeatherPoint } from "./weather-points.js";
import type { WeatherSource } from "./weather-rules.js";

export type WeatherRow = WeatherPoint & {
  source: WeatherSource | null;
  forecast: JsonObject | null;
  contentHash: string | null;
  fetchedAt: Date | null;
  updatedAt: Date;
};

/**
 * Прогнозы по точкам (weather_forecasts, 0026, global) и точки населённых пунктов (localities kind = settlement во
 * всех активных регионах — чтение в SYSTEM-контексте). Вызывается вне транзакции запроса (outsideTenant).
 */
@Injectable()
export class WeatherRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  async settlementPoints(): Promise<WeatherPoint[]> {
    const rows = await withTenant(this.db, SYSTEM_CONTEXT, (trx) =>
      trx
        .selectFrom("localities")
        .innerJoin("regions", "regions.id", "localities.region_id")
        .select(["localities.id"])
        .select((eb) => lonLatOf(eb.ref("localities.location")).as("location"))
        .where("localities.kind", "=", "settlement")
        .where("localities.active", "=", true)
        .where("regions.status", "=", "active")
        .orderBy("localities.id")
        .execute(),
    );
    return rows.flatMap((r) =>
      r.location
        ? [{ key: `locality:${r.id}`, kind: "settlement" as const, lat: r.location.lat, lng: r.location.lon }]
        : [],
    );
  }

  async list(): Promise<WeatherRow[]> {
    const rows = await this.db.selectFrom("weather_forecasts").selectAll().orderBy("point_key").execute();
    return rows.map((r) => ({
      key: r.point_key,
      kind: r.kind,
      lat: r.lat,
      lng: r.lng,
      source: r.source,
      forecast: r.forecast,
      contentHash: r.content_hash,
      fetchedAt: r.fetched_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Точки: новые заводятся, координаты обновляются; прогноз не трогается. Лишние (пункт удалён) — удаляются. */
  async syncPoints(points: readonly WeatherPoint[]): Promise<void> {
    if (points.length)
      await this.db
        .insertInto("weather_forecasts")
        .values(points.map((p) => ({ point_key: p.key, kind: p.kind, lat: p.lat, lng: p.lng })))
        .onConflict((oc) =>
          oc.column("point_key").doUpdateSet({
            kind: sql`excluded.kind`,
            lat: sql`excluded.lat`,
            lng: sql`excluded.lng`,
          }),
        )
        .execute();
    let del = this.db.deleteFrom("weather_forecasts");
    if (points.length)
      del = del.where(
        "point_key",
        "not in",
        points.map((p) => p.key),
      );
    await del.execute();
  }

  /** Снимок прогноза: fetched_at — всегда, updated_at — только если содержимое (content_hash) изменилось. */
  async saveForecast(
    key: string,
    snap: { source: WeatherSource; forecast: JsonObject; contentHash: string; fetchedAt: Date },
  ): Promise<void> {
    await this.db
      .updateTable("weather_forecasts")
      .set({
        source: snap.source,
        forecast: snap.forecast,
        content_hash: snap.contentHash,
        fetched_at: snap.fetchedAt,
        updated_at: sql`CASE WHEN content_hash IS DISTINCT FROM ${snap.contentHash} THEN now() ELSE updated_at END`,
      })
      .where("point_key", "=", key)
      .execute();
  }
}

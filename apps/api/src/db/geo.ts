// PostGIS-хелперы для Kysely (ADR-006). Хранение — geometry(…, 4326) (долгота/широта WGS 84);
// расстояния и радиусы — через приведение к geography: результат в метрах, по сфероиду WGS 84.
// Для ST_DWithin по колонке нужен индекс по выражению: CREATE INDEX … USING gist ((location::geography)).
import { sql, type Expression, type RawBuilder } from "kysely";

export const SRID = 4326;

/** Значение geometry, как его отдаёт pg (hex EWKB). Брендирован, чтобы не путать с обычной строкой. */
export type Geometry = string & { readonly __geometry: unique symbol };

export type LonLat = { lon: number; lat: number };

/** Точка WGS 84. Порядок PostGIS — (долгота, широта); диапазоны проверяются до запроса. */
export function point({ lon, lat }: LonLat): RawBuilder<Geometry> {
  if (!Number.isFinite(lon) || lon < -180 || lon > 180)
    throw new RangeError(`Долгота вне [-180, 180]: ${lon}`);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError(`Широта вне [-90, 90]: ${lat}`);
  return sql<Geometry>`ST_SetSRID(ST_MakePoint(${lon}::float8, ${lat}::float8), ${sql.lit(SRID)})`;
}

/** Расстояние в метрах между двумя geometry SRID 4326 (ST_Distance по geography, сфероид). */
export function distanceMeters(a: Expression<Geometry>, b: Expression<Geometry>): RawBuilder<number> {
  return sql<number>`ST_Distance((${a})::geography, (${b})::geography)`;
}

/** Не дальше `meters` метров друг от друга (ST_DWithin по geography; использует GiST-индекс по выражению). */
export function withinMeters(
  a: Expression<Geometry>,
  b: Expression<Geometry>,
  meters: number,
): RawBuilder<boolean> {
  if (!Number.isFinite(meters) || meters < 0) throw new RangeError(`Радиус должен быть ≥ 0 м: ${meters}`);
  return sql<boolean>`ST_DWithin((${a})::geography, (${b})::geography, ${meters}::float8)`;
}

/**
 * Долгота и широта точки как jsonb `{ "lon": …, "lat": … }` (NULL, если точки нет) — для чтения geometry-колонки
 * в ответ API без разбора EWKB.
 */
export function lonLatOf(column: Expression<Geometry | null>): RawBuilder<LonLat | null> {
  return sql<LonLat | null>`CASE WHEN ${column} IS NULL THEN NULL ELSE jsonb_build_object('lon', ST_X(${column}), 'lat', ST_Y(${column})) END`;
}

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import { describe, expect, it } from "vitest";
import { distanceMeters, lonLatOf, point, withinMeters, type Geometry } from "./geo.js";

// Kysely без соединения: только компиляция SQL.
const db = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const kyiv = { lon: 30.5234, lat: 50.4501 };
const lviv = { lon: 24.0297, lat: 49.8397 };

describe("geo", () => {
  it("lonLatOf: jsonb {lon, lat} из ST_X/ST_Y, NULL без точки", () => {
    const q = db.selectNoFrom(lonLatOf(point(kyiv)).as("ll")).compile();
    expect(q.sql).toContain("jsonb_build_object('lon', ST_X(");
    expect(q.sql).toMatch(/^select CASE WHEN .* IS NULL THEN NULL ELSE /);
  });

  it("point: ST_MakePoint(долгота, широта) с SRID 4326, значения — параметрами", () => {
    const q = db.selectNoFrom(point(kyiv).as("p")).compile();
    expect(q.sql).toBe('select ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326) as "p"');
    expect(q.parameters).toEqual([30.5234, 50.4501]);
  });

  it("distanceMeters: ST_Distance по geography", () => {
    const q = db.selectNoFrom(distanceMeters(point(kyiv), point(lviv)).as("m")).compile();
    expect(q.sql).toBe(
      "select ST_Distance((ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326))::geography, " +
        '(ST_SetSRID(ST_MakePoint($3::float8, $4::float8), 4326))::geography) as "m"',
    );
    expect(q.parameters).toEqual([30.5234, 50.4501, 24.0297, 49.8397]);
  });

  it("withinMeters: ST_DWithin по geography, работает с колонкой", () => {
    const q = db
      .selectNoFrom(withinMeters(sql.ref<Geometry>("place.location"), point(kyiv), 500).as("near"))
      .compile();
    expect(q.sql).toBe(
      'select ST_DWithin(("place"."location")::geography, ' +
        '(ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326))::geography, $3::float8) as "near"',
    );
    expect(q.parameters).toEqual([30.5234, 50.4501, 500]);
  });

  it.each([
    [{ lon: 181, lat: 0 }, "Долгота"],
    [{ lon: -180.5, lat: 0 }, "Долгота"],
    [{ lon: 0, lat: 90.1 }, "Широта"],
    [{ lon: Number.NaN, lat: 0 }, "Долгота"],
  ])("point отклоняет координаты вне диапазона: %o", (p, word) => {
    expect(() => point(p)).toThrow(word);
  });

  it("withinMeters отклоняет отрицательный радиус", () => {
    expect(() => withinMeters(point(kyiv), point(lviv), -1)).toThrow("Радиус");
  });
});

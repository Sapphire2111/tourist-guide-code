// Unit (без БД): SQL выборок гида (блок 4, ADR-0019) в контексте региона — TenantGuardPlugin добавляет region_id
// ко всем таблицам (в т. ч. к псевдониму раздела и избранному), туристу — только published, расстояние и радиус —
// geography. Результаты на реальной PostGIS — test/integration/guide.test.ts.
import { describe, expect, it } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { regionContext, withTenant } from "../../db/index.js";
import { GuideRepository } from "./guide.repository.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";

async function capture(fn: (repo: GuideRepository) => Promise<unknown>) {
  const { db, queries } = recordingDb({});
  const repo = new GuideRepository(db);
  await withTenant(db, regionContext(A), () => fn(repo));
  // Первые запросы — set_config контекста.
  return queries.map((q) => ({ sql: q.sql, params: q.parameters })).filter((q) => !/set_config/.test(q.sql));
}

describe("GuideRepository (SQL)", () => {
  it("поиск рядом: published, активная категория, ST_DWithin/ST_Distance по geography, регион на обеих таблицах", async () => {
    const [q] = await capture((r) =>
      r.search({
        origin: { lon: 24.5, lat: 48.4 },
        radius: 500,
        categoryId: PLACE,
        text: "ка%ва",
        limit: 20,
        offset: 40,
      }),
    );
    expect(q!.sql).toMatch(/"places"\."status" = \$/);
    expect(q!.sql).toMatch(/"categories"\."active" = \$/);
    expect(q!.sql).toMatch(/ST_DWithin\(\(.*\)::geography/);
    expect(q!.sql).toMatch(/ST_Distance\(\(.*\)::geography/);
    expect(q!.sql).toMatch(/"places"\."region_id" = \$/);
    expect(q!.sql).toMatch(/"categories"\."region_id" = \$/);
    expect(q!.sql).toMatch(/order by CASE .* "distance".*"places"\."recommended" desc/s);
    expect(q!.sql).toMatch(/limit \$\d+ offset \$\d+/);
    expect(q!.params).toContain("published");
    expect(q!.params).toContain("%ка\\%ва%");
    expect(q!.params).toContain(21);
    expect(q!.params).toContain(A);
  });

  it("без точки: нет гео-фильтра, distance — NULL", async () => {
    const [q] = await capture((r) => r.search({ limit: 10, offset: 0 }));
    expect(q!.sql).not.toMatch(/ST_DWithin/);
    expect(q!.sql).toMatch(/NULL::float8 as "distance"/);
  });

  it("категории: подкатегории выключенного раздела отсекаются, регион — и на псевдониме parent", async () => {
    const [q] = await capture((r) => r.activeCategories());
    expect(q!.sql).toMatch(/"parent"\."active" = \$/);
    expect(q!.sql).toMatch(/"parent"\."region_id" = \$/);
  });

  it("избранное: пользователь, published, регион на favorites; вставка — ON CONFLICT DO NOTHING с регионом", async () => {
    const queries = await capture(async (r) => {
      await r.favorites(USER);
      await r.addFavorite(USER, PLACE).catch(() => undefined);
    });
    expect(queries[0]!.sql).toMatch(/"favorites"\."user_id" = \$/);
    expect(queries[0]!.sql).toMatch(/"favorites"\."region_id" = \$/);
    expect(queries[0]!.sql).toMatch(/"places"\."status" = \$/);
    expect(queries[1]!.sql).toMatch(
      /insert into "favorites" .*"region_id".* on conflict \("user_id", "place_id"\) do nothing/s,
    );
    expect(queries[1]!.params).toContain(A);
  });

  it("обложки — DISTINCT ON по месту, только ready", async () => {
    const [q] = await capture((r) => r.covers([PLACE]));
    expect(q!.sql).toMatch(/select distinct on \("place_media"\."place_id"\)/);
    expect(q!.params).toContain("ready");
  });
});

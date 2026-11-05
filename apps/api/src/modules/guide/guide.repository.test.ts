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

  it("фильтр тегов (удобства «Де жити»): каждый код — свой EXISTS по place_tags с активным тегом (И), регион на псевдонимах", async () => {
    const [q] = await capture((r) => r.search({ tagCodes: ["pool", "sauna", "pool"], limit: 10, offset: 0 }));
    expect(q!.sql.match(/exists \(select "ft"\."place_id" from "place_tags" as "ft"/g)).toHaveLength(2);
    expect(q!.sql).toMatch(/"ftag"\."active" = \$/);
    expect(q!.sql).toMatch(/"ft"\."region_id" = \$/);
    expect(q!.sql).toMatch(/"ftag"\."region_id" = \$/);
    expect(q!.params).toEqual(expect.arrayContaining(["pool", "sauna"]));
    const [plain] = await capture((r) => r.search({ limit: 10, offset: 0 }));
    expect(plain!.sql).not.toMatch(/place_tags/);
  });

  it("счётчики тегов: опубликованные места категории, distinct по месту, только активные теги, регион на place_tags и tags", async () => {
    const [q] = await capture((r) =>
      r.tagCounts({
        categoryId: PLACE,
        localityIds: [USER],
        origin: { lon: 24.5, lat: 48.4 },
        radius: 3000,
        text: "віл",
      }),
    );
    // Те же фильтры, что у выдачи: радиус от точки и текст.
    expect(q!.sql).toMatch(/ST_DWithin\(\(.*\)::geography/);
    expect(q!.params).toEqual(expect.arrayContaining([3000, "%віл%"]));
    expect(q!.sql).toMatch(/count\(distinct "places"\."id"\)/);
    expect(q!.sql).toMatch(/inner join "place_tags" as "pt"/);
    expect(q!.sql).toMatch(/"t"\."active" = \$/);
    expect(q!.sql).toMatch(/"pt"\."region_id" = \$/);
    expect(q!.sql).toMatch(/"t"\."region_id" = \$/);
    expect(q!.sql).toMatch(/group by "t"\."id"/);
    expect(q!.params).toEqual(expect.arrayContaining(["published", PLACE, USER]));
  });

  it("исключение разделов («Що поруч» без «Де жити»): только по запросу, корень — по parent_id или сама категория", async () => {
    const [q] = await capture((r) => r.search({ excludeSections: ["stay"], limit: 10, offset: 0 }));
    expect(q!.sql).toMatch(/not exists \(select "root"\."id" from "categories" as "root"/);
    expect(q!.sql).toMatch(/coalesce\("categories"\."parent_id", "categories"\."id"\)/);
    expect(q!.sql).toMatch(/"root"\."region_id" = \$/);
    expect(q!.params).toContain("stay");
    expect(q!.sql).toMatch(/"place_extra_categories" as "x"/);
    expect(q!.sql).toMatch(/"xr"\."region_id" = \$/);
    expect(q!.sql).toMatch(/"xc"\."active" = \$/);
    const [plain] = await capture((r) => r.search({ text: "готель", limit: 10, offset: 0 }));
    expect(plain!.sql).not.toMatch(/not exists/);
  });

  it("категория — основная или дополнительная (place_extra_categories), регион на псевдонимах x и xc", async () => {
    const [q] = await capture((r) => r.search({ categoryId: PLACE, limit: 10, offset: 0 }));
    expect(q!.sql).toMatch(/exists \(select "x"\."place_id" from "place_extra_categories" as "x"/);
    expect(q!.sql).toMatch(/"x"\."region_id" = \$/);
    expect(q!.sql).toMatch(/"xc"\."region_id" = \$/);
    expect(q!.sql).toMatch(/"xc"\."active" = \$/);
  });

  it("счётчики: основная категория активна, доп. — только активная (как в search)", async () => {
    const [own] = await capture((r) => r.publishedCountByCategory());
    expect(own!.sql).toMatch(/"pc0"\."active" = \$/);
    expect(own!.sql).toMatch(/"xpc"\."active" = \$/);
    expect(own!.sql).toMatch(/"xc"\."active" = \$/);
  });

  it("без точки: нет гео-фильтра, distance — NULL", async () => {
    const [q] = await capture((r) => r.search({ limit: 10, offset: 0 }));
    expect(q!.sql).not.toMatch(/ST_DWithin/);
    expect(q!.sql).toMatch(/NULL::float8 as "distance"/);
  });

  it("локации: фильтр locality_id IN (…) вместе с регионом; пустой список — без фильтра", async () => {
    const L1 = "0190f5c2-7d3e-7000-8000-0000000000c1";
    const L2 = "0190f5c2-7d3e-7000-8000-0000000000c2";
    const [q] = await capture((r) => r.search({ localityIds: [L1, L2], limit: 10, offset: 0 }));
    expect(q!.sql).toMatch(/"places"\."locality_id" in \(\$\d+, \$\d+\)/);
    expect(q!.params).toEqual(expect.arrayContaining([L1, L2, A]));
    const [none] = await capture((r) => r.search({ localityIds: [], limit: 10, offset: 0 }));
    expect(none!.sql).not.toMatch(/locality_id/);
  });

  it("населённые пункты: активные settlement, регион; счёт мест — published по locality_id", async () => {
    const [list] = await capture((r) => r.activeLocalities());
    expect(list!.sql).toMatch(/"localities"\."active" = \$/);
    expect(list!.sql).toMatch(/"localities"\."kind" = \$/);
    expect(list!.sql).toMatch(/"localities"\."region_id" = \$/);
    expect(list!.params).toContain("settlement");
    const [count] = await capture((r) => r.publishedCountByLocality());
    expect(count!.sql).toMatch(/group by "places"\."locality_id"/);
    expect(count!.params).toContain("published");
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

describe("GuideRepository — акции партнёра (SQL)", () => {
  it("действующие: status active, окно [starts_at, ends_at] с null-границами, регион, пачкой по местам", async () => {
    const [q] = await capture((r) => r.placeIdsWithOffer([PLACE]));
    expect(q!.sql).toMatch(/select distinct "offers"\."place_id" from "offers"/);
    expect(q!.sql).toMatch(/"offers"\."status" = \$/);
    expect(q!.sql).toMatch(/"offers"\."starts_at" is null or "offers"\."starts_at" <= now\(\)/);
    expect(q!.sql).toMatch(/"offers"\."ends_at" is null or "offers"\."ends_at" >= now\(\)/);
    expect(q!.sql).toMatch(/"places"\."organization_id" is not null/);
    expect(q!.sql).toMatch(/"organizations"\."status" <> \$/);
    expect(q!.sql).toMatch(/"offers"\."place_id" in \(\$/);
    expect(q!.sql).toMatch(/"offers"\."region_id" = \$/);
    expect(q!.params).toContain("active");
    expect(q!.params).toContain("blocked");
  });

  it("пустой список мест — без запроса", async () => {
    expect(await capture((r) => r.placeIdsWithOffer([]))).toEqual([]);
  });

  it("карточка: те же условия, сначала заканчивающиеся, без срока — в конце", async () => {
    const [q] = await capture((r) => r.offers(PLACE));
    expect(q!.sql).toMatch(/from "offers"/);
    expect(q!.sql).toMatch(/"offers"\."ends_at" >= now\(\)/);
    expect(q!.sql).toMatch(/offers\.ends_at asc nulls last/);
    expect(q!.params).toContain(PLACE);
  });
});

describe("GuideRepository.countFavorites (SQL)", () => {
  it("лимит считает те же записи, что список: только опубликованные места пользователя в регионе", async () => {
    const [count] = await capture((r) => r.countFavorites(USER).catch(() => 0)); // recordingDb строк не отдаёт
    const [list] = await capture((r) => r.favorites(USER));
    for (const q of [count!, list!]) {
      expect(q.sql).toMatch(/inner join "favorites"/);
      expect(q.sql).toMatch(/"favorites"\."user_id" = \$/);
      expect(q.sql).toMatch(/"places"\."status" = \$/);
      expect(q.sql).toMatch(/"categories"\."active" = \$/);
      expect(q.sql).toMatch(/"favorites"\."region_id" = \$/);
      expect(q.params).toContain("published");
    }
    expect(count!.sql).toMatch(/count\(\*\)/);
  });
});

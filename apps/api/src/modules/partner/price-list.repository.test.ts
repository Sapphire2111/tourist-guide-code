// Unit (без БД): SQL прайса заведения (0030) в контексте региона — TenantGuardPlugin добавляет region_id к выборкам и
// вставкам, архивные строки не читаются, правка увеличивает version и (с ожидаемой версией) проверяет её. RLS и
// реальные данные — test/integration/price-list.test.ts.
import { describe, expect, it } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { regionContext, withTenant } from "../../db/index.js";
import { PriceListRepository } from "./price-list.repository.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";
const SECTION = "0190f5c2-7d3e-7000-8000-0000000000c1";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";

async function capture(
  fn: (repo: PriceListRepository) => Promise<unknown>,
  rows: Record<string, unknown>[] = [],
) {
  const { db, queries } = recordingDb({}, () => rows);
  const repo = new PriceListRepository(db);
  await withTenant(db, regionContext(A), () => fn(repo));
  return queries.map((q) => ({ sql: q.sql, params: q.parameters })).filter((q) => !/set_config/.test(q.sql));
}

describe("PriceListRepository (SQL)", () => {
  it("разделы и позиции места: без архивных, по порядку, регион в условии", async () => {
    const [sections] = await capture((r) => r.sections(PLACE));
    expect(sections!.sql).toMatch(/from "price_list_sections"/);
    expect(sections!.sql).toMatch(/"status" <> \$/);
    expect(sections!.sql).toMatch(/"price_list_sections"\."region_id" = \$/);
    expect(sections!.sql).toMatch(/order by "sort_order", "id"/);
    expect(sections!.params).toEqual(expect.arrayContaining([PLACE, "archived", A]));
    const [items] = await capture((r) => r.items(PLACE));
    expect(items!.sql).toMatch(/"price_list_items"\."region_id" = \$/);
    expect(items!.params).toContain("archived");
  });

  it("поиск для правки — с блокировкой строки (FOR UPDATE) и по месту", async () => {
    const [q] = await capture((r) => r.findItem(PLACE, SECTION));
    expect(q!.sql).toMatch(/for update$/);
    expect(q!.sql).toMatch(/"place_id" = \$/);
  });

  it("вставка: region_id из контекста", async () => {
    const [q] = await capture(
      (r) =>
        r.createSection({ place_id: PLACE, title_i18n: { uk: "Страви" }, sort_order: 0, created_by: USER }),
      [{ id: SECTION }],
    );
    expect(q!.sql).toMatch(/insert into "price_list_sections" \(.*"region_id"/);
    expect(q!.params).toContain(A);
  });

  it("правка: version + 1, с ожидаемой версией — условие version = $", async () => {
    const [plain] = await capture((r) => r.updateItem(SECTION, { price_minor: 100 }));
    expect(plain!.sql).toMatch(/"version" = "version" \+ \$/);
    expect(plain!.sql).not.toMatch(/and "version" = \$/);
    const [checked] = await capture((r) => r.updateSection(SECTION, { status: "hidden" }, 3));
    expect(checked!.sql).toMatch(/"version" = \$/);
    expect(checked!.params).toEqual(expect.arrayContaining(["hidden", 3, A]));
  });

  it("архив раздела переносит в архив и его позиции этого места", async () => {
    const [q] = await capture((r) => r.archiveSectionItems(PLACE, SECTION));
    expect(q!.sql).toMatch(/update "price_list_items" set "status" = \$1, "version" = "version" \+ \$2/);
    expect(q!.params).toEqual(expect.arrayContaining(["archived", PLACE, SECTION, A]));
  });
});

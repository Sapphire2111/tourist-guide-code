// Unit: ошибки БД каталога → CatalogError (иначе 500). Блок 5: место в пункте сценария или с заявками гостей не
// удаляется — 409 in_use.
import { describe, expect, it } from "vitest";
import { CatalogError, mapDbError } from "./catalog.service.js";

describe("mapDbError", () => {
  it("удаление места, на которое ссылаются сценарий или заявка (RESTRICT) — in_use", () => {
    for (const constraint of ["scenario_items_place_fk", "service_requests_place_fk"]) {
      const err = mapDbError({ code: "23503", constraint }, "delete");
      expect(err, constraint).toBeInstanceOf(CatalogError);
      expect((err as CatalogError).reason).toBe("in_use");
    }
  });

  it("неизвестное ограничение — как есть", () => {
    const e = { code: "23503", constraint: "other_fk" };
    expect(mapDbError(e, "delete")).toBe(e);
  });
});

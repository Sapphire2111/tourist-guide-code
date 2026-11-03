import { describe, expect, it } from "vitest";
import { placeFitsSeason, scenarioFitsSeason, seasonAt, seasonOfDate, seasonOfMonth } from "./season.js";

describe("сезон", () => {
  it("месяцы → сезоны", () => {
    expect([12, 1, 2].map(seasonOfMonth)).toEqual(["winter", "winter", "winter"]);
    expect([3, 4, 5].map(seasonOfMonth)).toEqual(["spring", "spring", "spring"]);
    expect([6, 7, 8].map(seasonOfMonth)).toEqual(["summer", "summer", "summer"]);
    expect([9, 10, 11].map(seasonOfMonth)).toEqual(["autumn", "autumn", "autumn"]);
    expect(seasonOfDate("2026-12-31")).toBe("winter");
  });

  it("по Europe/Kyiv: 30 ноября 23:30 UTC — уже 1 грудня в Києві", () => {
    expect(seasonAt(new Date("2026-11-30T23:30:00Z"))).toBe("winter");
    expect(seasonAt(new Date("2026-11-30T20:00:00Z"))).toBe("autumn");
    expect(seasonAt(new Date("2026-07-01T00:00:00Z"), "Bad/Zone")).toBe("summer");
  });

  it("лыжи: прокат и школы — не летом и не осенью; подъёмник и джип-тур зимой и летом — видны", () => {
    const rental = { category: "ski-rental", names: ["Прокат лиж"], tags: [] };
    expect(placeFitsSeason(rental, "spring")).toBe(true);
    expect(placeFitsSeason(rental, "autumn")).toBe(false);
    expect(placeFitsSeason({ category: "ski-schools", names: ["Школа"], tags: [] }, "summer")).toBe(false);
    expect(placeFitsSeason({ category: "ski-lifts", names: ["Підйомник R1"], tags: [] }, "summer")).toBe(
      true,
    );
    expect(placeFitsSeason({ category: "active", names: ["Джип-тур на Говерлу"], tags: [] }, "winter")).toBe(
      true,
    );
    expect(
      placeFitsSeason({ category: "active", names: ["Прокат квадроциклів Синяк"], tags: [] }, "winter"),
    ).toBe(true);
  });

  it("сценарий без сезонов — круглый год", () => {
    expect(scenarioFitsSeason([], "winter")).toBe(true);
    expect(scenarioFitsSeason(["summer", "autumn"], "winter")).toBe(false);
    expect(scenarioFitsSeason(["winter"], "winter")).toBe(true);
  });

  it("место: вершина и «Літо» — не зимой, лыжи и «Зима» — только зимой", () => {
    const hike = { category: "nature", names: ["Гора Хом'як"], tags: [] };
    expect(placeFitsSeason(hike, "winter")).toBe(false);
    expect(placeFitsSeason(hike, "summer")).toBe(true);
    expect(placeFitsSeason({ category: "nature", names: ["Водоспад Пробій"], tags: [] }, "winter")).toBe(
      true,
    );
    expect(placeFitsSeason({ category: "active", names: ["Рафтинг"], tags: ["summer"] }, "winter")).toBe(
      false,
    );
    expect(placeFitsSeason({ category: "ski-rental", names: ["Прокат лиж"], tags: [] }, "summer")).toBe(
      false,
    );
    expect(placeFitsSeason({ category: "ski-rental", names: ["Прокат лиж"], tags: [] }, "winter")).toBe(true);
    expect(placeFitsSeason({ category: "cafes", names: ["Кава"], tags: ["winter"] }, "summer")).toBe(false);
    expect(
      placeFitsSeason({ category: "cafes", names: ["Кава"], tags: ["winter", "summer"] }, "summer"),
    ).toBe(true);
  });
});

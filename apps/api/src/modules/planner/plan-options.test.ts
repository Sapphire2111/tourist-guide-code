// Unit: подбор вариантов «Мій план» — без машины (пішки / потрібен транспорт), с детьми (без барів і нічних клубів,
// спершу «З дітьми»), дождь (лише під дахом), дни (без повторів), разнообразие категорий, подпись по назві з Google.
import { describe, expect, it } from "vitest";
import type { LonLat } from "../../db/index.js";
import {
  itemSlots,
  adultsOnly,
  CAR_MAX_M,
  OPTIONS_PER_SLOT,
  placeKind,
  planOptions,
  slotOf,
  slotOptions,
  travelMinutes,
  WALK_MAX_M,
  type CatalogPlace,
} from "./plan-options.js";

const P = (n: number) => `0190f5c2-7d3e-7000-8000-${String(n).padStart(12, "0")}`;
const BASE: LonLat = { lon: 24.55, lat: 48.45 };
/** Точка в `m` метрах на восток от BASE (1° долготы на 48.45° ≈ 73.8 км). */
const east = (m: number): LonLat => ({ lon: BASE.lon + m / 73_800, lat: BASE.lat });

const place = (n: number, category: string, m: number, over: Partial<CatalogPlace> = {}): CatalogPlace => ({
  id: P(n),
  category,
  names: [`Місце ${n}`],
  location: east(m),
  tags: [],
  recommended: false,
  ...over,
});

const noCar = { children: 0, withCar: false };
const car = { children: 0, withCar: true };
const kids = { children: 2, withCar: true };

describe("placeKind / adultsOnly", () => {
  it("водоспад и бар — по названию из Google; остальное — код категории", () => {
    expect(placeKind({ category: "nature", names: ["Водоспад Пробій"] })).toBe("waterfall");
    expect(placeKind({ category: "cafes", names: ["Бар «Колиба»"] })).toBe("bar");
    expect(placeKind({ category: "cafes", names: ["Wine Bar Vino"] })).toBe("bar");
    expect(placeKind({ category: "cafes", names: ["Барвінок"] })).toBe("cafes");
    expect(placeKind({ category: "restaurants", names: ["Бар-ресторан"] })).toBe("restaurants");
    expect(adultsOnly({ category: "entertainment", names: ["Нічний клуб «Ніч»"] })).toBe(true);
    expect(adultsOnly({ category: "cafes", names: ["Кав'ярня"] })).toBe(false);
    expect(adultsOnly({ category: "adult-fun", names: ["Боулінг"] })).toBe(true);
    expect(adultsOnly({ category: "kids", names: ["Дитячий майданчик"] })).toBe(false);
  });

  it("часть дня — выбранная или по времени", () => {
    expect(slotOf({ timeHint: "09:00" })).toBe("morning");
    expect(slotOf({ timeHint: "13:30" })).toBe("afternoon");
    expect(slotOf({ timeHint: "18:00" })).toBe("evening");
    expect(slotOf({ timeHint: null })).toBe("afternoon");
    expect(slotOf({ timeHint: "09:00", slot: "rain" })).toBe("rain");
  });

  it("время в пути: пешком медленнее, чем на авто", () => {
    expect(travelMinutes(1500, "walk")).toBe(26);
    expect(travelMinutes(10_000, "car")).toBe(22);
  });
});

describe("slotOptions", () => {
  it("разнообразие: по одному месту каждой категории по кругу, не больше OPTIONS_PER_SLOT", () => {
    const places = [
      place(1, "cafes", 100),
      place(2, "cafes", 200),
      place(3, "cafes", 300),
      place(4, "nature", 900),
      place(5, "museums", 400),
      place(6, "hotels", 50),
    ];
    const out = slotOptions("morning", BASE, places, car, new Set());
    expect(out.map((o) => o.placeId)).toEqual([P(1), P(4), P(5), P(2), P(3)]);
    expect(out).toHaveLength(OPTIONS_PER_SLOT);
    expect(out[0]).toMatchObject({ kind: "cafes", reason: "breakfast", travel: "walk" });
    expect(out.some((o) => o.placeId === P(6))).toBe(false);
  });

  it("без машины: только в пешей доступности; если меньше трёх — ближайшие дальше с «потрібен транспорт»", () => {
    const places = [
      place(1, "restaurants", 500),
      place(2, "restaurants", WALK_MAX_M + 1000),
      place(3, "kolyby", WALK_MAX_M + 3000),
      place(4, "chany", WALK_MAX_M + 9000),
    ];
    const out = slotOptions("evening", BASE, places, noCar, new Set());
    expect(out.map((o) => [o.placeId, o.travel])).toEqual([
      [P(1), "walk"],
      [P(2), "transport"],
      [P(3), "transport"],
    ]);
    // Пешком хватает — дальних нет.
    const near = [place(1, "restaurants", 300), place(2, "kolyby", 600), place(3, "chany", 900), ...places];
    expect(slotOptions("evening", BASE, near, noCar, new Set()).every((o) => o.travel === "walk")).toBe(true);
    // С машиной — и дальние, но не дальше CAR_MAX_M.
    const withCar = slotOptions(
      "evening",
      BASE,
      [...places, place(9, "spa", CAR_MAX_M + 2000)],
      car,
      new Set(),
    );
    expect(withCar.map((o) => o.travel)).toEqual(["walk", "car", "car", "car"]);
  });

  it("с детьми: бары и нічні клуби исключены; места с тегом «З дітьми» — первыми в категории", () => {
    const places = [
      place(1, "cafes", 100, { names: ["Pub 21"] }),
      place(2, "cafes", 300),
      place(3, "cafes", 500, { tags: ["kids"] }),
      place(4, "restaurants", 200),
      place(5, "chany", 200, { names: ["Lounge-кальян"] }),
    ];
    const out = slotOptions("evening", BASE, places, kids, new Set());
    const ids = out.map((o) => o.placeId);
    expect(ids).not.toContain(P(1));
    expect(ids).not.toContain(P(5));
    expect(ids.indexOf(P(3))).toBeLessThan(ids.indexOf(P(2)));
    expect(out.find((o) => o.placeId === P(3))!.kidsFriendly).toBe(true);
    // Без детей бар — с понятной подписью «Бар».
    expect(slotOptions("evening", BASE, places, car, new Set()).find((o) => o.placeId === P(1))!.kind).toBe(
      "bar",
    );
  });

  it("«Для дітей» — днём и первыми с детьми; «Для дорослих» — вечером и только без детей", () => {
    const places = [place(1, "kids", 300), place(2, "museums", 100), place(3, "adult-fun", 100)];
    const day = slotOptions("afternoon", BASE, places, kids, new Set()).map((o) => o.placeId);
    expect(day[0]).toBe(P(1));
    expect(slotOptions("evening", BASE, places, car, new Set()).map((o) => o.placeId)).toContain(P(3));
    expect(slotOptions("evening", BASE, places, kids, new Set()).map((o) => o.placeId)).not.toContain(P(3));
  });

  it("якщо дощ: только под крышей (музеи, кафе, чаны…); природа нет; магазины — только ТРЦ; тег «У дощ» — да", () => {
    const places = [
      place(1, "nature", 100),
      place(2, "museums", 200),
      place(3, "chany", 300),
      place(4, "stores", 300, { names: ["Магазин взуття"] }),
      place(5, "stores", 400, { names: ["ТРЦ Карпати"] }),
      place(6, "entertainment", 500),
      place(7, "entertainment", 600, { tags: ["rainy-day"] }),
    ];
    const out = slotOptions("rain", BASE, places, car, new Set());
    expect(out.map((o) => o.placeId).sort()).toEqual([P(2), P(3), P(5), P(7)]);
    expect(out.every((o) => o.reason === "indoor")).toBe(true);
  });

  it("доп. категория: место подбирается по ней, причина — по подходящей категории", () => {
    const places = [place(1, "nature", 100, { extraCategories: ["restaurants"] }), place(2, "nature", 100)];
    const out = slotOptions("evening", BASE, places, car, new Set());
    expect(out.map((o) => o.placeId)).toEqual([P(1)]);
    expect(out[0]!.reason).toBe("dinner");
  });

  it("без точки отсчёта — без расстояния", () => {
    const [o] = slotOptions("morning", null, [place(1, "cafes", 100)], noCar, new Set());
    // Без авто и без точки — не утверждаем ни «пішки», ни «потрібен транспорт».
    expect(o).toMatchObject({ distanceMeters: null, travelMinutes: null, travel: null });
  });
});

describe("itemSlots", () => {
  it("без времени — часть дня предыдущего по позиции; не убывает — порядок сценария не меняется", () => {
    const slots = itemSlots([
      { id: "a", dayNo: 1, position: 0, timeHint: null },
      { id: "b", dayNo: 1, position: 1, timeHint: "09:00" },
      { id: "c", dayNo: 1, position: 2, timeHint: "18:00" },
      { id: "d", dayNo: 1, position: 3, timeHint: null },
      { id: "e", dayNo: 1, position: 4, timeHint: "11:00" },
      { id: "f", dayNo: 2, position: 0, timeHint: null },
      { id: "g", dayNo: 1, position: 5, timeHint: null, slot: "rain" },
    ]);
    expect(Object.fromEntries(slots)).toEqual({
      a: "morning",
      b: "morning",
      c: "evening",
      d: "evening",
      e: "evening",
      f: "afternoon",
      g: "rain",
    });
  });
});

describe("planOptions", () => {
  const catalog = Array.from({ length: 30 }, (_, k) =>
    place(k + 1, ["cafes", "nature", "museums", "restaurants", "kolyby", "chany"][k % 6]!, 100 + k * 50),
  );

  it("на каждый день — 4 части; места не повторяются между днями и частями; места плана не предлагаются", () => {
    const days = planOptions({
      days: 3,
      items: [{ dayNo: 1, slot: "morning", placeId: P(1), location: east(100) }],
      places: catalog,
      trip: car,
      base: BASE,
    });
    expect(days.map((d) => d.dayNo)).toEqual([1, 2, 3]);
    const main = days.flatMap((d) => d.slots.filter((s) => s.slot !== "rain").flatMap((s) => s.options));
    const ids = main.map((o) => o.placeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(P(1));
    expect(days.every((d) => d.slots.find((s) => s.slot === "rain")!.options.length >= 3)).toBe(true);
  });

  it("расстояние — от последнего выбранного пункта дня раньше этой части дня", () => {
    const far = east(5000);
    const [day] = planOptions({
      days: 1,
      items: [{ dayNo: 1, slot: "morning", placeId: P(99), location: far }],
      places: [place(1, "restaurants", 5000), place(2, "restaurants", 0)],
      trip: car,
      base: BASE,
    });
    const afternoon = day!.slots.find((s) => s.slot === "afternoon")!.options;
    expect(afternoon.find((o) => o.placeId === P(1))!.distanceMeters).toBe(0);
    expect(afternoon.find((o) => o.placeId === P(2))!.distanceMeters).toBeGreaterThan(4900);
  });
});

// Unit: правила «Мій план» (C09, S-04) — копия пунктов сценария, «Замінити» альтернативой (и возврат), удаление,
// расстояние между пунктами.
import { describe, expect, it } from "vitest";
import type { ScenarioItem, UserPlanItemRecord } from "../../db/index.js";
import {
  PLAN_ITEMS_MAX,
  PLAN_ITEMS_PER_SLOT_MAX,
  addItem,
  planItemsFromScenario,
  removeItem,
  replaceItem,
  sphericalMeters,
  trimDays,
} from "./plan-rules.js";

const P = (n: number) => `0190f5c2-7d3e-7000-8000-${String(n).padStart(12, "0")}`;

const scenarioItem = (over: Partial<ScenarioItem>): ScenarioItem => ({
  id: P(900),
  region_id: P(1),
  scenario_id: P(2),
  day_no: 1,
  position: 0,
  place_id: P(10),
  time_hint: "09:00:00",
  duration_min: 60,
  note_i18n: null,
  alternatives: [P(11), P(12)],
  created_at: new Date(),
  ...over,
});

describe("planItemsFromScenario", () => {
  it("порядок — день и позиция; новые id; время HH:MM; альтернативы копируются", () => {
    const items = planItemsFromScenario([
      scenarioItem({ id: P(902), day_no: 2, position: 0, place_id: P(20) }),
      scenarioItem({ id: P(901), day_no: 1, position: 1, place_id: P(15) }),
      scenarioItem({ id: P(900), day_no: 1, position: 0 }),
    ]);
    expect(items.map((i) => [i.dayNo, i.position, i.placeId])).toEqual([
      [1, 0, P(10)],
      [1, 1, P(15)],
      [2, 0, P(20)],
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    expect(items.every((i) => !i.id.startsWith("0190f5c2"))).toBe(true);
    expect(items[0]).toMatchObject({
      timeHint: "09:00",
      alternatives: [P(11), P(12)],
      replacedPlaceId: null,
    });
  });
});

describe("replaceItem / removeItem", () => {
  const plan: UserPlanItemRecord[] = planItemsFromScenario([scenarioItem({})]);
  const id = plan[0]!.id;

  it("замена на альтернативу: прежнее место становится альтернативой, исходное запоминается", () => {
    const next = replaceItem(plan, id, P(11)) as UserPlanItemRecord[];
    expect(next[0]).toMatchObject({ placeId: P(11), alternatives: [P(12), P(10)], replacedPlaceId: P(10) });
    // Возврат к исходному месту снимает пометку «заменено».
    const back = replaceItem(next, id, P(10)) as UserPlanItemRecord[];
    expect(back[0]).toMatchObject({ placeId: P(10), replacedPlaceId: null });
    // Замена на другую альтернативу сохраняет исходное место сценария.
    const other = replaceItem(next, id, P(12)) as UserPlanItemRecord[];
    expect(other[0]).toMatchObject({ placeId: P(12), replacedPlaceId: P(10) });
  });

  it("место не из альтернатив и неизвестный пункт — ошибка", () => {
    expect(replaceItem(plan, id, P(99))).toBe("not_alternative");
    expect(replaceItem(plan, P(999), P(11))).toBe("item_not_found");
    expect(removeItem(plan, P(999))).toBe("item_not_found");
  });

  it("удаление пункта", () => {
    expect(removeItem(plan, id.toUpperCase())).toEqual([]);
  });
});

describe("sphericalMeters", () => {
  it("1° широты ≈ 111 км; та же точка — 0", () => {
    expect(sphericalMeters({ lon: 24, lat: 48 }, { lon: 24, lat: 49 })).toBeGreaterThan(110_000);
    expect(sphericalMeters({ lon: 24, lat: 48 }, { lon: 24, lat: 49 })).toBeLessThan(112_000);
    expect(sphericalMeters({ lon: 24, lat: 48 }, { lon: 24, lat: 48 })).toBe(0);
  });
});

describe("addItem / trimDays", () => {
  it("галочка: новый пункт в конец дня с частью дня; повтор в тот же день — already_in_plan; в «якщо дощ» — можно", () => {
    const base = planItemsFromScenario([
      scenarioItem({ id: P(900), day_no: 1, position: 0, place_id: P(10) }),
    ]);
    const next = addItem(base, { dayNo: 1, slot: "evening", placeId: P(20).toUpperCase() });
    if (typeof next === "string") throw new Error(next);
    expect(next.at(-1)).toMatchObject({
      dayNo: 1,
      position: 1,
      placeId: P(20),
      slot: "evening",
      alternatives: [],
    });
    expect(addItem(next, { dayNo: 1, slot: "morning", placeId: P(20) })).toBe("already_in_plan");
    expect(addItem(next, { dayNo: 1, slot: "rain", placeId: P(20) })).not.toBe("already_in_plan");
    expect(addItem(next, { dayNo: 2, slot: "morning", placeId: P(20) })).not.toBe("already_in_plan");
  });

  it("лимиты: в части дня — PLAN_ITEMS_PER_SLOT_MAX, в плане — PLAN_ITEMS_MAX", () => {
    let items: UserPlanItemRecord[] = [];
    for (let n = 0; n < PLAN_ITEMS_PER_SLOT_MAX; n++) {
      const r = addItem(items, { dayNo: 1, slot: "morning", placeId: P(100 + n) });
      if (typeof r === "string") throw new Error(r);
      items = r;
    }
    expect(addItem(items, { dayNo: 1, slot: "morning", placeId: P(999) })).toBe("items_limit");
    expect(addItem(items, { dayNo: 1, slot: "evening", placeId: P(999) })).not.toBe("items_limit");
    const many = Array.from({ length: PLAN_ITEMS_MAX }, (_, k) => ({
      ...items[0]!,
      dayNo: (k % 14) + 1,
      slot: undefined,
    }));
    expect(addItem(many, { dayNo: 1, slot: "evening", placeId: P(999) })).toBe("items_limit");
  });

  it("меньше дней — пункты лишних дней убираются; иначе тот же массив", () => {
    const items = planItemsFromScenario([
      scenarioItem({ id: P(900), day_no: 1 }),
      scenarioItem({ id: P(901), day_no: 3 }),
    ]);
    expect(trimDays(items, 3)).toBe(items);
    expect(trimDays(items, 2).map((i) => i.dayNo)).toEqual([1]);
  });
});

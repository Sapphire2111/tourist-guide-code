// Unit: план отдыха из мест каталога — части дня, еда рядом с предыдущей точкой, график работы, «з дітьми»,
// сезон, сегодняшний день с текущего времени, несколько дней без повторов.
import { describe, expect, it } from "vitest";
import type { ScheduleRows } from "../guide/index.js";
import {
  buildPlan,
  hasTimeToday,
  hoursOn,
  openDuring,
  planAreas,
  startMinuteFrom,
  travelOf,
  type PlanCandidate,
  type PlanDayInput,
  type PlanOptions,
} from "./plan.js";

const HOME = { lon: 24.55, lat: 48.45 };
let seq = 0;
/** Место в ~dx км к востоку от жилья (1° долготы на 48.45° ≈ 73.8 км). */
const c = (category: string, dxKm: number, over: Partial<PlanCandidate> = {}): PlanCandidate => ({
  id: `${category}-${++seq}`,
  category,
  location: { lon: HOME.lon + dxKm / 73.8, lat: HOME.lat },
  rating: 4.5,
  ratingCount: 100,
  recommended: false,
  kidsFriendly: false,
  priceLevel: null,
  schedule: null,
  wanted: false,
  ...over,
});

/** Суббота 7 ноября 2026, с утра. */
const SAT: PlanDayInput = { dayNo: 1, date: "2026-11-07", dayOfWeek: 6, fromMinute: 0 };
const SUN: PlanDayInput = { dayNo: 2, date: "2026-11-08", dayOfWeek: 7, fromMinute: 0 };
const opts = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  days: [SAT],
  parts: [],
  origin: HOME,
  withKids: false,
  month: 11,
  priceMin: null,
  priceMax: null,
  ...over,
});
const weekly = (dayOfWeek: number, opensAt: string, closesAt: string): ScheduleRows => ({
  weekly: [{ dayOfWeek, opensAt, closesAt }],
  exceptions: [],
});

const catalog = () => [
  c("nature", 1),
  c("sights", 1.5),
  c("museums", 2),
  c("active", 3),
  c("restaurants", 2.2),
  c("restaurants", 10),
  c("kolyby", 3.1),
  c("cafes", 1.2),
  c("chany", 3.5),
  c("spa", 12),
];

const roles = (plan: ReturnType<typeof buildPlan>) =>
  plan.days.map((d) => d.parts.map((p) => [p.part, p.stops.map((s) => s.role)]));

describe("buildPlan", () => {
  it("весь день: ранок — огляд, день — обід і активності, вечір — вечеря і відпочинок; без повторів", () => {
    const plan = buildPlan(catalog(), opts());
    const parts = roles(plan)[0]!;
    expect(parts.map(([p]) => p)).toEqual(["morning", "afternoon", "evening"]);
    expect(parts[1]![1]![0]).toBe("eat");
    expect(parts[2]![1]).toEqual(["eat", "relax"]);
    const ids = plan.days.flatMap((d) => d.parts.flatMap((p) => p.stops.map((s) => s.placeId)));
    expect(new Set(ids).size).toBe(ids.length);
    // Время идёт вперёд, переезды посчитаны.
    const starts = plan.days[0]!.parts.flatMap((p) => p.stops.map((s) => s.startMinute));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(plan.days[0]!.parts[0]!.stops[0]).toMatchObject({
      travel: "walk",
      startMinute: expect.any(Number),
    });
    expect(plan.lengthMeters).toBeGreaterThan(0);
  });

  it("еда — рядом с предыдущей точкой, а не лучшая через пол-области", () => {
    const near = c("restaurants", 2.1, { rating: 4.3 });
    const far = c("restaurants", 25, { rating: 4.9 });
    const plan = buildPlan([c("nature", 2), c("sights", 2.2), near, far], opts({ parts: ["afternoon"] }));
    expect(plan.days[0]!.parts[0]!.stops[0]!.placeId).toBe(near.id);
  });

  it("закрытое в это время место не берётся; неизвестный график — допустим", () => {
    const closedEvening = c("restaurants", 1, { schedule: weekly(6, "09:00", "17:00"), rating: 5 });
    const openEvening = c("restaurants", 3, { schedule: weekly(6, "12:00", "23:00") });
    const plan = buildPlan([closedEvening, openEvening, c("chany", 3)], opts({ parts: ["evening"] }));
    const stops = plan.days[0]!.parts[0]!.stops;
    expect(stops.map((s) => s.placeId)).toContain(openEvening.id);
    expect(stops.map((s) => s.placeId)).not.toContain(closedEvening.id);
    expect(stops.find((s) => s.placeId === openEvening.id)!.hours).toBe("12:00–23:00");
  });

  it("з дітьми: «Для дорослих» не попадает, дитячі — выше", () => {
    const adult = c("adult-fun", 0.5, { rating: 5 });
    const kids = c("kids", 3, { kidsFriendly: true, rating: 4.2 });
    const plain = c("active", 2.9, { rating: 4.2 });
    const plan = buildPlan(
      [adult, kids, plain, c("sights", 1)],
      opts({ parts: ["morning"], withKids: true }),
    );
    const ids = plan.days[0]!.parts[0]!.stops.map((s) => s.placeId);
    expect(ids).not.toContain(adult.id);
    expect(ids.indexOf(kids.id)).toBeGreaterThanOrEqual(0);
    expect(buildPlan([adult], opts({ parts: ["morning"] })).days[0]!.parts).toHaveLength(1);
  });

  it("«що робити ввечері»: розвага, вечеря, відпочинок; лыжи — только зимой", () => {
    const ski = c("ski-resorts", 1, { rating: 5 });
    const evening = buildPlan(
      [ski, c("entertainment", 1.5), c("restaurants", 2), c("chany", 2.5)],
      opts({ parts: ["evening"] }),
    );
    expect(roles(evening)[0]).toEqual([["evening", ["fun", "eat", "relax"]]]);
    expect(evening.days[0]!.parts[0]!.stops.map((s) => s.placeId)).not.toContain(ski.id);
    const winter = buildPlan([ski], opts({ parts: ["morning"], month: 1 }));
    expect(winter.days[0]!.parts[0]!.stops[0]!.placeId).toBe(ski.id);
  });

  it("сегодня с 15:00 — без ранку; несколько дней — разные места, каждый день от жилья", () => {
    const today = buildPlan(catalog(), opts({ days: [{ ...SAT, fromMinute: 15 * 60 }] }));
    expect(today.days[0]!.parts.map((p) => p.part)).toEqual(["afternoon", "evening"]);
    expect(today.days[0]!.parts[0]!.stops[0]!.startMinute).toBeGreaterThanOrEqual(15 * 60);
    const two = buildPlan([...catalog(), ...catalog()], opts({ days: [SAT, SUN] }));
    expect(two.days).toHaveLength(2);
    const d1 = two.days[0]!.parts.flatMap((p) => p.stops.map((s) => s.placeId));
    const d2 = two.days[1]!.parts.flatMap((p) => p.stops.map((s) => s.placeId));
    expect(d2.length).toBeGreaterThan(0);
    expect(d1.filter((id) => d2.includes(id))).toEqual([]);
  });

  it("без точки туриста — день начинается с лучшей пам'ятки, первый пункт без переезда", () => {
    const best = c("nature", 40, { rating: 4.9, ratingCount: 5000, wanted: true });
    const plan = buildPlan(
      [c("sights", 1), best, c("sights", 40.5)],
      opts({ origin: undefined, parts: ["morning"] }),
    );
    const stops = plan.days[0]!.parts[0]!.stops;
    expect(stops[0]).toMatchObject({ placeId: best.id, travel: null, travelMeters: null });
    expect(stops[1]!.travelMeters).toBeLessThan(1000);
  });

  it("предел 30 км строгий: и от жилья, и между пунктами (дальнее и ближнее — не в один день)", () => {
    const far = c("nature", 80, { rating: 5, wanted: true });
    const near = c("sights", 1);
    // От жилья — дальнее не берётся.
    expect(buildPlan([far], opts({ parts: ["morning"] })).days[0]!.parts).toEqual([]);
    // Без жилья день начинается у лучшего (дальнего) — ближнее за 79 км в тот же день не попадает.
    const plan = buildPlan([far, near], opts({ origin: undefined, parts: ["morning"] }));
    expect(plan.days[0]!.parts[0]!.stops.map((s) => s.placeId)).toEqual([far.id]);
    // С жильём рядом — ближнее, дальнее не попадает.
    const home = buildPlan([far, near], opts({ parts: ["morning"] }));
    expect(home.days[0]!.parts[0]!.stops.map((s) => s.placeId)).toEqual([near.id]);
  });

  it("цена: дорогой ресторан при «недорого» — ниже", () => {
    const pricey = c("restaurants", 1, { priceLevel: 4, rating: 4.8 });
    const cheap = c("restaurants", 1.1, { priceLevel: 1, rating: 4.4 });
    const plan = buildPlan([pricey, cheap], opts({ parts: ["evening"], priceMax: 2 }));
    expect(plan.days[0]!.parts[0]!.stops[0]!.placeId).toBe(cheap.id);
  });
});

describe("помощники", () => {
  it("переезд: до 1.2 км пешком, дальше — на авто", () => {
    expect(travelOf(500)).toEqual({ travel: "walk", minutes: 8 });
    expect(travelOf(10_000).travel).toBe("car");
    expect(travelOf(10_000).minutes).toBeGreaterThan(20);
  });

  it("график: открыто весь визит, через полночь, исключение даты; часы дня", () => {
    const s = weekly(6, "10:00", "18:00");
    expect(openDuring(s, SAT, 11 * 60, 12 * 60)).toBe(true);
    expect(openDuring(s, SAT, 17 * 60, 19 * 60)).toBe(false);
    // Закрывается за 10 минут до конца визита — не подходит.
    expect(openDuring(s, SAT, 16 * 60 + 40, 18 * 60 + 10)).toBe(false);
    expect(openDuring(s, SAT, 16 * 60 + 30, 18 * 60)).toBe(true);
    expect(openDuring(s, SUN, 11 * 60, 12 * 60)).toBe(false);
    expect(openDuring(null, SAT, 0, 60)).toBeNull();
    expect(openDuring(weekly(6, "18:00", "02:00"), SAT, 20 * 60, 23 * 60)).toBe(true);
    const closed: ScheduleRows = {
      weekly: s.weekly,
      exceptions: [{ date: SAT.date, closed: true, opensAt: null, closesAt: null }],
    };
    expect(openDuring(closed, SAT, 11 * 60, 12 * 60)).toBe(false);
    expect(hoursOn(s, SAT)).toBe("10:00–18:00");
    expect(hoursOn(closed, SAT)).toBeNull();
    expect(hoursOn(s, SUN)).toBeNull();
    // Круглосуточно (00:00–23:59 или 00:00–24:00) — «Цілодобово», а не цифры.
    expect(hoursOn(weekly(6, "00:00", "23:59"), SAT)).toBe("Цілодобово");
    expect(hoursOn(weekly(6, "00:00", "24:00"), SAT)).toBe("Цілодобово");
  });

  it("сегодня: начало через 15 мин на четверть часа; поздно — времени нет", () => {
    expect(startMinuteFrom(9 * 60 + 2)).toBe(9 * 60 + 30);
    expect(hasTimeToday([], 20 * 60)).toBe(true);
    expect(hasTimeToday([], 22 * 60)).toBe(false);
    expect(hasTimeToday(["morning"], 12 * 60 + 30)).toBe(false);
  });
});

describe("план по районам и без авто", () => {
  /** Район: пам'ятки, обед, ужин и отдых вокруг точки в dx км к востоку. */
  const area = (dx: number, rating = 4.5) => [
    c("nature", dx, { rating }),
    c("sights", dx + 0.3, { rating }),
    c("museums", dx + 0.6, { rating }),
    c("active", dx + 0.9, { rating }),
    c("restaurants", dx + 0.4),
    c("kolyby", dx + 0.7),
    c("cafes", dx + 0.2),
    c("restaurants", dx + 1),
    c("chany", dx + 1.1),
  ];
  const dayN = (n: number): PlanDayInput => ({
    dayNo: n,
    date: `2026-11-${String(6 + n).padStart(2, "0")}`,
    dayOfWeek: ((5 + n) % 7) + 1,
    fromMinute: 0,
  });
  const distKm = (a: { lon: number }, b: { lon: number }) => Math.abs(a.lon - b.lon) * 73.8;

  it("районы: лучшие по рейтингу, не ближе 15 км друг к другу; районов меньше дней — повтор; порядок от жилья", () => {
    const all = [...area(0, 4.3), ...area(40, 4.9), ...area(80, 4.6), ...area(5, 4.2)];
    const areas = planAreas(all, 3, { ...opts(), origin: HOME });
    expect(areas).toHaveLength(3);
    for (const [i, a] of areas.entries())
      for (const b of areas.slice(i + 1)) expect(distKm(a, b)).toBeGreaterThanOrEqual(15);
    // От жилья (0 км) — сначала ближний район, затем 40, затем 80.
    expect(areas.map((a) => Math.round(distKm(a, HOME) / 10) * 10)).toEqual([0, 40, 80]);
    const five = planAreas(all, 5, { ...opts(), origin: HOME });
    expect(five).toHaveLength(5);
    expect(new Set(five.map((a) => a.lon)).size).toBe(3);
    expect(planAreas([], 3, opts())).toEqual([]);
  });

  it("день в районе: места только в радиусе района, без переезда от жилья; 5 дней без повторов", () => {
    const all = [...area(0), ...area(40), ...area(80), ...area(120), ...area(160)];
    const centers = [0, 40, 80, 120, 160].map((dx) => ({ lon: HOME.lon + dx / 73.8, lat: HOME.lat }));
    const days = centers.map((center, i) => ({ ...dayN(i + 1), center }));
    const plan = buildPlan(all, opts({ days }));
    expect(plan.days).toHaveLength(5);
    const byId = new Map(all.map((x) => [x.id, x]));
    for (const [i, d] of plan.days.entries()) {
      const stops = d.parts.flatMap((p) => p.stops);
      expect(stops.length).toBeGreaterThanOrEqual(4);
      for (const s of stops)
        expect(distKm(byId.get(s.placeId)!.location, centers[i]!)).toBeLessThanOrEqual(12);
      // Переезд к району — между днями: первый пункт дня без переезда.
      expect(stops[0]).toMatchObject({ travel: null, travelMeters: null });
    }
    const ids = plan.days.flatMap((d) => d.parts.flatMap((p) => p.stops.map((s) => s.placeId)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("без авто: переходы только пешком и не дальше 2 км; на авто — дальше на машине", () => {
    const spread = [
      c("nature", 0.5),
      c("sights", 1.2),
      c("museums", 6),
      c("active", 8),
      c("restaurants", 1.8),
      c("restaurants", 9),
      c("chany", 2.5),
      c("chany", 10),
    ];
    const foot = buildPlan(spread, opts({ transport: "foot" }));
    const stops = foot.days[0]!.parts.flatMap((p) => p.stops);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((s) => s.travel === "walk" && (s.travelMeters ?? 0) <= 2000)).toBe(true);
    const car = buildPlan(spread, opts());
    expect(car.days[0]!.parts.flatMap((p) => p.stops).some((s) => s.travel === "car")).toBe(true);
  });
});

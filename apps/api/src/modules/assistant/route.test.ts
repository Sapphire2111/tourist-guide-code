// Unit: порядок обхода экскурсии и длина маршрута.
import { describe, expect, it } from "vitest";
import { haversineMeters, orderRoute } from "./route.js";

const at = (lon: number, lat: number) => ({ location: { lon, lat } });

describe("haversineMeters", () => {
  it("0,01° широты ≈ 1112 м", () => {
    expect(Math.round(haversineMeters({ lon: 24.5, lat: 48.4 }, { lon: 24.5, lat: 48.41 }))).toBe(1112);
  });
});

describe("orderRoute", () => {
  const a = at(24.5, 48.4);
  const b = at(24.5, 48.41);
  const c = at(24.5, 48.425);

  it("от точки туриста — ближайший следующий; длина — между остановками", () => {
    const { ordered, lengthMeters } = orderRoute([c, a, b], { lon: 24.5, lat: 48.43 });
    expect(ordered).toEqual([c, b, a]);
    // 0,015° + 0,01° широты ≈ 2780 м.
    expect(lengthMeters).toBeGreaterThan(2770);
    expect(lengthMeters).toBeLessThan(2790);
  });

  it("без точки — от первого места", () => {
    expect(orderRoute([b, c, a]).ordered).toEqual([b, a, c]);
  });

  it("пусто и одна остановка", () => {
    expect(orderRoute([])).toEqual({ ordered: [], lengthMeters: 0 });
    expect(orderRoute([a])).toEqual({ ordered: [a], lengthMeters: 0 });
  });
});

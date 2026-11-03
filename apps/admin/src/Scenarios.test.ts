import { describe, expect, it } from "vitest";
import { scenarioBody, seasonsLabel } from "./Scenarios.js";

const loc = (uk: string) => ({ uk, en: "" });

describe("сценарии: сезоны", () => {
  it("scenarioBody — сезоны в порядке года, без повторов", () => {
    const body = scenarioBody({
      code: "winter-day",
      title: loc("Зимовий день"),
      description: loc(""),
      days: "1",
      tags: ["ski"],
      seasons: ["autumn", "winter", "autumn"],
      adLabel: "",
      sortOrder: "0",
      items: [
        {
          dayNo: 1,
          placeId: "0190f5c2-7d3e-7000-8000-000000000001",
          timeHint: "10:00",
          duration: "300",
          note: loc(""),
          alternatives: [],
        },
      ],
    });
    expect(body.seasons).toEqual(["winter", "autumn"]);
    expect(body.tags).toEqual(["ski"]);
    expect(body.items[0]).toMatchObject({ durationMin: 300, timeHint: "10:00" });
  });

  it("seasonsLabel — «Круглий рік» без сезонов", () => {
    const t = (k: string) => k.split(".").at(-1)!;
    expect(seasonsLabel([], t, "Круглий рік")).toBe("Круглий рік");
    expect(seasonsLabel(["summer", "autumn"], t, "Круглий рік")).toBe("summer, autumn");
  });
});

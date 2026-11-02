import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuid.js";

describe("uuidv7", () => {
  it("формат v7, вариант RFC, время в старших битах — id растут со временем", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13).replace("-", "")).toBe((1_700_000_000_000).toString(16).padStart(12, "0"));
    expect(a < b).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });
});

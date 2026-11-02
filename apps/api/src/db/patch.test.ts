import { describe, expect, it } from "vitest";
import { hasValues } from "./patch.js";

describe("hasValues", () => {
  it("true, если есть хотя бы одно поле не undefined (null — значение)", () => {
    expect(hasValues({})).toBe(false);
    expect(hasValues({ a: undefined })).toBe(false);
    expect(hasValues({ a: undefined, b: null })).toBe(true);
    expect(hasValues({ a: 0 })).toBe(true);
  });
});

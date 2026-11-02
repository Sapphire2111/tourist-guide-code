import { describe, expect, it } from "vitest";
import { APP_NAME } from "./index.js";

describe("@tg/shared", () => {
  it("экспортирует название приложения", () => {
    expect(APP_NAME).toBe("Гід туриста");
  });
});

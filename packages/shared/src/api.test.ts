import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_HTTP_STATUS, ERROR_MESSAGE_KEYS } from "./index.js";

describe("коды ошибок API", () => {
  it("покрывают статусы 400/401/403/404/409/422/429/500/502/503/504", () => {
    expect([...new Set(Object.values(ERROR_HTTP_STATUS))].sort()).toEqual([
      400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504,
    ]);
  });

  it("у каждого кода есть ключ i18n в пространстве errors.*", () => {
    for (const code of ERROR_CODES) expect(ERROR_MESSAGE_KEYS[code]).toMatch(/^errors\.\w+$/);
  });
});

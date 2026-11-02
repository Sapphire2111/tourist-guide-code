import { describe, expect, expectTypeOf, it } from "vitest";
import { createApiClient, type ErrorEnvelope, type HealthStatus } from "./index.js";

// В пакете нет DOM-типов (изоморфный): Response берём из globalThis среды Node.
const NodeResponse = (globalThis as unknown as { Response: new (body: string, init: object) => never })
  .Response;

describe("@tg/api-client", () => {
  it("реэкспортирует тип ответа /health", () => {
    expectTypeOf<HealthStatus>().toEqualTypeOf<{ status: "ok" }>();
  });

  it("типизирует ответ и ошибку по сгенерированной схеме", async () => {
    const calls: string[] = [];
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetch: async (req) => {
        calls.push(req.url);
        return new NodeResponse(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const { data, error } = await client.GET("/health");
    expectTypeOf(data).toEqualTypeOf<{ status: "ok" } | undefined>();
    expectTypeOf(error).toMatchTypeOf<{ error: Pick<ErrorEnvelope["error"], "messageKey"> } | undefined>();
    expect(data).toEqual({ status: "ok" });
    expect(calls).toEqual(["http://api.test/health"]);
  });
});

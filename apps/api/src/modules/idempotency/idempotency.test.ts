// Unit (без БД): ключ, область, хэш тела, решение по занятому ключу (T1-14).
import { describe, expect, it } from "vitest";
import { ApiError } from "../../common/http/index.js";
import type { IdempotencyKey } from "../../db/index.js";
import {
  canonicalJson,
  decideExisting,
  idempotencyActor,
  idempotencyScope,
  parseIdempotencyKey,
  requestHash,
} from "./idempotency.js";
import { Idempotent } from "./idempotent.decorator.js";

describe("Idempotency-Key: чистые функции", () => {
  it("ключ: видимые ASCII 1–255; нет, пусто, пробелы, повтор заголовка, >255 — некорректен", () => {
    expect(parseIdempotencyKey("0190f5c2-7d3e-7000-8000-00000000000a")).toBe(
      "0190f5c2-7d3e-7000-8000-00000000000a",
    );
    expect(parseIdempotencyKey("x".repeat(255))).toBe("x".repeat(255));
    for (const bad of [undefined, "", " a", "a b", "ключ", "x".repeat(256), ["a", "b"]])
      expect(parseIdempotencyKey(bad)).toBeUndefined();
  });

  it("актор: user:<id> при req.user.id, иначе undefined (до T1-26)", () => {
    expect(idempotencyActor({ user: { id: "u1" } })).toBe("user:u1");
    expect(idempotencyActor({})).toBeUndefined();
    expect(idempotencyActor({ user: { id: 5 } })).toBeUndefined();
  });

  it("область: актор + метод + путь без query", () => {
    expect(idempotencyScope("anon", "post", "/payments/1/refund?x=1")).toBe("anon:POST /payments/1/refund");
    expect(idempotencyScope("user:u1", "POST", "/a")).not.toBe(idempotencyScope("user:u2", "POST", "/a"));
  });

  it("хэш: sha256 hex канонического JSON — порядок ключей не важен, значения и порядок массивов важны", () => {
    expect(canonicalJson({ b: [2, 1], a: { d: 1, c: undefined, e: null } })).toBe(
      '{"a":{"d":1,"e":null},"b":[2,1]}',
    );
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
    expect(requestHash({ a: [1, 2] })).not.toBe(requestHash({ a: [2, 1] }));
    expect(requestHash(undefined)).toBe(requestHash(null));
  });

  it("решение по занятому ключу: другой хэш → mismatch, completed → replay, иначе in_progress", () => {
    const row = (status: IdempotencyKey["status"], hash = "h1") => ({
      request_hash: hash,
      status,
      response_status: status === "completed" ? 201 : null,
      response_body: status === "completed" ? { value: { id: 1 } } : null,
    });
    expect(decideExisting(row("completed"), "h2")).toEqual({ kind: "mismatch" });
    expect(decideExisting(row("in_progress"), "h2")).toEqual({ kind: "mismatch" });
    expect(decideExisting(row("failed"), "h2")).toEqual({ kind: "mismatch" });
    expect(decideExisting(row("completed"), "h1")).toEqual({
      kind: "replay",
      status: 201,
      body: { value: { id: 1 } },
    });
    expect(decideExisting(row("in_progress"), "h1")).toEqual({ kind: "in_progress" });
  });

  it("@Idempotent: ttlSeconds — целое >= 60", () => {
    for (const bad of [0, 59, 60.5, -1]) expect(() => Idempotent({ ttlSeconds: bad })).toThrow(/ttlSeconds/);
    expect(() => Idempotent({ ttlSeconds: 60 })).not.toThrow();
    expect(() => Idempotent()).not.toThrow();
  });

  it("ApiError: status — только 400–499", () => {
    expect(new ApiError("BAD_REQUEST", { status: 413 }).getStatus()).toBe(413);
    expect(new ApiError("CONFLICT").getStatus()).toBe(409);
    for (const bad of [200, 399, 500, 503, 404.5])
      expect(() => new ApiError("BAD_REQUEST", { status: bad })).toThrow(/400–499/);
  });
});

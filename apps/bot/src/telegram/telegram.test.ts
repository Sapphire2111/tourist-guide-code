import { describe, expect, it, vi } from "vitest";
import { BotApiClient, BotApiError } from "./bot-api.js";
import { miniappUrl, parseStart } from "./start.js";
import { isValidWebhookSecret } from "./webhook-secret.js";

describe("isValidWebhookSecret", () => {
  it("верный секрет", () => expect(isValidWebhookSecret("s3cret", "s3cret")).toBe(true));
  it("неверный / другой длины", () => {
    expect(isValidWebhookSecret("s3creX", "s3cret")).toBe(false);
    expect(isValidWebhookSecret("s3cret-longer", "s3cret")).toBe(false);
  });
  it("нет заголовка, массив или секрет не настроен", () => {
    expect(isValidWebhookSecret(undefined, "s3cret")).toBe(false);
    expect(isValidWebhookSecret(["s3cret"], "s3cret")).toBe(false);
    expect(isValidWebhookSecret("", "")).toBe(false);
    expect(isValidWebhookSecret("x", undefined)).toBe(false);
  });
});

describe("parseStart", () => {
  it("валидный payload", () => {
    expect(parseStart("/start hotel-12_A")).toEqual({ payload: "hotel-12_A", invalidPayload: false });
    expect(parseStart("/start@TouristBot abc")).toEqual({ payload: "abc", invalidPayload: false });
    expect(parseStart("/start " + "a".repeat(64))?.payload).toHaveLength(64);
  });
  it("без payload", () => expect(parseStart("/start")).toEqual({ payload: null, invalidPayload: false }));
  it("невалидный payload не передаётся", () => {
    for (const bad of ["/start a b", "/start ab/cd", "/start " + "a".repeat(65), "/start приклад"]) {
      expect(parseStart(bad)).toEqual({ payload: null, invalidPayload: true });
    }
  });
  it("не /start → null", () => {
    expect(parseStart("привіт")).toBeNull();
    expect(parseStart("/started")).toBeNull();
    expect(parseStart(undefined)).toBeNull();
  });
  it("ссылка miniapp со startapp и без", () => {
    expect(miniappUrl("https://m.example/app", "q1")).toBe("https://m.example/app?startapp=q1");
    expect(miniappUrl("https://m.example/app", null)).toBe("https://m.example/app");
  });
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("BotApiClient", () => {
  it("429 → ждёт retry_after и повторяет", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(429, {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 3 },
        }),
      )
      .mockResolvedValueOnce(json(200, { ok: true, result: { message_id: 1 } }));
    const sleep = vi.fn(async () => {});
    const client = new BotApiClient({ token: "TOKEN", fetch: fetchMock, sleep });
    await expect(client.sendMessage({ chat_id: 1, text: "x" })).resolves.toEqual({ message_id: 1 });
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.telegram.org/botTOKEN/sendMessage");
  });

  it("429 сверх лимита повторов → повторяемая ошибка без токена в тексте", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(429, { ok: false, parameters: { retry_after: 1 } }),
    );
    const client = new BotApiClient({
      token: "TOKEN",
      fetch: fetchMock,
      sleep: async () => {},
      maxRetries: 2,
    });
    const err = await client.sendMessage({ chat_id: 1, text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotApiError);
    expect((err as BotApiError).retryable).toBe(true);
    expect((err as Error).message).not.toContain("TOKEN");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("403 (бот заблокирован) — не повторяемая", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(403, { ok: false, error_code: 403, description: "Forbidden" }),
    );
    const err = await new BotApiClient({ token: "T", fetch: fetchMock })
      .sendMessage({ chat_id: 1, text: "x" })
      .catch((e: unknown) => e);
    expect((err as BotApiError).retryable).toBe(false);
  });

  it("retry_after больше лимита — без ожидания, ошибка очереди (её backoff)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(429, { ok: false, parameters: { retry_after: 30 } }),
    );
    const sleep = vi.fn(async () => {});
    const err = await new BotApiClient({ token: "T", fetch: fetchMock, sleep })
      .sendMessage({ chat_id: 1, text: "x" })
      .catch((e: unknown) => e);
    expect((err as BotApiError).retryable).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("5xx и сетевая ошибка — повторяемые, без токена в тексте", async () => {
    const e5 = await new BotApiClient({ token: "SECRET-TOKEN", fetch: async () => json(502, { ok: false }) })
      .sendMessage({ chat_id: 1, text: "x" })
      .catch((e: unknown) => e);
    expect((e5 as BotApiError).retryable).toBe(true);
    expect((e5 as Error).message).not.toContain("SECRET-TOKEN");
    const net = await new BotApiClient({
      token: "SECRET-TOKEN",
      fetch: async () => {
        throw new TypeError("fetch failed https://api.telegram.org/botSECRET-TOKEN/sendMessage");
      },
    })
      .sendMessage({ chat_id: 1, text: "x" })
      .catch((e: unknown) => e);
    expect((net as BotApiError).retryable).toBe(true);
    expect((net as Error).message).not.toContain("SECRET-TOKEN");
  });
});

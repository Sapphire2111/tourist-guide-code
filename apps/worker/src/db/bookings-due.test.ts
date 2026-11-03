// Unit (без БД): сроки броней вызывают функции БД пачками, пока пачка полная; строки outbox воркера отправляются через
// Bot API и отмечаются итогом. Сами функции bookings_expire_due(), bookings_auto_complete(), bookings_send_reminders(),
// notifications_claim_pending() на PostgreSQL — apps/api/test/integration/bookings.test.ts.
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "@tg/queue-contract";
import { createHandlers } from "../queue/handlers.js";
import {
  BotApiTelegramSender,
  bookingsDueProcessor,
  NOTIFICATION_LEASE_SEC,
  NOTIFICATION_MAX_ATTEMPTS,
  notificationBackoffSec,
  TelegramSendError,
  WORKER_NOTIFICATION_TEMPLATES,
  type RowsQueryable,
} from "@tg/queue-contract";

/** БД-заглушка: ответ по началу текста запроса (очередь ответов на каждый вид). */
function db(answers: Record<string, Record<string, unknown>[][]>) {
  const query = vi.fn<RowsQueryable["query"]>(async (text) => {
    const key = Object.keys(answers).find((k) => text.includes(k));
    const rows = key ? answers[key]!.shift() : undefined;
    return { rows: rows ?? (text.includes("claim") ? [] : [{ n: 0, ok: true }]) };
  });
  return { query };
}

const ctx = {
  context: systemContext(null),
  jobId: "j1",
  attempt: 1,
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
};

const EMPTY = { sent: 0, failed: 0, skipped: 0, retried: 0 };

describe("bookingsDueProcessor", () => {
  it("expired, автозавершение и напоминания — пачками, повтор, пока пачка полная", async () => {
    const q = db({ bookings_expire_due: [[{ n: 2 }], [{ n: 1 }]], bookings_send_reminders: [[{ n: 1 }]] });
    await expect(bookingsDueProcessor(q, { autoCompleteHours: 12, batch: 2 }).processDue()).resolves.toEqual({
      expired: 3,
      completed: 0,
      reminded: 1,
      notifications: EMPTY,
    });
    expect(q.query).toHaveBeenNthCalledWith(1, "SELECT bookings_expire_due($1) AS n", [2]);
    expect(q.query).toHaveBeenNthCalledWith(3, "SELECT bookings_auto_complete($1, $2) AS n", [12, 2]);
    expect(q.query).toHaveBeenNthCalledWith(4, "SELECT bookings_send_reminders($1, $2, $3) AS n", [
      [1440, 120],
      15,
      2,
    ]);
  });

  it("по умолчанию — 24 ч и пачка 500; неверные часы и минуты напоминаний — ошибка конфигурации", async () => {
    const q = db({});
    await bookingsDueProcessor(q).processDue();
    expect(q.query.mock.calls[1]![1]).toEqual([24, 500]);
    expect(() => bookingsDueProcessor(q, { autoCompleteHours: 0 })).toThrow();
    expect(() =>
      bookingsDueProcessor(q, { reminders: { userBeforeMin: [0], partnerBeforeDueMin: 15 } }),
    ).toThrow();
  });

  it("outbox воркера: только свои шаблоны; отправлено/ошибка — отметка итога номером взятия; без бота — skipped", async () => {
    const claimed = [
      { id: "n1", chat_id: "101", body: "Бронювання №1", attempts: 1 },
      { id: "n2", chat_id: "102", body: "Бронювання №2", attempts: 2 },
    ];
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Bot API: 403"));
    const q = db({ notifications_claim_pending: [claimed] });
    const out = await bookingsDueProcessor(q, { sender: { send } }).processDue();
    expect(out.notifications).toEqual({ sent: 1, failed: 1, skipped: 0, retried: 0 });
    expect(send).toHaveBeenNthCalledWith(1, "101", "Бронювання №1");
    const claim = q.query.mock.calls.find(([t]) => t.includes("notifications_claim_pending"))!;
    expect(claim[1]).toEqual([
      WORKER_NOTIFICATION_TEMPLATES,
      50,
      NOTIFICATION_MAX_ATTEMPTS,
      NOTIFICATION_LEASE_SEC,
    ]);
    const marks = q.query.mock.calls.filter(([t]) => t.includes("notifications_mark_dispatched"));
    // Номер взятия: отметка не применится, если аренда истекла и строку взял другой воркер.
    expect(marks.map(([, v]) => v)).toEqual([
      ["n1", "sent", null, 1],
      ["n2", "failed", "Bot API: 403", 2],
    ]);

    const noBot = db({ notifications_claim_pending: [claimed.slice(0, 1)] });
    expect((await bookingsDueProcessor(noBot).processDue()).notifications).toEqual({
      sent: 0,
      failed: 0,
      skipped: 1,
      retried: 0,
    });
    expect(noBot.query.mock.calls.at(-1)![1]).toEqual(["n1", "skipped", "bot_not_configured", 1]);
  });

  it("5xx — строка в очередь по backoff (попытка посчитана), пачка прерывается: остальные — без траты попытки", async () => {
    const claimed = [
      { id: "n1", chat_id: "101", body: "1", attempts: 2 },
      { id: "n2", chat_id: "102", body: "2", attempts: 1 },
      { id: "n3", chat_id: "103", body: "3", attempts: 1 },
    ];
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TelegramSendError("Bot API sendMessage: 502 Bad Gateway", true));
    const q = db({ notifications_claim_pending: [claimed] });
    const out = await bookingsDueProcessor(q, { sender: { send } }).processDue();
    expect(out.notifications).toEqual({ sent: 0, failed: 0, skipped: 0, retried: 3 });
    expect(send).toHaveBeenCalledTimes(1);
    const releases = q.query.mock.calls
      .filter(([t]) => t.includes("notifications_release"))
      .map(([, v]) => v);
    const err = "Bot API sendMessage: 502 Bad Gateway";
    expect(releases).toEqual([
      ["n1", notificationBackoffSec(2), err, 2, false],
      ["n2", notificationBackoffSec(2), err, 1, true],
      ["n3", notificationBackoffSec(2), err, 1, true],
    ]);
    // Прерванная пачка — следующая в этом тике не берётся.
    expect(q.query.mock.calls.filter(([t]) => t.includes("notifications_claim_pending"))).toHaveLength(1);
    expect(q.query.mock.calls.some(([t]) => t.includes("notifications_mark_dispatched"))).toBe(false);
  });

  it("429 — retry_after без траты попытки, и на последней попытке; остальные взятые строки тоже отложены", async () => {
    const claimed = [
      { id: "n1", chat_id: "101", body: "1", attempts: NOTIFICATION_MAX_ATTEMPTS },
      { id: "n2", chat_id: "102", body: "2", attempts: 1 },
    ];
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TelegramSendError("Bot API sendMessage: 429 Too Many Requests", true, 30));
    const q = db({ notifications_claim_pending: [claimed] });
    const out = await bookingsDueProcessor(q, { sender: { send } }).processDue();
    expect(out.notifications).toEqual({ sent: 0, failed: 0, skipped: 0, retried: 2 });
    const releases = q.query.mock.calls
      .filter(([t]) => t.includes("notifications_release"))
      .map(([, v]) => v);
    expect(releases).toEqual([
      ["n1", 30, "Bot API sendMessage: 429 Too Many Requests", NOTIFICATION_MAX_ATTEMPTS, true],
      ["n2", 30, "Bot API sendMessage: 429 Too Many Requests", 1, true],
    ]);
  });

  it("5xx на последней попытке — failed (остаток пачки отложен); неповторяемая (403, таймаут) — failed сразу", async () => {
    const last = db({
      notifications_claim_pending: [
        [
          { id: "n1", chat_id: "101", body: "1", attempts: NOTIFICATION_MAX_ATTEMPTS },
          { id: "n2", chat_id: "102", body: "2", attempts: 1 },
        ],
      ],
    });
    const send5xx = vi.fn().mockRejectedValueOnce(new TelegramSendError("Bot API sendMessage: 503", true));
    expect(
      (await bookingsDueProcessor(last, { sender: { send: send5xx } }).processDue()).notifications,
    ).toEqual({ sent: 0, failed: 1, skipped: 0, retried: 1 });
    const q = db({
      notifications_claim_pending: [
        [
          { id: "n1", chat_id: "101", body: "1", attempts: 1 },
          { id: "n2", chat_id: "102", body: "2", attempts: 1 },
        ],
      ],
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TelegramSendError("Bot API sendMessage: TimeoutError", false))
      .mockRejectedValueOnce(new TelegramSendError("Bot API sendMessage: 403 Forbidden", false));
    const out = await bookingsDueProcessor(q, { sender: { send } }).processDue();
    expect(out.notifications).toEqual({ sent: 0, failed: 2, skipped: 0, retried: 0 });
    expect(notificationBackoffSec(1)).toBe(60);
    expect(notificationBackoffSec(3)).toBe(240);
    expect(notificationBackoffSec(20)).toBe(3600);
  });

  it("Bot API 429: короткий retry_after — ждёт и повторяет; длинный — retryable с retry_after; 5xx — retryable", async () => {
    const tooMany = (retryAfter: number) =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: retryAfter },
        }),
        { status: 429 },
      );
    const okResponse = () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    const sleep = vi.fn(async () => undefined);
    const shortWait = vi.fn().mockResolvedValueOnce(tooMany(2)).mockResolvedValueOnce(okResponse());
    await new BotApiTelegramSender("1:T", { fetch: shortWait as unknown as typeof fetch, sleep }).send(
      "1",
      "t",
    );
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(shortWait).toHaveBeenCalledTimes(2);

    const longWait = vi.fn().mockResolvedValue(tooMany(40));
    const err = await new BotApiTelegramSender("1:T", { fetch: longWait as unknown as typeof fetch, sleep })
      .send("1", "t")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramSendError);
    expect(err).toMatchObject({ retryable: true, retryAfterSec: 40 });
    expect(longWait).toHaveBeenCalledTimes(1);

    const down = vi.fn().mockResolvedValue(new Response("{}", { status: 502, statusText: "Bad Gateway" }));
    await expect(
      new BotApiTelegramSender("1:T", { fetch: down as unknown as typeof fetch }).send("1", "t"),
    ).rejects.toMatchObject({ retryable: true, retryAfterSec: null });
  });

  it("Bot API: таймаут и обрыв — не повторяются (могло дойти); отказ соединения и DNS — повторяются", async () => {
    const failWith = (err: Error) =>
      new BotApiTelegramSender("1:T", vi.fn().mockRejectedValue(err) as unknown as typeof fetch)
        .send("1", "t")
        .catch((e: unknown) => e);
    const fetchFailed = (code: string) =>
      Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    expect(await failWith(Object.assign(new Error("x"), { name: "TimeoutError" }))).toMatchObject({
      retryable: false,
    });
    expect(await failWith(fetchFailed("ECONNRESET"))).toMatchObject({ retryable: false });
    expect(await failWith(fetchFailed("ECONNREFUSED"))).toMatchObject({
      retryable: true,
      message: "Bot API sendMessage: TypeError ECONNREFUSED",
    });
    expect(await failWith(fetchFailed("ENOTFOUND"))).toMatchObject({ retryable: true });
  });

  it("Bot API: текст ошибки без токена", async () => {
    const fetchFn = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "TimeoutError" }));
    const sender = new BotApiTelegramSender("123:SECRET", fetchFn as unknown as typeof fetch);
    await expect(sender.send("1", "t")).rejects.toThrow(/^Bot API sendMessage: TimeoutError$/);
    const bad = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked" }), {
        status: 403,
      }),
    );
    await expect(
      new BotApiTelegramSender("123:SECRET", bad as unknown as typeof fetch).send("1", "t"),
    ).rejects.toThrow(/403 Forbidden: bot was blocked/);
    await expect(
      new BotApiTelegramSender("123:SECRET", bad as unknown as typeof fetch).send("1", "t"),
    ).rejects.toMatchObject({ retryable: false });
    expect(String(bad.mock.calls[0]![0])).toContain("/bot123:SECRET/sendMessage");
  });

  it("задача bookings.process-due: без БД — без ретраев; с БД — итог обработки", async () => {
    await expect(createHandlers({})["bookings.process-due"]({}, ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    const result = {
      expired: 2,
      completed: 1,
      reminded: 3,
      notifications: { sent: 4, failed: 1, skipped: 0, retried: 2 },
    };
    const processDue = vi.fn().mockResolvedValue(result);
    await expect(
      createHandlers({ bookings: { processDue } })["bookings.process-due"]({}, ctx),
    ).resolves.toEqual(result);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("не отправлено уведомлений — 1"));
  });
});

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

const EMPTY = { sent: 0, failed: 0, skipped: 0 };

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

  it("outbox воркера: только свои шаблоны; отправлено/ошибка — отметка итога; без бота — skipped", async () => {
    const claimed = [
      { id: "n1", chat_id: "101", body: "Бронювання №1" },
      { id: "n2", chat_id: "102", body: "Бронювання №2" },
    ];
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Bot API: 403"));
    const q = db({ notifications_claim_pending: [claimed] });
    const out = await bookingsDueProcessor(q, { sender: { send } }).processDue();
    expect(out.notifications).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(send).toHaveBeenNthCalledWith(1, "101", "Бронювання №1");
    const claim = q.query.mock.calls.find(([t]) => t.includes("notifications_claim_pending"))!;
    expect(claim[1]).toEqual([WORKER_NOTIFICATION_TEMPLATES, 100]);
    const marks = q.query.mock.calls.filter(([t]) => t.includes("notifications_mark_dispatched"));
    expect(marks.map(([, v]) => v)).toEqual([
      ["n1", "sent", null],
      ["n2", "failed", "Bot API: 403"],
    ]);

    const noBot = db({ notifications_claim_pending: [claimed.slice(0, 1)] });
    expect((await bookingsDueProcessor(noBot).processDue()).notifications).toEqual({
      sent: 0,
      failed: 0,
      skipped: 1,
    });
    expect(noBot.query.mock.calls.at(-1)![1]).toEqual(["n1", "skipped", "bot_not_configured"]);
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
      notifications: { sent: 4, failed: 1, skipped: 0 },
    };
    const processDue = vi.fn().mockResolvedValue(result);
    await expect(
      createHandlers({ bookings: { processDue } })["bookings.process-due"]({}, ctx),
    ).resolves.toEqual(result);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("не отправлено уведомлений — 1"));
  });
});

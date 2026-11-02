import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createSendMessageProcessor, MemoryOutbox, type Outbox } from "./queue/outbox.js";
import { BotApiClient } from "./telegram/bot-api.js";
import type { TgUpdate } from "./telegram/types.js";
import { handleUpdate } from "./update-handler.js";

function deps(over: { miniappBaseUrl?: string; miniappLink?: string } = {}) {
  const outbox = { sendMessage: vi.fn<Outbox["sendMessage"]>(async () => {}), close: vi.fn(async () => {}) };
  const startSink = { record: vi.fn(async () => {}) };
  const logger = { log: vi.fn(), warn: vi.fn() };
  return {
    outbox,
    startSink,
    logger,
    miniappBaseUrl: "https://m.example",
    miniappLink: undefined as string | undefined,
    botId: "123",
    ...over,
  };
}

const update = (text: string, chatType = "private"): TgUpdate => ({
  update_id: 100,
  message: { message_id: 1, chat: { id: 9, type: chatType }, from: { id: 77, language_code: "en" }, text },
});

describe("handleUpdate", () => {
  it("/start <payload> → контекст в sink и ответ в очередь (uk)", async () => {
    const d = deps();
    await handleUpdate(update("/start qr_1"), d);
    expect(d.startSink.record).toHaveBeenCalledWith({ telegramUserId: 77, payload: "qr_1", updateId: 100 });
    const [job, jobId] = d.outbox.sendMessage.mock.calls[0]!;
    expect(job.text).toMatch(/Гіді туриста/);
    expect(job.reply_markup?.inline_keyboard[0]?.[0]).toEqual({
      text: "Відкрити",
      web_app: { url: "https://m.example/?startapp=qr_1" },
    });
    expect(jobId).toBe("telegram.sendMessage__123-100");
  });

  it("невалидный payload: в sink не идёт, кнопка без startapp", async () => {
    const d = deps();
    await handleUpdate(update("/start bad/payload"), d);
    expect(d.startSink.record).not.toHaveBeenCalled();
    expect(d.outbox.sendMessage.mock.calls[0]![0].reply_markup?.inline_keyboard[0]?.[0]?.web_app?.url).toBe(
      "https://m.example/",
    );
  });

  it("TELEGRAM_MINIAPP_LINK → url-кнопка на прямую ссылку со startapp", async () => {
    const d = deps({ miniappLink: "https://t.me/TouristBot/app" });
    await handleUpdate(update("/start qr_1"), d);
    expect(d.outbox.sendMessage.mock.calls[0]![0].reply_markup?.inline_keyboard[0]?.[0]).toEqual({
      text: "Відкрити",
      url: "https://t.me/TouristBot/app?startapp=qr_1",
    });
  });

  it("PUBLIC_MINIAPP_URL по http → только текст, без reply_markup", async () => {
    const d = deps({ miniappBaseUrl: "http://localhost:4301" });
    await handleUpdate(update("/start qr_1"), d);
    expect(d.outbox.sendMessage.mock.calls[0]![0]).not.toHaveProperty("reply_markup");
  });

  it("не личный чат — без ответа", async () => {
    const d = deps();
    await handleUpdate(update("/start qr_1", "group"), d);
    expect(d.outbox.sendMessage).not.toHaveBeenCalled();
    expect(d.startSink.record).not.toHaveBeenCalled();
  });

  it("сбой sink не мешает ответу", async () => {
    const d = deps();
    d.startSink.record.mockRejectedValueOnce(new Error("down"));
    await handleUpdate(update("/start qr_1"), d);
    expect(d.outbox.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("не /start — пропуск без очереди; в логах нет текста и id", async () => {
    const d = deps();
    await handleUpdate(update("мій телефон +380501234567"), d);
    expect(d.outbox.sendMessage).not.toHaveBeenCalled();
    const logged = d.logger.log.mock.calls.flat().join("\n");
    expect(logged).toContain("update_id=100");
    expect(logged).not.toMatch(/380|телефон|77|\b9\b/);
  });

  it("логи /start не содержат payload и id пользователя", async () => {
    const d = deps();
    await handleUpdate(update("/start secretqr"), d);
    const logged = [...d.logger.log.mock.calls, ...d.logger.warn.mock.calls].flat().join("\n");
    expect(logged).not.toMatch(/secretqr|77/);
  });
});

describe("очередь и процессор", () => {
  it("MemoryOutbox выполняет задачу после возврата sendMessage", async () => {
    const process = vi.fn(async () => {});
    const outbox = new MemoryOutbox(process, { log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await outbox.sendMessage({ chat_id: 1, text: "x" });
    expect(process).not.toHaveBeenCalled();
    await outbox.close();
    expect(process).toHaveBeenCalledWith({ chat_id: 1, text: "x" });
  });

  it("процессор: 4xx Bot API → UnrecoverableError (без ретраев)", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: false, description: "Forbidden" }), { status: 403 }),
    );
    const run = createSendMessageProcessor(new BotApiClient({ token: "T", fetch: fetchMock }));
    await expect(run({ chat_id: 1, text: "x" })).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { parseEnv } from "@tg/server-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "./app.module.js";
import { botEnvSchema } from "./config.js";
import type { Outbox } from "./queue/outbox.js";

const SECRET = "test-secret-123";

describe("webhook /telegram/webhook", () => {
  let app: INestApplication;
  let url: string;
  const outbox = { sendMessage: vi.fn<Outbox["sendMessage"]>(async () => {}), close: vi.fn(async () => {}) };

  beforeEach(async () => {
    outbox.sendMessage.mockClear();
    const env = parseEnv("bot", botEnvSchema, {
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TELEGRAM_BOT_TOKEN: "123456:TEST",
      PUBLIC_MINIAPP_URL: "https://miniapp.example",
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env, outbox)] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, "127.0.0.1");
    url = `${await app.getUrl()}/telegram/webhook`;
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (body: unknown, secret?: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret !== undefined ? { "x-telegram-bot-api-secret-token": secret } : {}),
      },
      body: JSON.stringify(body),
    });

  const startUpdate = {
    update_id: 7,
    message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 5 }, text: "/start hotel_12" },
  };

  it("верный секрет → 200 и задача в очереди", async () => {
    const res = await post(startUpdate, SECRET);
    expect(res.status).toBe(200);
    expect(outbox.sendMessage).toHaveBeenCalledTimes(1);
    const [job, jobId] = outbox.sendMessage.mock.calls[0]!;
    expect(job.chat_id).toBe(42);
    expect(job.reply_markup?.inline_keyboard[0]?.[0]?.web_app?.url).toBe(
      "https://miniapp.example/?startapp=hotel_12",
    );
    expect(jobId).toBe("telegram.sendMessage__123456-7");
  });

  it("неверный секрет → 401 без подсказки, очередь не трогается", async () => {
    const res = await post(startUpdate, "wrong");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toMatch(/secret|секрет/i);
    expect(outbox.sendMessage).not.toHaveBeenCalled();
  });

  it("нет секрета → 401", async () => {
    const res = await post(startUpdate);
    expect(res.status).toBe(401);
    expect(outbox.sendMessage).not.toHaveBeenCalled();
  });

  it("невалидное тело → 200 без постановки (иначе Telegram повторяет)", async () => {
    const res = await post({ hello: "world" }, SECRET);
    expect(res.status).toBe(200);
    expect(outbox.sendMessage).not.toHaveBeenCalled();
  });

  it("очередь бросает → 500 (Telegram повторит доставку)", async () => {
    outbox.sendMessage.mockRejectedValueOnce(new Error("redis down"));
    const res = await post(startUpdate, SECRET);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("redis");
  });

  it("закрывает очередь при остановке", async () => {
    outbox.close.mockClear();
    await app.close();
    expect(outbox.close).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  JsonLogger,
  MetricsRegistry,
  REDACTED,
  createErrorTracker,
  parseSentryDsn,
  redact,
  redactString,
  runWithLogContext,
  setLogContext,
  SENTRY_MAX_PENDING,
} from "./index.js";

// Реалистичная Telegram initData (подпись и данные пользователя синтетические).
const INIT_DATA =
  "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vlad%22%2C%22phone%22%3A%22%2B380671234567%22%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2";
const PHONES = ["+380671234567", "+380 67 123 45 67", "380671234567", "(067) 123-45-67", "+1 (555) 123-4567"];

function capture(level: "info" | "debug" = "info") {
  const lines: string[] = [];
  const logger = new JsonLogger({ service: "test", level, write: (l) => lines.push(l) });
  return { logger, lines, entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("redactString", () => {
  it("скрывает Telegram initData целиком, в т.ч. URL-кодированную и в заголовке tma", () => {
    for (const s of [
      INIT_DATA,
      `initData=${encodeURIComponent(INIT_DATA)}`,
      `Authorization: tma ${INIT_DATA}`,
      `POST /auth/telegram body=${INIT_DATA} ok`,
    ]) {
      const out = redactString(s);
      expect(out).not.toMatch(/auth_date|hash=|279058397|c501b71e/);
      expect(out).toContain(REDACTED);
    }
  });

  it.each(PHONES)("скрывает телефон %s", (phone) => {
    const out = redactString(`звонок на ${phone} принят`);
    expect(out).toBe(`звонок на ${REDACTED} принят`);
  });

  it("скрывает e-mail, Bearer, JWT и токен бота; UUID, даты и числа не трогает", () => {
    const out = redactString(
      "user ivan.petrenko+x@example.com.ua Authorization: Bearer abc.def-123 jwt eyJhbGciOi.eyJzdWIiOjF9.sig " +
        "url https://api.telegram.org/bot1234567890:AAH1bcdEfgHIjklMNopqRSTuvwXYZ012345/sendMessage",
    );
    expect(out).not.toMatch(/ivan|abc\.def|eyJ|AAH1bcd/);
    const keep = "id 3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f at 2026-11-02T10:00:00Z took 1234 ms status 503";
    expect(redactString(keep)).toBe(keep);
  });
});

describe("redact", () => {
  it("скрывает значения секретных полей по имени и обходит вложенные объекты и Error", () => {
    const err = new Error("не дозвонились +380671234567");
    const out = redact({
      headers: { Authorization: "Bearer x", "x-telegram-init-data": "abc", cookie: "s=1" },
      user: { phone: "067", email: "a@b.cd", name: "ok" },
      initData: "raw",
      err,
    }) as Record<string, Record<string, unknown>>;
    expect(out.headers).toEqual({
      Authorization: REDACTED,
      "x-telegram-init-data": REDACTED,
      cookie: REDACTED,
    });
    expect(out.user).toEqual({ phone: REDACTED, email: REDACTED, name: "ok" });
    expect(out.initData).toBe(REDACTED);
    expect(JSON.stringify(out.err)).not.toContain("380671234567");
  });
});

describe("JsonLogger", () => {
  it("пишет одну JSON-строку с service, level, context, correlationId и region_id из контекста", () => {
    const { logger, entries } = capture();
    runWithLogContext({ correlationId: "req-1" }, () => {
      setLogContext({ regionId: "reg-7" });
      logger.log("привет", "Http");
    });
    logger.warn("вне запроса");
    const [a, b] = entries();
    expect(a).toMatchObject({
      level: "info",
      service: "test",
      context: "Http",
      msg: "привет",
      correlationId: "req-1",
      region_id: "reg-7",
    });
    expect(b).toMatchObject({ level: "warn", msg: "вне запроса" });
    expect(b).not.toHaveProperty("correlationId");
  });

  it("в логах нет initData, телефонов, e-mail и токенов (сообщение, stack, поля объекта)", () => {
    const { logger, lines } = capture();
    const err = new Error(`initData ${INIT_DATA}`);
    logger.error(`Ошибка для ${PHONES[0]} и ivan@example.com`, err.stack, "Auth");
    logger.log({ msg: "запрос", headers: { authorization: `tma ${INIT_DATA}` }, body: { phone: PHONES[1] } });
    logger.warn(err);
    for (const phone of PHONES) logger.log(`телефон ${phone}`);
    const all = lines.join("\n");
    expect(all).not.toMatch(/auth_date|hash=|279058397|ivan@example|tma query/);
    for (const phone of PHONES) expect(all).not.toContain(phone);
    expect(all.replace(/\D/g, " ")).not.toMatch(/380671234567|0671234567/);
  });

  it("уважает уровень: debug не пишется при info", () => {
    const { logger, lines } = capture("info");
    logger.debug("тихо");
    logger.verbose("тихо");
    expect(lines).toHaveLength(0);
  });
});

describe("error tracker", () => {
  it("без DSN — только лог, сеть не вызывается", async () => {
    const { logger, entries } = capture();
    const fetchFn = vi.fn();
    const tracker = createErrorTracker({ service: "api", environment: "local", logger, fetchFn });
    runWithLogContext({ correlationId: "c-1" }, () =>
      tracker.captureException(new Error("boom +380671234567")),
    );
    await tracker.flush();
    expect(fetchFn).not.toHaveBeenCalled();
    const [e] = entries();
    expect(e).toMatchObject({ level: "error", correlationId: "c-1", errorTracker: true });
    expect(JSON.stringify(e)).not.toContain("380671234567");
  });

  it("с DSN — отправляет envelope в Sentry с correlationId, без ПДн", async () => {
    const { logger } = capture();
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const tracker = createErrorTracker({
      service: "worker",
      environment: "staging",
      dsn: "https://pubkey@o1.ingest.sentry.io/42",
      logger,
      fetchFn,
    });
    runWithLogContext({ correlationId: "c-2", regionId: "r-1" }, () =>
      tracker.captureException(new Error("fail for a@b.cd")),
    );
    await tracker.flush();
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe("https://o1.ingest.sentry.io/api/42/envelope/");
    expect(init.headers["X-Sentry-Auth"]).toContain("sentry_key=pubkey");
    expect(init.body).toContain('"correlationId":"c-2"');
    expect(init.body).toContain('"region_id":"r-1"');
    expect(init.body).not.toContain("a@b.cd");
  });

  it("некорректный DSN → трекер в лог", () => {
    expect(parseSentryDsn("https://o1.ingest.sentry.io/42")).toBeUndefined();
    expect(parseSentryDsn("не url")).toBeUndefined();
  });
});

describe("MetricsRegistry", () => {
  it("рендерит counter, gauge и histogram в формате Prometheus", () => {
    const reg = new MetricsRegistry();
    reg.counter("http_requests_total", "Запросы").inc({ method: "GET", route: "/health", status: "200" });
    reg.gauge("queue_jobs", "Задачи").set({ queue: "system", state: "waiting" }, 3);
    const h = reg.histogram("http_request_duration_seconds", "Длительность", [0.1, 1]);
    h.observe({ route: "/health" }, 0.05);
    h.observe({ route: "/health" }, 0.5);
    const text = reg.render();
    expect(text).toContain("# TYPE http_requests_total counter");
    expect(text).toContain('http_requests_total{method="GET",route="/health",status="200"} 1');
    expect(text).toContain('queue_jobs{queue="system",state="waiting"} 3');
    expect(text).toContain('http_request_duration_seconds_bucket{route="/health",le="0.1"} 1');
    expect(text).toContain('http_request_duration_seconds_bucket{route="/health",le="+Inf"} 2');
    expect(text).toContain('http_request_duration_seconds_count{route="/health"} 2');
    expect(reg.counter("http_requests_total", "x")).toBe(reg.counter("http_requests_total", "y"));
  });
});

describe("устойчивость маскирования (ReDoS, даты, бинарные данные)", () => {
  it.each([
    ["a", "a".repeat(100_000)],
    ["цифры", "1".repeat(100_000)],
    ["eyJ", "eyJ.".repeat(25_000)],
    ["eyJ-", "eyJ-".repeat(25_000)],
    ["e-mail", "a.".repeat(50_000) + "@"],
    ["initData", "x".repeat(100_000) + "hash"],
    ["кириллица", "ж".repeat(100_000)],
    ["цифры с разделителями", "1-".repeat(50_000)],
  ])("100 КБ без пробелов (%s) — быстрее 50 мс", (_name, s) => {
    const start = performance.now();
    const out = redactString(s);
    expect(performance.now() - start).toBeLessThan(50);
    expect(out.length).toBeLessThanOrEqual(16_384 + 20);
  });

  it.each([
    "Номер 380671234567: не найден",
    "phone:380671234567",
    "tel:0671234567",
    "GET /users/380671234567/profile",
    "380671234567/0671234567",
  ])("маскирует телефон в %s", (s) => {
    expect(redactString(s)).not.toMatch(/\d{10}/);
  });

  it("initData на границе обрезки не остаётся видимой", () => {
    const s =
      "x ".repeat(8_190) + "query_id=AAH&user=%7B%22id%22%3A279058397%7D&auth_date=1&hash=" + "a".repeat(64);
    const out = redactString(s);
    expect(out).not.toMatch(/query_id|279058397/);
  });

  it("длинная строка обрезается с пометкой", () => {
    expect(redactString("a".repeat(20_000))).toMatch(/…\[truncated]$/);
  });

  it.each([
    "2026-11-02 10:00:00",
    "2026-11-02T10:00:00.000Z",
    "10:00:00 02.11.2026",
    "v1.2.3.4.5.6.7.8.9.10",
  ])("не маскирует дату/время/версию %s", (s) => expect(redactString(s)).toBe(s));

  it("Buffer → [Binary n], геттер с ошибкой → [Unreadable], ключи ограничены", () => {
    const obj = {
      buf: Buffer.from("+380671234567"),
      get bad(): string {
        throw new Error("x");
      },
    };
    expect(redact(obj)).toEqual({ buf: "[Binary 13]", bad: "[Unreadable]" });
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i]));
    const out = redact(many) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(101);
  });

  it("объект-сообщение не подменяет служебные поля; context маскируется", () => {
    const { logger, entries } = capture();
    logger.log({ msg: "x", level: "fatal", service: "evil", time: "0" });
    logger.error("ошибка", "Error: at user +380671234567");
    const [a, b] = entries();
    expect(a).toMatchObject({ level: "info", service: "test" });
    expect(a?.time).not.toBe("0");
    expect(JSON.stringify(b)).not.toContain("380671234567");
  });
});

describe("Sentry: таймаут, предел, сбои", () => {
  const dsn = "https://pubkey@o1.ingest.sentry.io/42";

  it("передаёт AbortSignal; отклонённый fetch не роняет и не держит flush", async () => {
    const { logger } = capture();
    const fetchFn = vi.fn().mockRejectedValue(new Error("network"));
    const tracker = createErrorTracker({ service: "api", environment: "local", dsn, logger, fetchFn });
    tracker.captureException(new Error("a"));
    await tracker.flush(100);
    const init = fetchFn.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("зависший fetch: flush ограничен таймаутом; сверх SENTRY_MAX_PENDING — только лог", async () => {
    const { logger, lines } = capture();
    const fetchFn = vi.fn().mockReturnValue(new Promise(() => {}));
    const tracker = createErrorTracker({ service: "api", environment: "local", dsn, logger, fetchFn });
    for (let i = 0; i < SENTRY_MAX_PENDING + 5; i++) tracker.captureException(new Error(`e${i}`));
    expect(fetchFn).toHaveBeenCalledTimes(SENTRY_MAX_PENDING);
    expect(lines).toHaveLength(SENTRY_MAX_PENDING + 5);
    const start = Date.now();
    await tracker.flush(50);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("DSN с префиксом пути", () => {
    expect(parseSentryDsn("https://k@sentry.example.com/sub/path/7")?.envelopeUrl).toBe(
      "https://k@sentry.example.com/sub/path/api/7/envelope/".replace("k@", ""),
    );
  });
});

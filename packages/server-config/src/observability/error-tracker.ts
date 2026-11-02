import { randomUUID } from "node:crypto";
import { currentLogContext } from "./log-context.js";
import { redact, redactString } from "./redact.js";

/** Доп. сведения об ошибке: только технические поля (без ПДн; всё равно проходят redact). */
export type ErrorTags = Record<string, string | number | boolean | null | undefined>;

/**
 * Трекер ошибок (T1-18). По умолчанию — «в лог»; внешний трекер (Sentry) — только при заданном DSN.
 * correlationId / region_id / jobId берутся из контекста логов.
 */
export interface ErrorTracker {
  captureException(error: unknown, tags?: ErrorTags): void;
  /** Дождаться отправки (при остановке процесса). */
  flush(timeoutMs?: number): Promise<void>;
}

interface MinimalLogger {
  error(message: unknown, ...rest: unknown[]): void;
}

/** Трекер «в лог»: пишет ошибку уровнем error с тегами. Ничего не отправляет наружу. */
export class LogErrorTracker implements ErrorTracker {
  constructor(private readonly logger: MinimalLogger) {}
  captureException(error: unknown, tags?: ErrorTags): void {
    this.logger.error({
      msg: "Ошибка зафиксирована трекером",
      errorTracker: true,
      err: redact(error),
      tags: redact(tags),
    });
  }
  async flush(): Promise<void> {}
}

/**
 * Части Sentry DSN `https://<key>@<host>[/<path>]/<projectId>` (префикс пути — self-hosted за прокси);
 * некорректный DSN → undefined.
 */
export function parseSentryDsn(dsn: string): { key: string; envelopeUrl: string } | undefined {
  try {
    const u = new URL(dsn);
    const parts = u.pathname.split("/").filter(Boolean);
    const projectId = parts.pop();
    if (!u.username || !projectId || !/^https?:$/.test(u.protocol)) return undefined;
    const prefix = parts.length > 0 ? `/${parts.join("/")}` : "";
    return { key: u.username, envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/` };
  } catch {
    return undefined;
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<unknown>;

/** Таймаут одной отправки и предел одновременных отправок (сверх — событие только в лог). */
export const SENTRY_TIMEOUT_MS = 5000;
export const SENTRY_MAX_PENDING = 20;

/**
 * Минимальный клиент Sentry без SDK (envelope API по HTTP): событие с exception, тегами, окружением.
 * Сообщения и стеки маскируются. Ошибка отправки не роняет процесс; событие всегда пишется и в лог.
 */
export class SentryErrorTracker implements ErrorTracker {
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly dsn: { key: string; envelopeUrl: string },
    private readonly opts: { service: string; environment: string; release?: string },
    private readonly fallback: ErrorTracker,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {}

  captureException(error: unknown, tags?: ErrorTags): void {
    this.fallback.captureException(error, tags);
    // Трекер недоступен/медленный: не копим запросы и память — событие уже в логе.
    if (this.pending.size >= SENTRY_MAX_PENDING) return;
    const ctx = currentLogContext();
    const err = error instanceof Error ? error : new Error(String(error));
    const eventId = randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      environment: this.opts.environment,
      ...(this.opts.release ? { release: this.opts.release } : {}),
      server_name: this.opts.service,
      tags: redact({
        service: this.opts.service,
        correlationId: ctx?.correlationId,
        region_id: ctx?.regionId ?? undefined,
        jobId: ctx?.jobId,
        ...tags,
      }),
      exception: { values: [{ type: err.name, value: redactString(err.message) }] },
      extra: { stack: err.stack ? redactString(err.stack) : undefined },
    };
    const body = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");
    const p = this.fetchFn(this.dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${this.dsn.key}, sentry_client=tg-min/0.1`,
      },
      body,
      signal: AbortSignal.timeout(SENTRY_TIMEOUT_MS),
    }).catch(() => undefined);
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async flush(timeoutMs = 2000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([...this.pending]),
      new Promise((r) => {
        timer = setTimeout(r, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }
}

/**
 * Необработанные ошибки процесса → трекер, flush (до 2 с) и выход с кодом 1. Вызывается из main.ts.
 * `exit` подменяют тесты.
 */
export function installProcessErrorHandlers(
  tracker: ErrorTracker,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let exiting = false;
  const handle = (kind: string) => (err: unknown) => {
    tracker.captureException(err, { kind });
    if (exiting) return;
    exiting = true;
    void tracker.flush(2000).finally(() => exit(1));
  };
  process.on("uncaughtException", handle("uncaughtException"));
  process.on("unhandledRejection", handle("unhandledRejection"));
}

/** Трекер по env: SENTRY_DSN задан и корректен → Sentry (+ лог), иначе только лог — наружу ничего не уходит. */
export function createErrorTracker(opts: {
  service: string;
  environment: string;
  dsn?: string;
  release?: string;
  logger: MinimalLogger;
  fetchFn?: FetchLike;
}): ErrorTracker {
  const fallback = new LogErrorTracker(opts.logger);
  const dsn = opts.dsn ? parseSentryDsn(opts.dsn) : undefined;
  if (!dsn) return fallback;
  return new SentryErrorTracker(
    dsn,
    {
      service: opts.service,
      environment: opts.environment,
      ...(opts.release ? { release: opts.release } : {}),
    },
    fallback,
    opts.fetchFn,
  );
}

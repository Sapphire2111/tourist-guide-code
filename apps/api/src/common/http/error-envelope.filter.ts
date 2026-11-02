import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { ErrorTracker } from "@tg/server-config";
import { ERROR_HTTP_STATUS, ERROR_MESSAGE_KEYS, type ErrorCode, type ErrorEnvelope } from "@tg/shared";
import { randomUUID } from "node:crypto";
import { ApiError } from "./api-error.js";
import { actorLogSuffix, type HttpRequest, type HttpResponse } from "./correlation-id.js";

const CODE_BY_STATUS = new Map<number, ErrorCode>([
  [400, "BAD_REQUEST"],
  [401, "UNAUTHENTICATED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [409, "CONFLICT"],
  [422, "UNPROCESSABLE"],
  [429, "RATE_LIMITED"],
  [502, "BAD_GATEWAY"],
  [503, "SERVICE_UNAVAILABLE"],
  [504, "GATEWAY_TIMEOUT"],
]);

/**
 * HTTP-статус ошибки: HttpException или 4xx от body-parser/http-errors (битый JSON, 413) —
 * они помечены `expose: true` или `type: "entity.*"`. Прочие ошибки со `status` статуса не задают.
 */
function statusOf(e: unknown): number | undefined {
  if (e instanceof HttpException) return e.getStatus();
  const { status, expose, type } = (e ?? {}) as { status?: unknown; expose?: unknown; type?: unknown };
  const fromBodyParser = expose === true || (typeof type === "string" && type.startsWith("entity."));
  return fromBodyParser && typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

/** Ответ-ошибка без correlationId: HTTP-статус и тело `error` конверта. */
export type ErrorResponse = {
  status: number;
  code: ErrorCode;
  messageKey: string;
  details?: ErrorEnvelope["error"]["details"];
};

/**
 * Во что фильтр превращает исключение: неизвестные ошибки и 5xx без кода → 500 INTERNAL. Общая для фильтра и
 * idempotency-интерсептора (T1-14), который сохраняет 4xx-ответ для повтора.
 */
export function toErrorResponse(exception: unknown): ErrorResponse {
  let status = statusOf(exception) ?? ERROR_HTTP_STATUS.INTERNAL;
  let code: ErrorCode = CODE_BY_STATUS.get(status) ?? (status < 500 ? "BAD_REQUEST" : "INTERNAL");
  let messageKey = ERROR_MESSAGE_KEYS[code];
  let details: ErrorEnvelope["error"]["details"];
  if (exception instanceof ApiError) ({ code, messageKey, details } = exception);
  if (code === "INTERNAL") status = ERROR_HTTP_STATUS.INTERNAL;
  return details === undefined ? { status, code, messageKey } : { status, code, messageKey, details };
}

/**
 * Глобальный фильтр: любая ошибка → `{ error: { code, messageKey, details?, correlationId } }`.
 * Неизвестные ошибки и 5xx → 500 INTERNAL без сообщения и стека в ответе (стек — только в лог).
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger("HTTP");

  /** tracker — трекер ошибок (T1-18): получает необработанные 500 INTERNAL; без него — только лог. */
  constructor(private readonly tracker?: ErrorTracker) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();
    const correlationId = req.correlationId ?? randomUUID();

    const { status, code, messageKey, details } = toErrorResponse(exception);
    if (status >= 500) {
      const stack = exception instanceof Error ? exception.stack : String(exception);
      const cause = exception instanceof Error && exception.cause !== undefined ? exception.cause : undefined;
      // Одна запись на 500: с трекером — его запись (LogErrorTracker пишет в лог со стеком), без — logger.error.
      if (code === "INTERNAL") {
        if (this.tracker)
          this.tracker.captureException(exception, {
            correlationId,
            status,
            actor: actorLogSuffix(req).trim() || undefined,
          });
        else
          this.logger.error(
            `Необработанная ошибка correlationId=${correlationId}${actorLogSuffix(req)}`,
            stack,
          );
      }
      // 502/503/504 — ожидаемые отказы внешних сервисов: warn со стеком и причиной, чтобы найти по correlationId.
      else
        this.logger.warn(
          `${code} correlationId=${correlationId}${actorLogSuffix(req)}`,
          stack,
          ...(cause === undefined ? [] : [cause]),
        );
    }

    // Ответ уже начат (поток/SSE оборвался на середине) — второй ответ не отправить: только лог выше,
    // и ответ закрывается, чтобы клиент не ждал вечно.
    if (res.headersSent) {
      if (status < 500) this.logger.warn(`${code} после отправки заголовков correlationId=${correlationId}`);
      res.end?.();
      return;
    }
    const body: ErrorEnvelope = { error: { code, messageKey, correlationId } };
    if (details !== undefined) body.error.details = details;
    res.status(status).json(body);
  }
}

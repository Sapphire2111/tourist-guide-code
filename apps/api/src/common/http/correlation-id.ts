import { randomUUID } from "node:crypto";
import { runWithLogContext } from "@tg/server-config";
import { CORRELATION_ID_HEADER } from "@tg/shared";

// Минимальные структурные типы запроса/ответа Express (без зависимости от @types/express).
export type HttpRequest = {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  /** Принципал запроса (сессия, T1-26) — в логи: id пользователя и сессии, без токена и ПДн. */
  principal?: { readonly userId: string; readonly sessionId?: string };
};

/** Актор запроса для строки лога: ` actor=user:<id> session=<id>` или пусто (анонимный запрос). */
export function actorLogSuffix(req: Pick<HttpRequest, "principal">): string {
  const p = req.principal;
  if (!p) return "";
  return ` actor=user:${p.userId}${p.sessionId ? ` session=${p.sessionId}` : ""}`;
}
export type HttpResponse = {
  setHeader(name: string, value: string): unknown;
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
  headersSent?: boolean;
  end?(): unknown;
};

// Клиентский id принимаем, только если он короткий и из безопасных символов (защита логов от инъекций).
const SAFE_ID = /^[\w.:-]{1,128}$/;

/**
 * Express-middleware: correlation id из `X-Request-Id` либо новый UUID; кладётся в req и в заголовок ответа.
 * Дальнейшая обработка идёт в контексте логов (T1-18): JSON-логгер и трекер ошибок добавляют correlationId сами.
 */
export function correlationIdMiddleware(req: HttpRequest, res: HttpResponse, next: () => void): void {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const id = typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.correlationId = id;
  res.setHeader(CORRELATION_ID_HEADER, id);
  runWithLogContext({ correlationId: id }, next);
}

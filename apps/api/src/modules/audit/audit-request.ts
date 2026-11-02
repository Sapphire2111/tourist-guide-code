import type { AuditEntry } from "./audit.service.js";

/** Поля HTTP-запроса, из которых берётся актор аудита (структурно: принципал — RBAC/сессия, T1-12/T1-26). */
export type AuditableRequest = {
  principal?: { readonly userId: string; readonly sessionId?: string };
  authorization?: { readonly grant: { readonly id: string } };
  correlationId?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * Актор и контекст записи аудита из запроса с сессией: пользователь-принципал, назначение роли из
 * @RequirePermission (`req.authorization`), correlation id, ПДн-часть (IP, user agent, id сессии — хранятся по
 * сроку D-73). Обработчик дополняет action/entity/old/new: `audit.record(trx, { ...auditFromRequest(req), … })`.
 * Без принципала — ошибка: действие от имени пользователя на эндпоинте без аутентификации — ошибка конфигурации.
 */
export function auditFromRequest(
  req: AuditableRequest,
): Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii"> {
  const principal = req.principal;
  if (!principal)
    throw new Error(
      "auditFromRequest: у запроса нет принципала (эндпоинт без @RequirePermission/@RequireAuth)",
    );
  const ua = req.headers["user-agent"];
  return {
    actor: { type: "user", userId: principal.userId },
    roleAssignmentId: req.authorization?.grant.id ?? null,
    requestId: req.correlationId ?? null,
    pii: {
      ip: req.ip ?? null,
      userAgent: typeof ua === "string" ? ua : null,
      sessionId: principal.sessionId ?? null,
    },
  };
}

import type { RbacRequest } from "../rbac/index.js";
import type { RequestMeta } from "./session.service.js";

/** Поля Express-запроса, нужные эндпоинтам аутентификации (без зависимости от @types/express). */
export type AuthRequest = RbacRequest & {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  correlationId?: string;
};

/** Correlation id, IP и user agent запроса — для аудита (ПДн-часть хранится по сроку D-73). */
export function requestMeta(req: AuthRequest): RequestMeta {
  const ua = req.headers["user-agent"];
  return {
    requestId: req.correlationId ?? null,
    ip: req.ip ?? null,
    userAgent: typeof ua === "string" ? ua : null,
  };
}

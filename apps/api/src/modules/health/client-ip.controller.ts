import { Controller, Get, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { SkipRateLimit } from "../rate-limit/index.js";

/** Поля Express-запроса, нужные диагностике (без зависимости от @types/express). */
type ClientIpRequest = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  ips: string[];
  socket: { remoteAddress?: string };
};

/**
 * Диагностика trust proxy (T1-24, ADR-0012): какой адрес api считает адресом клиента и какую цепочку
 * X-Forwarded-For прислали прокси платформы. Нужна, чтобы подобрать TRUST_PROXY_HOPS на Render.
 * Подключается только вне prod (ClientIpDiagnosticsModule.forRoot), в OpenAPI не попадает. Отдаёт только адреса самого
 * вызывающего и прокси — без данных других пользователей.
 */
@ApiExcludeController()
@WithoutTenantContext()
@SkipRateLimit()
@Controller("health/client-ip")
export class ClientIpController {
  @Get()
  get(@Req() req: ClientIpRequest): {
    ip: string | undefined;
    ips: string[];
    forwardedFor: string | null;
    remoteAddress: string | null;
  } {
    const xff = req.headers["x-forwarded-for"];
    return {
      ip: req.ip,
      ips: req.ips,
      forwardedFor: Array.isArray(xff) ? xff.join(", ") : (xff ?? null),
      remoteAddress: req.socket.remoteAddress ?? null,
    };
  }
}

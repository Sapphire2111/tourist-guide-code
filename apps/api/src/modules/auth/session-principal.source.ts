import { Inject, Injectable, type ExecutionContext } from "@nestjs/common";
import type { Principal, PrincipalSource } from "../rbac/index.js";
import { bearerToken, hashSessionToken } from "./session-token.js";
import { SessionsRepository } from "./sessions.repository.js";

type HeadersRequest = { headers: Record<string, string | string[] | undefined> };

/**
 * Принципал запроса из сессии (T1-26): `Authorization: Bearer <токен>` → действующая сессия по sha256 токена →
 * `{ userId, sessionId, regionId }`. Нет заголовка, чужой формат, сессия истекла/отозвана, пользователь не active —
 * undefined (запрос анонимный; защищённые эндпоинты — 401). Ошибка БД — исключение (500): без проверки не пускаем.
 * Вызывается один раз на запрос глобальным PrincipalGuard (RBAC) до интерсепторов — вне транзакции запроса.
 *
 * Точка расширения: другие способы входа (initData Telegram — блок 2, админка + 2FA — блок 6) не меняют этот
 * источник — они выдают ту же сессию через SessionService.issue() с своим channel.
 */
@Injectable()
export class SessionPrincipalSource implements PrincipalSource {
  constructor(@Inject(SessionsRepository) private readonly sessions: SessionsRepository) {}

  async resolve(context: ExecutionContext): Promise<Principal | undefined> {
    if (context.getType() !== "http") return undefined;
    const req = context.switchToHttp().getRequest<HeadersRequest>();
    const token = bearerToken(req.headers.authorization);
    if (token === undefined) return undefined;
    const session = await this.sessions.findActiveByTokenHash(hashSessionToken(token));
    if (!session) return undefined;
    return { userId: session.userId, sessionId: session.id, regionId: session.activeRegionId };
  }
}

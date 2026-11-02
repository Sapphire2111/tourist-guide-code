import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  InjectDb,
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
  type Session,
  type SessionChannel,
} from "../../db/index.js";
import { AuditService } from "../audit/index.js";
import { decideTenant, isRoleCode, RbacService, type Grant } from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import { UsersRepository } from "../users/index.js";
import { generateSessionToken, hashSessionToken } from "./session-token.js";
import { SessionsRepository } from "./sessions.repository.js";

/** Срок жизни сессии по умолчанию, часов (AUTH_SESSION_TTL_HOURS): Mini App перевыпускает её по initData при запуске. */
export const DEFAULT_SESSION_TTL_HOURS = 24;

/** DI-токен срока жизни сессии в секундах. */
export const SESSION_TTL_SECONDS = Symbol("SESSION_TTL_SECONDS");

/** Данные запроса для аудита (ПДн-часть: IP, user agent — хранятся по сроку D-73). */
export type RequestMeta = {
  readonly requestId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
};

/** Отказ в выдаче или смене региона сессии; HTTP-код выбирает эндпоинт. */
export class SessionError extends Error {
  override readonly name = "SessionError";
  constructor(
    readonly reason: "user_not_active" | "region_not_allowed" | "region_not_found" | "not_found",
    message?: string,
  ) {
    super(message ?? reason);
  }
}

export type IssuedSession = {
  /** Токен — только в ответ клиенту, один раз. */
  readonly token: string;
  readonly session: Session;
};

/**
 * Сессии (T1-26, ADR-0009): выдача после проверки личности способом входа (local — dev-вход; блок 2 — initData
 * Telegram, `POST /auth/telegram`), отзыв, выбор региона режима. Выдача и отзыв — в одной транзакции с записью
 * аудита (`auth.session.create` / `auth.session.revoke`, регион NULL — SYSTEM-контекст: сессия не принадлежит
 * региону). Вызывать вне withTenant() — эндпоинты аутентификации помечены @WithoutTenantContext.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger("Auth");

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(SESSION_TTL_SECONDS) private readonly ttlSeconds: number,
  ) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60)
      throw new Error(`Срок жизни сессии — целое число секунд ≥ 60, получено ${ttlSeconds}`);
  }

  /**
   * Новая сессия пользователя. Личность уже проверена вызывающим (способ входа). Пользователь должен быть active;
   * выбранный регион — только с назначением роли в нём или на PLATFORM (как decideTenant), иначе SessionError;
   * несуществующий регион (возможен только при PLATFORM) — SessionError region_not_found.
   */
  async issue(input: {
    userId: string;
    channel: SessionChannel;
    activeRegionId?: string | null;
    meta?: RequestMeta;
  }): Promise<IssuedSession> {
    const activeRegionId = input.activeRegionId?.toLowerCase() ?? null;
    if (activeRegionId !== null) await this.assertRegionAllowed(input.userId, activeRegionId);
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const session = await withTenant(this.db, SYSTEM_CONTEXT, async (trx) => {
      const user = await this.users.findById(input.userId);
      if (user?.status !== "active") throw new SessionError("user_not_active");
      const created = await this.sessions.create({
        user_id: input.userId,
        token_hash: hashSessionToken(token),
        channel: input.channel,
        active_region_id: activeRegionId,
        expires_at: expiresAt,
      });
      await this.audit.record(trx, {
        actor: { type: "user", userId: input.userId },
        action: "auth.session.create",
        entityType: "session",
        entityId: created.id,
        newValues: {
          channel: created.channel,
          expiresAt: created.expires_at.toISOString(),
          activeRegionId: created.active_region_id,
        },
        requestId: input.meta?.requestId ?? null,
        pii: { ip: input.meta?.ip, userAgent: input.meta?.userAgent, sessionId: created.id },
      });
      return created;
    });
    this.logger.log(
      `Сессия выдана: session=${session.id} user=${session.user_id} channel=${session.channel}`,
    );
    return { token, session };
  }

  /** Отзыв сессии её владельцем (выход). Уже отозванная — без изменений и без аудита; возвращает, была ли отозвана. */
  async revoke(input: { sessionId: string; userId: string; meta?: RequestMeta }): Promise<boolean> {
    const revoked = await withTenant(this.db, SYSTEM_CONTEXT, async (trx) => {
      const session = await this.sessions.findById(input.sessionId);
      if (session?.user_id !== input.userId) return undefined;
      const row = await this.sessions.revoke(input.sessionId, "logout");
      if (!row) return undefined;
      await this.audit.record(trx, {
        actor: { type: "user", userId: input.userId },
        action: "auth.session.revoke",
        entityType: "session",
        entityId: row.id,
        newValues: { reason: row.revoke_reason },
        requestId: input.meta?.requestId ?? null,
        pii: { ip: input.meta?.ip, userAgent: input.meta?.userAgent, sessionId: row.id },
      });
      return row;
    });
    if (revoked)
      this.logger.log(`Сессия отозвана: session=${revoked.id} user=${revoked.user_id} reason=logout`);
    return revoked !== undefined;
  }

  /**
   * Выбор региона режима партнёра/админа (D-50) в сессии: null — снять выбор. Регион без назначения роли в нём
   * (и без PLATFORM) — SessionError region_not_allowed; несуществующий — region_not_found.
   */
  async selectRegion(input: {
    sessionId: string;
    userId: string;
    regionId: string | null;
  }): Promise<Session> {
    const regionId = input.regionId?.toLowerCase() ?? null;
    if (regionId !== null) await this.assertRegionAllowed(input.userId, regionId);
    const session = await this.sessions.findById(input.sessionId);
    if (session?.user_id !== input.userId) throw new SessionError("not_found");
    const updated = await this.sessions.setActiveRegion(input.sessionId, regionId);
    if (!updated) throw new SessionError("not_found");
    return updated;
  }

  /** Сессия владельца (для GET /auth/session). */
  async find(sessionId: string, userId: string): Promise<Session | undefined> {
    const session = await this.sessions.findById(sessionId);
    return session?.user_id === userId ? session : undefined;
  }

  /** Действующие назначения ролей из реестра (роль не из реестра прав не даёт — её не показываем). */
  async grantsOf(userId: string): Promise<Grant[]> {
    return (await this.rbac.grantsOf(userId)).filter((g) => isRoleCode(g.role));
  }

  /**
   * Регион разрешён назначениями (как decideTenant) и существует. Сначала права: без них — 403 и о существовании
   * региона не сообщаем. При PLATFORM decideTenant пускает любой uuid — без проверки в regions несуществующий
   * регион дошёл бы до FK sessions.active_region_id (23503 → 500). Регионы не удаляются (только suspend), поэтому
   * проверка до записи не гоняется с удалением.
   */
  private async assertRegionAllowed(userId: string, regionId: string): Promise<void> {
    const decision = decideTenant(await this.rbac.grantsOf(userId), regionId, new Date());
    if ("denied" in decision) throw new SessionError("region_not_allowed");
    if (!(await this.regions.findById(regionId))) throw new SessionError("region_not_found");
  }
}

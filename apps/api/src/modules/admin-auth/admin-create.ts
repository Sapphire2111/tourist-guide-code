// Создание учётки админа (CLI `pnpm --filter @tg/api admin:create`, ADR-0018): пользователь, учётка входа и
// назначение роли через RoleAssignmentService (аудит role.assign) — в одной транзакции SYSTEM.
import { SYSTEM_CONTEXT, withTenant, type Db } from "../../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../audit/index.js";
import { PLATFORM_SCOPE, regionScope, ScopeHierarchy, type ScopeRef } from "../rbac/index.js";
import { RoleAssignmentService } from "../role-assignments/index.js";
import { ADMIN_CREDENTIAL_ENTITY, ADMIN_LOGIN_RE, normalizeLogin } from "./admin-auth.service.js";
import { AdminCredentialsRepository } from "./admin-credentials.repository.js";
import {
  hashPassword,
  isAcceptablePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "./password-hash.js";

/** Роли, которые создаёт CLI: SUPERADMIN — на PLATFORM, остальные — на регион (--region <code>). */
export const ADMIN_CLI_ROLES = ["SUPERADMIN", "REGION_ADMIN", "MODERATOR"] as const;
export type AdminCliRole = (typeof ADMIN_CLI_ROLES)[number];

export type AdminCreateArgs = { login: string; role: AdminCliRole; regionCode: string | null };

export class AdminCreateError extends Error {
  override readonly name = "AdminCreateError";
}

/**
 * Аргументы CLI: `--login <логин> --role SUPERADMIN|REGION_ADMIN|MODERATOR [--region <код>]` (и `--x=y`).
 * Пароль аргументом не принимается (попал бы в историю оболочки и список процессов) — только stdin или
 * ADMIN_PASSWORD.
 */
export function parseAdminCreateArgs(argv: readonly string[]): AdminCreateArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    const eq = /^--([a-z]+)=(.*)$/.exec(a);
    const flag = eq ? eq[1]! : /^--([a-z]+)$/.exec(a)?.[1];
    if (!flag) throw new AdminCreateError(`admin:create: неизвестный аргумент ${a}`);
    if (flag === "password")
      throw new AdminCreateError(
        "admin:create: пароль аргументом не принимается — передайте его через stdin или ADMIN_PASSWORD",
      );
    if (!["login", "role", "region"].includes(flag))
      throw new AdminCreateError(`admin:create: неизвестный аргумент --${flag}`);
    const value = eq ? eq[2]! : argv[++i];
    if (value === undefined || value.startsWith("--"))
      throw new AdminCreateError(`admin:create: у --${flag} нет значения`);
    args.set(flag, value);
  }
  const login = normalizeLogin(args.get("login") ?? "");
  if (!ADMIN_LOGIN_RE.test(login))
    throw new AdminCreateError(
      "admin:create: --login обязателен: 3–254 символа a-z 0-9 . _ @ + - (регистр не важен)",
    );
  const role = args.get("role");
  if (!(ADMIN_CLI_ROLES as readonly string[]).includes(role ?? ""))
    throw new AdminCreateError(`admin:create: --role — одно из ${ADMIN_CLI_ROLES.join(", ")}`);
  const regionCode = args.get("region") ?? null;
  if (role === "SUPERADMIN" && regionCode !== null)
    throw new AdminCreateError("admin:create: SUPERADMIN назначается на платформу, --region не нужен");
  if (role !== "SUPERADMIN" && regionCode === null)
    throw new AdminCreateError(`admin:create: для ${role} нужен --region <код региона>`);
  return { login, role: role as AdminCliRole, regionCode };
}

export function assertPassword(password: string): void {
  if (!isAcceptablePassword(password))
    throw new AdminCreateError(
      `admin:create: пароль — ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} символов, без пробелов по краям`,
    );
}

export type AdminCreated = { userId: string; credentialId: string; roleAssignmentId: string };

/** Пользователь + учётка + роль. Занятый логин или неизвестный регион — AdminCreateError, ничего не создаётся. */
export async function createAdmin(
  db: Db,
  input: AdminCreateArgs & { password: string },
): Promise<AdminCreated> {
  assertPassword(input.password);
  // Как при входе: вызов не из CLI мог не нормализовать логин — иначе дубликат «Admin-A» прошёл бы мимо проверки.
  const login = normalizeLogin(input.login);
  const passwordHash = await hashPassword(input.password);
  const service = new RoleAssignmentService(
    new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS),
    new ScopeHierarchy(),
  );
  const audit = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);
  return withTenant(db, SYSTEM_CONTEXT, async (trx) => {
    let scope: ScopeRef = PLATFORM_SCOPE;
    if (input.regionCode !== null) {
      const region = await trx
        .selectFrom("regions")
        .select("id")
        .where("code", "=", input.regionCode)
        .executeTakeFirst();
      if (!region) throw new AdminCreateError(`admin:create: регион с кодом ${input.regionCode} не найден`);
      scope = regionScope(region.id);
    }
    const credentials = new AdminCredentialsRepository(trx);
    if (await credentials.findByLogin(login))
      throw new AdminCreateError(`admin:create: логин ${login} уже занят`);
    const user = await trx
      .insertInto("users")
      .values({ status: "active", language: "uk" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const credential = await credentials.create({
      user_id: user.id,
      login,
      password_hash: passwordHash,
    });
    // Логин в аудит не пишем (может быть e-mail — ПДн): ссылка на учётку.
    await audit.record(trx, {
      actor: { type: "system" },
      action: "auth.admin.credential.create",
      entityType: ADMIN_CREDENTIAL_ENTITY,
      entityId: credential.id,
      newValues: { userId: user.id },
      reason: "cli admin:create",
    });
    const assignment = await service.assign(trx, {
      userId: user.id,
      role: input.role,
      scope,
      actor: { type: "system" },
      reason: "cli admin:create",
    });
    return { userId: user.id, credentialId: credential.id, roleAssignmentId: assignment.id };
  });
}

// Реестр ролей: роль = набор permission-кодов + допустимые типы области. Бизнес-роли админки SUPERADMIN,
// REGION_ADMIN, MODERATOR (блок 3, матрица roles-and-data §1.4) и технические роли-заглушки для тестов и seed
// (T1-23); роли партнёра — блок 6. В БД роль — text (формат ^[A-Z][A-Z0-9_]*$): роль не из реестра прав не даёт.
import type { ScopeType } from "../../db/index.js";
import { PERMISSIONS, type PermissionCode } from "./permissions.js";

export type RoleDefinition = {
  readonly permissions: ReadonlySet<PermissionCode>;
  /** На какие области роль можно назначить (roles-and-data §1.2, «Допустимые сочетания роль × область»). */
  readonly scopes: ReadonlySet<ScopeType>;
};

function role(permissions: readonly PermissionCode[], scopes: readonly ScopeType[]): RoleDefinition {
  return Object.freeze({ permissions: new Set(permissions), scopes: new Set(scopes) });
}

/**
 * Права SUPERADMIN: вся платформа (roles-and-data §1.4, колонка SA = P), кроме действий, которых у SA в матрице нет
 * («—» или только SYSTEM): операции партнёра в кассе и брони, отзывы от имени партнёра, системные задачи.
 * 2FA и dual approval (ячейки «P 2FA», «+2») — после D-52 (тестовый режим, implementation-backlog §1.6).
 */
const NOT_SUPERADMIN: ReadonlySet<PermissionCode> = new Set<PermissionCode>([
  "customer_qr.resolve",
  "availability.status.manual",
  "booking.manual.create",
  "booking.confirm",
  "booking.reject",
  "booking.propose_alternative",
  "booking.complete",
  "booking.no_show",
  "booking.expire",
  "transaction.quote",
  "transaction.cancel",
  "bonus.lifecycle.run",
  "review.eligibility.issue",
  "review.respond",
  "review.complain",
  "review.appeal",
  "ambassador.stats.own",
  "notification.send.system",
]);

/**
 * REGION_ADMIN — ячейки «R» колонки RA матрицы roles-and-data §1.4 (блок 3: контент, QR, экстренные контакты,
 * аудит; права последующих блоков — заранее, проверяются эндпоинтами этих блоков).
 */
const REGION_ADMIN_PERMISSIONS: readonly PermissionCode[] = [
  // Чтение каталога в админке (черновики, снятые места; блок 3, ADR-0017).
  "catalog.read.admin",
  "privacy.request.process",
  "user.read",
  "user.block",
  "risk_flag.manage",
  "region.settings.edit",
  "locality.manage",
  "category.manage.regional",
  "tag.manage",
  "partner_template.extend.regional",
  "organization.create",
  "organization.edit",
  "organization.verify",
  "place.create",
  "place.edit",
  "place.submit",
  "place.moderate",
  "place.publish",
  "place.suspend",
  "place.archive",
  "media.upload",
  "media.moderate",
  "schedule.edit",
  "host_module.edit",
  "host_module.settings.edit",
  "emergency_contact.manage",
  "scenario.manage",
  "offer.manage",
  "promotion.manage",
  "badge.recommend.grant",
  "badge.recommend.revoke",
  "qr_point.manage",
  "qr_point.deactivate",
  "qr.analytics.read",
  "service_request.read",
  "staff.invite",
  "staff.role.assign",
  "staff.deactivate",
  "staff.audit.read",
  "role.assign.admin",
  "resource.manage",
  "availability.edit",
  "booking.read",
  "booking.admin.read",
  "transaction.read",
  "ledger.read",
  "settlement.read",
  "statement.export",
  "review.moderate",
  "complaint.resolve",
  "appeal.decide",
  "ambassador.manage",
  "ambassador.campaign.manage",
  "attribution.read",
  "attribution.override",
  "ambassador_reward.approve",
  "notification_template.manage",
  "broadcast.send",
  "analytics.read",
  "analytics.export",
  "audit.read",
];

/** MODERATOR (C-16: область REGION в пилоте) — ячейки «R» колонки MO матрицы roles-and-data §1.4. */
const MODERATOR_PERMISSIONS: readonly PermissionCode[] = [
  "catalog.read.admin",
  "user.read",
  "user.block",
  "risk_flag.manage",
  "organization.verify",
  "place.moderate",
  "place.suspend",
  "media.moderate",
  "review.moderate",
  "complaint.resolve",
  "appeal.decide",
  "analytics.read",
  "audit.read",
];

/**
 * Реестр ролей: бизнес-роли админки (блок 3) и технические роли-заглушки (тесты и seed, в prod не назначаются —
 * seed только local/staging, T1-23). Роли партнёра ORG_OWNER … AMBASSADOR, FIN_OPERATOR — блоки 6, 8, 11.
 */
export const ROLES = {
  /** Суперадмин платформы (roles-and-data §1.1): назначается CLI `admin:create` или другим SUPERADMIN. */
  SUPERADMIN: role(
    PERMISSIONS.filter((p) => !NOT_SUPERADMIN.has(p)),
    ["PLATFORM"],
  ),
  /** Администратор региона (один на регион в пилоте, C-10). */
  REGION_ADMIN: role(REGION_ADMIN_PERMISSIONS, ["REGION"]),
  /** Модератор региона (C-16); PLATFORM-модератор — POST. */
  MODERATOR: role(MODERATOR_PERMISSIONS, ["REGION"]),
  /** Все права на всей платформе (аналог SUPERADMIN для тестов). */
  TECH_SUPERUSER: role(PERMISSIONS, ["PLATFORM"]),
  /** Администрирование региона: контент (в т. ч. фото, T1-20), аудит и назначение ролей в регионе. */
  TECH_REGION_ADMIN: role(
    [
      "organization.edit",
      "place.edit",
      "media.upload",
      "audit.read",
      "role.assign.admin",
      "staff.role.assign",
    ],
    ["REGION"],
  ),
  /** Только чтение аудита области. */
  TECH_AUDITOR: role(["audit.read"], ["PLATFORM", "REGION"]),
  /** Редактор организации/заведения — для проверок нижних уровней иерархии. */
  TECH_ORG_EDITOR: role(["organization.edit", "place.edit"], ["ORGANIZATION", "PLACE"]),
} as const satisfies Record<string, RoleDefinition>;

export type RoleCode = keyof typeof ROLES;

export function isRoleCode(code: string): code is RoleCode {
  return Object.hasOwn(ROLES, code);
}

/** Есть ли у роли permission; неизвестная роль (например, удалённая из реестра) — нет. */
export function roleHasPermission(role: string, permission: PermissionCode): boolean {
  return isRoleCode(role) && ROLES[role].permissions.has(permission);
}

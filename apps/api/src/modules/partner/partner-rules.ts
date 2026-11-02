// Правила кабинета партнёра без БД и Nest (блок 6, ADR-0021): обязательные поля шаблона, статусы места для правки и
// отправки на модерацию, переход по решению модератора, состояние приглашения, роль и возможности партнёра.
import type {
  LocalizedText,
  ModerationDecision,
  PartnerPlaceField,
  PlaceStatus,
  StaffInvite,
} from "../../db/index.js";
import { roleHasPermission } from "../rbac/index.js";
import type { PartnerRole, StaffInviteState } from "./partner.dto.js";

/** Карточка для проверки обязательных полей шаблона. */
export type PlaceFill = {
  name: LocalizedText | null;
  categoryId: string | null;
  description: LocalizedText | null;
  address: LocalizedText | null;
  hasLocation: boolean;
  phone: string | null;
  weeklyIntervals: number;
  /** Фото, не отклонённые проверкой. */
  photos: number;
};

const filled = (t: LocalizedText | null): boolean => !!t && t.uk.trim() !== "";

const FIELD_CHECKS: Readonly<Record<PartnerPlaceField, (p: PlaceFill) => boolean>> = {
  name: (p) => filled(p.name),
  category: (p) => !!p.categoryId,
  description: (p) => filled(p.description),
  address: (p) => filled(p.address),
  location: (p) => p.hasLocation,
  phone: (p) => !!p.phone,
  schedule: (p) => p.weeklyIntervals > 0,
  photo: (p) => p.photos > 0,
};

/** Незаполненные обязательные поля шаблона (порядок — как в шаблоне). */
export function missingFields(required: readonly PartnerPlaceField[], place: PlaceFill): PartnerPlaceField[] {
  return required.filter((f) => FIELD_CHECKS[f] && !FIELD_CHECKS[f](place));
}

/**
 * Статусы, в которых партнёр правит карточку: черновик, возврат на доработку, отклонённое (повторная подача) и
 * опубликованное — правка сразу в живую версию (§1.6, без PlaceRevision). На модерации, приостановлено, архив —
 * только чтение.
 */
export const PARTNER_EDITABLE_STATUSES: readonly PlaceStatus[] = [
  "draft",
  "changes_requested",
  "rejected",
  "published",
];

/** Из каких статусов отправка на модерацию (S-05: первичная и повторная подача). */
export const SUBMITTABLE_STATUSES: readonly PlaceStatus[] = ["draft", "changes_requested", "rejected"];

export const isPartnerEditable = (s: PlaceStatus): boolean => PARTNER_EDITABLE_STATUSES.includes(s);
export const isSubmittable = (s: PlaceStatus): boolean => SUBMITTABLE_STATUSES.includes(s);

/** Статус места после решения модератора. */
export const DECISION_PLACE_STATUS: Readonly<Record<ModerationDecision, PlaceStatus>> = {
  approve: "published",
  reject: "rejected",
  changes_requested: "changes_requested",
};

/** Поля личности места: меняет только тот, кто отправляет на модерацию (ORG_OWNER), не менеджер (P06). */
export const IDENTITY_FIELDS = ["categoryId", "localityId", "name", "address", "location"] as const;

export function touchedIdentityFields(input: Partial<Record<string, unknown>>): string[] {
  return IDENTITY_FIELDS.filter((f) => input[f] !== undefined);
}

/** Состояние приглашения на момент now. */
export function inviteState(
  invite: Pick<StaffInvite, "accepted_at" | "revoked_at" | "expires_at">,
  now: Date,
): StaffInviteState {
  if (invite.accepted_at) return "accepted";
  if (invite.revoked_at) return "revoked";
  if (invite.expires_at.getTime() <= now.getTime()) return "expired";
  return "active";
}

/** Старшая роль партнёра, если у пользователя несколько назначений на организацию. */
const ROLE_RANK: Readonly<Record<PartnerRole, number>> = { ORG_OWNER: 3, ORG_MANAGER: 2, ORG_STAFF: 1 };

export function isPartnerRole(role: string): role is PartnerRole {
  return Object.hasOwn(ROLE_RANK, role);
}

export function higherRole(a: PartnerRole, b: PartnerRole): PartnerRole {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/** Возможности роли (кнопки P01/P06/P07/P09) — из реестра прав, а не из кода роли. */
export function abilitiesOf(role: string) {
  return {
    editPlace: roleHasPermission(role, "place.edit"),
    editIdentity: roleHasPermission(role, "place.submit"),
    submit: roleHasPermission(role, "place.submit"),
    manageStaff: roleHasPermission(role, "staff.invite"),
    manageOffers: roleHasPermission(role, "offer.manage"),
    serviceRequests: roleHasPermission(role, "service_request.read"),
  };
}

/** Токен приглашения в пути: base64url 32 байт (43 символа); допускается префикс start_param. */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function normalizeInviteToken(raw: string, prefix: string): string | undefined {
  const token = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return INVITE_TOKEN_RE.test(token) ? token : undefined;
}

/** Период акции: конец позже начала (оба края необязательны). */
export function validOfferPeriod(startsAt: string | null, endsAt: string | null): boolean {
  if (!startsAt || !endsAt) return true;
  return new Date(endsAt).getTime() > new Date(startsAt).getTime();
}

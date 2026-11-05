// Правила заявки «Це мій заклад» (0031) без БД и Nest: какое место можно заявить, выбор организации, переходы
// статуса, шаблон партнёра для места каталога, тексты уведомлений заявителю.
import type { PlaceClaimStatus, PlaceStatus } from "../../db/index.js";
import { isClaimableCategory } from "../catalog/index.js";

// Список категорий без хозяина-бизнеса — в каталоге (его читает и карточка места guide).
export { isClaimableCategory, NOT_CLAIMABLE_CATEGORY_CODES } from "../catalog/index.js";

/** Почему место нельзя заявить; null — можно. */
export type ClaimBlocker = "place_claimed" | "place_not_published" | "not_claimable";

/**
 * Заявить можно только опубликованное место без организации (место импорта Google или админки) в категории с
 * хозяином-бизнесом.
 */
export function claimBlocker(
  place: { status: PlaceStatus; organization_id: string | null },
  /** Код категории места или цепочка «категория → родители». */
  categoryCodes: string | readonly string[] | null | undefined,
): ClaimBlocker | null {
  if (place.organization_id !== null) return "place_claimed";
  if (place.status !== "published") return "place_not_published";
  if (!isClaimableCategory(categoryCodes)) return "not_claimable";
  return null;
}

/** Решение модератора по заявке. */
export type ClaimDecision = "approve" | "reject";

/** Статус после решения; решать можно только заявку на рассмотрении. */
export const CLAIM_DECISION_STATUS: Readonly<
  Record<ClaimDecision, Extract<PlaceClaimStatus, "approved" | "rejected">>
> = {
  approve: "approved",
  reject: "rejected",
};

export const isClaimDecidable = (s: PlaceClaimStatus): boolean => s === "pending";
/** Отозвать может заявитель — только заявку на рассмотрении. */
export const isClaimWithdrawable = (s: PlaceClaimStatus): boolean => s === "pending";
/** Отменить (ошибочное одобрение) может модератор — только одобренную. */
export const isClaimRevocable = (s: PlaceClaimStatus): boolean => s === "approved";

/** Решённые заявки (фильтр «Розглянуті» очереди). */
export const DECIDED_CLAIM_STATUSES: readonly PlaceClaimStatus[] = [
  "approved",
  "rejected",
  "withdrawn",
  "revoked",
];

/** «Мої заявки»: на рассмотрении — всегда, решённые — столько дней после последнего изменения. */
export const MY_CLAIMS_RECENT_DAYS = 30;

export function isRecentClaim(c: { status: PlaceClaimStatus; updated_at: Date }, now: Date): boolean {
  return (
    c.status === "pending" || now.getTime() - c.updated_at.getTime() <= MY_CLAIMS_RECENT_DAYS * 86_400_000
  );
}

/** Организация заявки: существующая (где заявитель ORG_OWNER) или новая по названию — ровно одно. */
export type ClaimOrganizationChoice =
  | { kind: "existing"; organizationId: string }
  | { kind: "new"; name: string };

export type ClaimOrganizationProblem = "organization_choice_required" | "not_org_owner";

/**
 * Разбор выбора организации: id и название вместе или ни одного — organization_choice_required; id организации, где
 * у заявителя нет действующей роли ORG_OWNER (ownerOrgIds), — not_org_owner. Название — без пробелов по краям.
 */
export function claimOrganization(
  input: { organizationId?: string | null; organizationName?: string | null },
  ownerOrgIds: ReadonlySet<string>,
): ClaimOrganizationChoice | ClaimOrganizationProblem {
  const id = input.organizationId?.trim().toLowerCase() || null;
  const name = input.organizationName?.trim() || null;
  if ((id === null) === (name === null)) return "organization_choice_required";
  if (id !== null) return ownerOrgIds.has(id) ? { kind: "existing", organizationId: id } : "not_org_owner";
  return { kind: "new", name: name! };
}

/** category_codes базового шаблона (0031): любая категория. */
export const ANY_CATEGORY = "*";

export const isAnyCategoryTemplate = (t: { category_codes: readonly string[] }): boolean =>
  t.category_codes.includes(ANY_CATEGORY);

/**
 * Шаблон партнёра для места каталога по коду его категории (первый по sort_order из активных); нет подходящего —
 * базовый шаблон (category_codes '*'): у каждого одобренного места есть редактор кабинета (P06).
 */
export function templateForCategory<T extends { category_codes: readonly string[]; sort_order: number }>(
  templates: readonly T[],
  categoryCode: string | null | undefined,
): T | null {
  const sorted = [...templates].sort((a, b) => a.sort_order - b.sort_order);
  return (
    (categoryCode ? sorted.find((t) => t.category_codes.includes(categoryCode)) : undefined) ??
    sorted.find(isAnyCategoryTemplate) ??
    null
  );
}

/** Комментарий автоотказа конкурирующим заявкам при одобрении одной из них. */
export const AUTO_REJECT_COMMENT = "Заклад підтверджено за іншим заявником.";

/** Текст уведомления заявителю ботом. */
export function claimDecisionText(
  decision: ClaimDecision | "revoke",
  placeName: string,
  comment: string | null,
): string {
  const head =
    decision === "approve"
      ? `Заявку «Це мій заклад» на «${placeName}» схвалено. Заклад тепер у розділі «Мій заклад».`
      : decision === "revoke"
        ? `Схвалення заявки «Це мій заклад» на «${placeName}» скасовано модератором.`
        : `Заявку «Це мій заклад» на «${placeName}» відхилено.`;
  return comment ? `${head} Коментар модератора: ${comment}` : head;
}

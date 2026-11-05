import { ParseUUIDPipe } from "@nestjs/common";
import type { ErrorCode } from "@tg/shared";
import { ApiError } from "../../common/http/index.js";
import type { CursorQueryDto } from "../../common/http/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { CatalogError, type AuditMeta, type CatalogErrorReason } from "./catalog.service.js";

// Общее для контроллеров каталога: id из пути, курсор, актор аудита, перевод CatalogError в конверт ошибки.

export const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

export const auditMeta = (req: AuditableRequest): AuditMeta => auditFromRequest(req);

const ERRORS: Record<CatalogErrorReason, { code: ErrorCode; messageKey?: string }> = {
  not_found: { code: "NOT_FOUND" },
  region_context_required: { code: "FORBIDDEN", messageKey: "errors.catalog.regionRequired" },
  platform_context_required: { code: "FORBIDDEN" },
  code_taken: { code: "CONFLICT", messageKey: "errors.catalog.codeTaken" },
  timezone_invalid: { code: "UNPROCESSABLE" },
  in_use: { code: "CONFLICT", messageKey: "errors.catalog.inUse" },
  parent_not_found: { code: "UNPROCESSABLE", messageKey: "errors.catalog.invalidReference" },
  parent_not_root: { code: "UNPROCESSABLE" },
  has_subcategories: { code: "UNPROCESSABLE" },
  category_has_published_places: {
    code: "CONFLICT",
    messageKey: "errors.catalog.categoryHasPublishedPlaces",
  },
  category_not_found: { code: "UNPROCESSABLE", messageKey: "errors.catalog.invalidReference" },
  locality_not_found: { code: "UNPROCESSABLE", messageKey: "errors.catalog.invalidReference" },
  extra_categories_invalid: { code: "UNPROCESSABLE", messageKey: "errors.catalog.invalidReference" },
  tags_not_found: { code: "UNPROCESSABLE", messageKey: "errors.catalog.invalidReference" },
  invalid_transition: { code: "CONFLICT", messageKey: "errors.place.invalidTransition" },
  not_publishable: { code: "UNPROCESSABLE", messageKey: "errors.place.notPublishable" },
  moderation_required: { code: "CONFLICT", messageKey: "errors.place.moderationRequired" },
  not_deletable: { code: "CONFLICT", messageKey: "errors.place.notDeletable" },
  archive_never_published: { code: "CONFLICT", messageKey: "errors.catalog.archiveNeverPublished" },
  schedule_invalid: { code: "UNPROCESSABLE", messageKey: "errors.place.scheduleInvalid" },
  media_not_found: { code: "UNPROCESSABLE", messageKey: "errors.place.mediaInvalid" },
  media_not_image: { code: "UNPROCESSABLE", messageKey: "errors.place.mediaInvalid" },
  media_owner_mismatch: { code: "UNPROCESSABLE", messageKey: "errors.place.mediaInvalid" },
  media_rejected: { code: "UNPROCESSABLE", messageKey: "errors.place.mediaInvalid" },
  media_already_linked: { code: "CONFLICT", messageKey: "errors.place.mediaInvalid" },
  already_recommended: { code: "CONFLICT", messageKey: "errors.place.badgeState" },
  not_recommended: { code: "CONFLICT", messageKey: "errors.place.badgeState" },
};

/** CatalogError → ApiError: details.reason — код причины, details.problems — список (публикация, график). */
export function rethrow(e: unknown): never {
  if (!(e instanceof CatalogError)) throw e;
  const { code, messageKey } = ERRORS[e.reason];
  throw new ApiError(code, {
    messageKey,
    details: { reason: e.reason, ...(e.problems.length ? { problems: [...e.problems] } : {}) },
    cause: e,
  });
}

/** Вызов сервиса с переводом ошибок каталога. */
export async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    rethrow(e);
  }
}

// Курсор списка мест (T1-17: непрозрачная строка): base64url от JSON `{ "id": <uuid> }` последнего места страницы.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

/** id из курсора; битый курсор — 400 VALIDATION_FAILED по полю cursor. */
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  let id: unknown;
  try {
    id = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: unknown } | null)?.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== "string" || !UUID.test(id))
    throw new ApiError("VALIDATION_FAILED", {
      details: {
        fields: [{ field: "cursor", constraint: "isCursor", messageKey: "errors.validation.isCursor" }],
      },
    });
  return id.toLowerCase();
}

export const DEFAULT_PAGE_SIZE = 20;
export type PageQuery = Pick<CursorQueryDto, "cursor" | "limit">;

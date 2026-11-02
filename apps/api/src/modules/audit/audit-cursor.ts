import { ApiError } from "../../common/http/index.js";

// Курсор ленты аудита (T1-17: непрозрачная строка из nextCursor): base64url от JSON `{ "id": <uuid> }` — id
// последней записи страницы. Клиент курсор не разбирает, поэтому формат можно менять.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeAuditCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

/** id из курсора; битый курсор — 400 VALIDATION_FAILED по полю cursor. */
export function decodeAuditCursor(cursor: string): string {
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

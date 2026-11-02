import { ApiError } from "./api-error.js";

// Курсор списка по id (T1-17: непрозрачная строка из nextCursor): base64url от JSON `{ "id": <uuid> }` — id
// последней записи страницы. Подходит спискам с порядком по uuidv7 (растёт со временем), от новых к старым.
// Клиент курсор не разбирает, поэтому формат можно менять.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeIdCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

/** id из курсора; битый курсор — 400 VALIDATION_FAILED по полю cursor. */
export function decodeIdCursor(cursor: string): string {
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

/**
 * Страница из выборки с одной лишней строкой (limit + 1): лишняя — признак следующей страницы.
 * `toItem` — строка → DTO.
 */
export function idPage<Row extends { id: string }, Item>(
  rows: readonly Row[],
  limit: number,
  toItem: (row: Row) => Item,
): { items: Item[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toItem),
    nextCursor: rows.length > limit && last ? encodeIdCursor(last.id) : null,
  };
}

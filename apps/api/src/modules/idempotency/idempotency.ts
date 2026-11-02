// Чистые функции Idempotency-Key (T1-14): ключ, область, хэш тела, решение по существующей записи.
import { createHash } from "node:crypto";
import type { IdempotencyKey, JsonObject } from "../../db/index.js";

/** Заголовок запроса (Node отдаёт имена заголовков в нижнем регистре). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Заголовок ответа-повтора: ответ взят из сохранённого, обработчик не вызывался. */
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

/** TTL ключа по умолчанию — 24 ч. */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Минимальный TTL: короче — повтор клиента после таймаута сети уже не найдёт ключ. */
export const MIN_IDEMPOTENCY_TTL_SECONDS = 60;

/** Retry-After (с) для ответа «запрос с этим ключом в обработке». */
export const IN_PROGRESS_RETRY_AFTER_SECONDS = 1;

// Видимые ASCII-символы, 1–255 (длина — как CHECK в БД); клиент обычно шлёт UUID.
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Значение заголовка Idempotency-Key или undefined, если его нет, он повторён или некорректен. */
export function parseIdempotencyKey(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && KEY_RE.test(value) ? value : undefined;
}

/** Область анонимных запросов: общая для всех клиентов без актора — только с `@Idempotent({ allowAnonymous: true })`. */
export const ANONYMOUS_ACTOR = "anon";

/**
 * Актор запроса для области ключа: `user:<id>` из `req.user.id` или undefined, если актора нет.
 * TODO(T1-26): принципал из аутентификации (сессия/токен); он должен быть выставлен ДО IdempotencyInterceptor —
 * guard или middleware, а не TenantContextSource (тот вызывается позже, внутри TenantContextInterceptor).
 */
export function idempotencyActor(req: { user?: unknown }): string | undefined {
  const id = (req.user as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id !== "" ? `user:${id}` : undefined;
}

/** Область ключа: актор + метод + путь без query (`user:<id>:POST /payments/1/refund`). */
export function idempotencyScope(actor: string, method: string, path: string): string {
  return `${actor}:${method.toUpperCase()} ${path.split("?")[0]}`;
}

/**
 * Канонический JSON: ключи объектов отсортированы рекурсивно, порядок массивов сохранён, undefined-поля
 * опущены (как в JSON.stringify). `{a:1,b:2}` и `{b:2,a:1}` дают одну строку.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value; // Date и т. п.
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
  return out;
}

/** sha256 (hex) канонического JSON тела запроса; нет тела — как `null`. */
export function requestHash(body: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(body ?? null))
    .digest("hex");
}

/**
 * Сохранённый ответ в `response_body`: успех — `{ value }` (JSON-форма результата обработчика; void —
 * `{}`), 4xx — `{ error: { code, messageKey, details? } }` без correlationId (у повтора — свой).
 */
export type StoredResponse =
  | { value?: unknown }
  | { error: { code: string; messageKey: string; details?: JsonObject } };

/** Что делать с запросом, если ключ уже занят записью `row`. */
export type ExistingKeyDecision =
  | { kind: "replay"; status: number; body: StoredResponse }
  | { kind: "mismatch" }
  | { kind: "in_progress" };

/**
 * Решение по записи, которую не удалось захватить (истёкшие и `failed` с тем же хэшем захватываются раньше,
 * в IdempotencyKeysRepository.claim): другой хэш тела → mismatch (422) при любом статусе; completed → повтор
 * сохранённого ответа; in_progress (и failed — сюда не доходит) → «в обработке» (409).
 */
export function decideExisting(
  row: Pick<IdempotencyKey, "request_hash" | "status" | "response_status" | "response_body">,
  hash: string,
): ExistingKeyDecision {
  if (row.request_hash !== hash) return { kind: "mismatch" };
  if (row.status === "completed" && row.response_status !== null)
    return { kind: "replay", status: row.response_status, body: (row.response_body ?? {}) as StoredResponse };
  return { kind: "in_progress" };
}

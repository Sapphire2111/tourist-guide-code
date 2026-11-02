// Типизированный клиент API «Гід туриста» (T1-16). Типы путей генерируются из apps/api/openapi.json
// (`pnpm api:generate`), руками src/generated/ не правится. Фронтенды обращаются к API только через него.
import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { components, paths } from "./generated/schema.js";

export type { components, paths } from "./generated/schema.js";
export type { CursorPage, ErrorCode, ErrorEnvelope, HealthStatus, Money } from "@tg/shared";

export type ApiClient = Client<paths>;
export type ApiSchemas = components["schemas"];

/**
 * Клиент поверх `fetch` среды выполнения (браузер, Telegram WebView, Node ≥ 18).
 * Ответ: `{ data }` при 2xx либо `{ error }` — тело ErrorEnvelope при 4xx/5xx.
 */
export function createApiClient(options: ClientOptions & { baseUrl: string }): ApiClient {
  return createClient<paths>(options);
}

// Клиент API админки: адрес — переменная сборки VITE_API_URL, локально — api на 4300.
// Токен сессии admin_web — в памяти и sessionStorage (ADR-0009, ADR-0018), на каждый запрос — Bearer.
import { createApiClient, type ApiClient, type ApiSchemas } from "@tg/api-client";

export type { ApiClient, ApiSchemas };
export type Session = ApiSchemas["SessionDto"];

export const API_URL: string = import.meta.env.VITE_API_URL || "http://localhost:4300";
export const TOKEN_KEY = "tg.admin.token";

let memoryToken: string | null = null;

/** Хранилище недоступно (приватный режим, запрет сайта) — работаем из памяти. */
export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token === null) window.sessionStorage.removeItem(TOKEN_KEY);
    else window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // квота/запрет — токен только в памяти
  }
}

let unauthorized: (() => void) | null = null;

/** Обработчик 401 в работе (сессия истекла/отозвана): сброс токена и переход на вход. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorized = fn;
}

/** 401 этих путей обрабатывает вызывающий: вход (неверный пароль) и проверка сессии при старте. */
const OWN_401 = ["/auth/admin/login", "/auth/session"];

/** Клиент с Bearer из хранилища. `fetch` — для тестов. */
export function createAdminApi(baseUrl = API_URL, fetchImpl?: typeof fetch): ApiClient {
  const api = createApiClient({ baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  api.use({
    onRequest({ request }) {
      const token = getToken();
      if (token && !request.headers.has("Authorization"))
        request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
    onResponse({ request, response }) {
      if (response.status !== 401) return;
      const path = new URL(request.url).pathname;
      if (OWN_401.some((p) => path.endsWith(p))) return;
      setToken(null);
      unauthorized?.();
    },
  });
  return api;
}

/** Ошибка для показа: ключ i18n из конверта и детали (поля, причины). */
export type ApiError = {
  status: number;
  messageKey: string;
  fields?: { field: string; messageKey: string }[];
  /** details.problems (publish-check, график) или details.reason. */
  problems?: string[];
};

type Envelope = {
  error?: {
    messageKey?: string;
    details?: { fields?: ApiError["fields"]; problems?: unknown; reason?: unknown };
  };
};

/** Ответ openapi-fetch → ошибка из конверта; без конверта — общий ключ по статусу. */
export function toApiError(error: unknown, response: Response | undefined): ApiError {
  const status = response?.status ?? 0;
  const body = (error ?? {}) as Envelope;
  const details = body.error?.details;
  const problems = Array.isArray(details?.problems)
    ? details.problems.filter((p): p is string => typeof p === "string")
    : typeof details?.reason === "string"
      ? [details.reason]
      : undefined;
  return {
    status,
    messageKey: body.error?.messageKey ?? (status ? "errors.internal" : "admin.error.network"),
    ...(details?.fields?.length ? { fields: details.fields } : {}),
    ...(problems?.length ? { problems } : {}),
  };
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** Обёртка запроса: `{ data }`/`{ error }` openapi-fetch и сбой сети → Result. 204 — data = undefined. */
export async function call<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<Result<T>> {
  try {
    const res = await request;
    if (res.response.ok) return { ok: true, data: res.data as T };
    return { ok: false, error: toApiError(res.error, res.response) };
  } catch {
    return { ok: false, error: toApiError(undefined, undefined) };
  }
}

/** Пользователь работает на PLATFORM (SUPERADMIN): регион выбирается в сессии. */
export function isPlatform(session: Session): boolean {
  return session.grants.some((g) => g.scopeType === "PLATFORM");
}

/** Регионы назначений (без PLATFORM). */
export function grantRegions(session: Session): string[] {
  return [...new Set(session.grants.map((g) => g.regionId).filter((r): r is string => !!r))];
}

/** Нужен явный выбор региона: PLATFORM или несколько регионов. */
export function needsRegionChoice(session: Session): boolean {
  return isPlatform(session) || grantRegions(session).length > 1;
}

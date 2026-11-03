// Поток старта Mini App (блок 2, ADR-0015/0016): POST /auth/telegram → токен сессии → параллельно GET /context/{start_param}
// (без QR — GET /context; ровно один раз за открытие) и GET /me. Токен — в памяти и sessionStorage (ADR-0009),
// anonymousId — в localStorage.
import type { ApiClient, ApiSchemas } from "@tg/api-client";
import type { MessageKey } from "@tg/i18n";
import type { TelegramWebApp } from "./telegram.js";
import { inviteTokenOf } from "./partner/partner-api.js";

export type QrContext = ApiSchemas["QrContextDto"];
export type Me = ApiSchemas["MeDto"];
export type LoginResult = ApiSchemas["TelegramLoginResponseDto"];

export const TOKEN_KEY = "tg.session.token";
export const ANONYMOUS_ID_KEY = "tg.anonymousId";

/** Хранилища недоступны (приватный режим, запрет сайта) — молча работаем из памяти. */
function storage(kind: "session" | "local"): Storage | undefined {
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return undefined;
  }
}
function read(kind: "session" | "local", key: string): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(kind: "session" | "local", key: string, value: string | null): void {
  try {
    const s = storage(kind);
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, value);
  } catch {
    // квота/запрет — значение остаётся только в памяти
  }
}

let memoryToken: string | null = null;

export function getToken(): string | null {
  return memoryToken ?? read("session", TOKEN_KEY);
}
export function setToken(token: string | null): void {
  memoryToken = token;
  write("session", TOKEN_KEY, token);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function getAnonymousId(): string | undefined {
  const v = read("local", ANONYMOUS_ID_KEY);
  return v && UUID.test(v) ? v : undefined;
}
export function setAnonymousId(id: string): void {
  write("local", ANONYMOUS_ID_KEY, id);
}

/** start_param: initDataUnsafe.start_param, иначе tgWebAppStartParam из query/hash страницы. */
export function getStartParam(
  webApp?: TelegramWebApp,
  loc: Pick<Location, "search" | "hash"> = window.location,
) {
  const fromInit = webApp?.initDataUnsafe?.start_param;
  if (fromInit) return fromInit;
  const fromSearch = new URLSearchParams(loc.search).get("tgWebAppStartParam");
  if (fromSearch) return fromSearch;
  const hash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  return hash.startsWith("/")
    ? undefined
    : (new URLSearchParams(hash).get("tgWebAppStartParam") ?? undefined);
}

const PLATFORMS = new Set(["ios", "android", "web", "desktop", "unknown"]);
/** Telegram.WebApp.platform → ClientPlatform API (tdesktop/macos → desktop, weba/webk → web). */
export function clientPlatform(platform?: string): ApiSchemas["ClientPlatform"] {
  if (!platform) return "unknown";
  if (PLATFORMS.has(platform)) return platform as ApiSchemas["ClientPlatform"];
  if (platform.startsWith("android")) return "android"; // android_x — альтернативный клиент Telegram
  if (platform === "tdesktop" || platform === "macos" || platform === "unigram") return "desktop";
  if (platform.startsWith("web")) return "web";
  return "unknown";
}

export type StartupState =
  | { status: "loading" }
  | { status: "browser" }
  | { status: "error"; messageKey: MessageKey }
  | {
      status: "ready";
      login: LoginResult;
      context: QrContext | null;
      /**
       * Контекст не загрузился (429/5xx/сеть) — повтор только по кнопке. startParam — QR открытия; нет — открытие
       * без QR (GET /context, регион по умолчанию).
       */
      contextFailed?: { startParam?: string };
      me: Me;
      /** Открытие по приглашению сотрудника (start_param inv_<токен>, P14): токен; контекст — регион по умолчанию. */
      invite?: string;
    };

/**
 * Один запрос контекста: со start_param — GET /context/{start_param} (скан QR), без — GET /context (регион по
 * умолчанию). null — сбой (429/5xx/сеть), не нейтральный контекст.
 */
export async function fetchContext(api: ApiClient, startParam?: string): Promise<QrContext | null> {
  try {
    const anonymousId = getAnonymousId();
    const query = anonymousId ? { anonymousId } : {};
    const res = startParam
      ? await api.GET("/context/{start_param}", { params: { path: { start_param: startParam }, query } })
      : await api.GET("/context", { params: { query } });
    if (!res.data) return null;
    setAnonymousId(res.data.anonymousId);
    return res.data;
  } catch {
    return null;
  }
}

/** Bearer из хранилища на каждый запрос клиента (подключается один раз на клиент). */
const authorized = new WeakSet<ApiClient>();
export function attachAuth(api: ApiClient): void {
  if (authorized.has(api)) return;
  authorized.add(api);
  api.use({
    onRequest({ request }) {
      const token = getToken();
      if (token && !request.headers.has("Authorization"))
        request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
  });
}

function errorKey(status: number | undefined): MessageKey {
  if (status === 401) return "errors.auth.invalidInitData";
  if (status === 403) return "errors.auth.userBlocked";
  return "miniapp.start.error";
}

/**
 * Старт за одно открытие. Возвращает функцию с запомненным промисом: повторный вызов (StrictMode, перерисовка)
 * не повторяет вход и не пишет второй скан QR.
 */
export function createStartup(api: ApiClient, webApp?: TelegramWebApp): () => Promise<StartupState> {
  let pending: Promise<StartupState> | undefined;
  return () => (pending ??= run(api, webApp));
}

async function run(api: ApiClient, webApp?: TelegramWebApp): Promise<StartupState> {
  if (!webApp?.initData) return { status: "browser" };
  attachAuth(api);
  try {
    setToken(null);
    const auth = await api.POST("/auth/telegram", {
      body: { initData: webApp.initData, platform: clientPlatform(webApp.platform) },
    });
    if (!auth.data) return { status: "error", messageKey: errorKey(auth.response.status) };
    setToken(auth.data.token);
    const rawStartParam = auth.data.startParam ?? getStartParam(webApp);
    // Приглашение сотрудника — не QR-точка: контекст без start_param, экран P14 по токену.
    const invite = inviteTokenOf(rawStartParam);
    const startParam = invite !== undefined ? undefined : rawStartParam;
    // Контекст и /me независимы (оба — с токеном входа) — параллельно: заставка ждёт на один запрос меньше.
    const [context, me] = await Promise.all([fetchContext(api, startParam || undefined), api.GET("/me")]);
    if (!me.data) return { status: "error", messageKey: errorKey(me.response.status) };
    return {
      status: "ready",
      login: auth.data,
      context,
      ...(context ? {} : { contextFailed: startParam ? { startParam } : {} }),
      me: me.data,
      ...(invite !== undefined ? { invite } : {}),
    };
  } catch {
    return { status: "error", messageKey: "miniapp.start.error" };
  }
}

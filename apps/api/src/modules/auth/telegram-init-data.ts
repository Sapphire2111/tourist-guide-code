// Проверка initData Telegram Mini App (блок 2, ADR-0015; core.telegram.org/bots/webapps «Validating data received
// via the Mini App»): data-check-string — все поля, кроме hash, `ключ=значение`, по алфавиту, через "\n";
// secret_key = HMAC_SHA256(key = "WebAppData", bot_token); hash = hex(HMAC_SHA256(key = secret_key, data-check-string)).
// Сравнение — за постоянное время. Сама строка initData — ПДн (имя, username, фото): её не логировать и не хранить.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Максимальная длина initData, символов: с запасом над реальной (≈1–2 КБ). */
export const INIT_DATA_MAX_LENGTH = 8192;
/** Допуск часов клиента/Telegram «из будущего», секунд. */
export const INIT_DATA_FUTURE_SKEW_SEC = 60;
/** Срок действия initData по умолчанию, часов (TELEGRAM_INIT_DATA_MAX_AGE_HOURS). */
export const DEFAULT_INIT_DATA_MAX_AGE_HOURS = 24;

/** Почему initData отклонён — код без данных пользователя (идёт в RiskFlag и лог). */
export type InitDataRejection =
  | "malformed"
  | "duplicate_field"
  | "missing_hash"
  | "bad_signature"
  | "missing_auth_date"
  | "expired"
  | "from_future"
  | "missing_user"
  | "bad_user";

export class InitDataError extends Error {
  override readonly name = "InitDataError";
  constructor(
    readonly reason: InitDataRejection,
    /** Подпись верна (данные от Telegram), но initData не принят — например, истёк. Тогда известен пользователь. */
    readonly telegramUserId?: number,
  ) {
    super(`initData отклонён: ${reason}`);
  }
}

/** Пользователь из initData (поле user, JSON). */
export type TelegramInitUser = {
  readonly id: number;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
  readonly languageCode: string | null;
  readonly isPremium: boolean;
  readonly allowsWriteToPm: boolean;
  readonly photoUrl: string | null;
};

export type ValidatedInitData = {
  readonly user: TelegramInitUser;
  readonly authDate: Date;
  /** startapp-параметр ссылки (QR/deep link) как есть; разбор — модуль context. */
  readonly startParam: string | null;
};

const HASH_RE = /^[0-9a-f]{64}$/;

/** secret_key для бота: HMAC_SHA256(key = "WebAppData", message = bot_token). */
export function initDataSecretKey(botToken: string): Buffer {
  return createHmac("sha256", "WebAppData").update(botToken).digest();
}

/** Подпись полей (без hash) — для проверки и для тестов. */
export function signInitDataFields(
  fields: ReadonlyArray<readonly [string, string]>,
  botToken: string,
): string {
  // По ключу (не по строке «k=v»: ключ-префикс другого ключа отсортировался бы иначе).
  const dataCheckString = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return createHmac("sha256", initDataSecretKey(botToken)).update(dataCheckString).digest("hex");
}

/**
 * Проверяет initData и возвращает пользователя, auth_date и start_param; иначе InitDataError с кодом причины.
 * Порядок: формат → дубли полей → подпись → срок → пользователь (до подписи содержимому не доверяем).
 */
export function validateInitData(
  raw: string,
  botToken: string,
  opts: { maxAgeSec: number; now?: Date },
): ValidatedInitData {
  if (!botToken) throw new Error("validateInitData: пустой токен бота");
  if (typeof raw !== "string" || raw.length === 0 || raw.length > INIT_DATA_MAX_LENGTH)
    throw new InitDataError("malformed");
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    throw new InitDataError("malformed");
  }
  const fields: [string, string][] = [];
  const seen = new Set<string>();
  let hash: string | undefined;
  for (const [key, value] of params) {
    if (seen.has(key)) throw new InitDataError("duplicate_field");
    seen.add(key);
    if (key === "hash") hash = value;
    else fields.push([key, value]);
  }
  if (hash === undefined) throw new InitDataError("missing_hash");
  if (!HASH_RE.test(hash)) throw new InitDataError("bad_signature");
  const expected = Buffer.from(signInitDataFields(fields, botToken), "hex");
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw new InitDataError("bad_signature");

  // Дальше данные подписаны Telegram.
  const get = (k: string) => fields.find(([key]) => key === k)?.[1];
  const user = parseUser(get("user"));
  const authDateRaw = get("auth_date");
  if (authDateRaw === undefined || !/^\d{1,12}$/.test(authDateRaw))
    throw new InitDataError("missing_auth_date", user?.id);
  const authDateSec = Number(authDateRaw);
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (authDateSec > nowSec + INIT_DATA_FUTURE_SKEW_SEC) throw new InitDataError("from_future", user?.id);
  if (nowSec - authDateSec > opts.maxAgeSec) throw new InitDataError("expired", user?.id);
  if (user === undefined) throw new InitDataError(get("user") === undefined ? "missing_user" : "bad_user");
  const startParam = get("start_param");
  return {
    user,
    authDate: new Date(authDateSec * 1000),
    startParam: startParam === undefined || startParam === "" ? null : startParam,
  };
}

/** user из initData; не JSON или без корректного id — undefined. */
function parseUser(json: string | undefined): TelegramInitUser | undefined {
  if (json === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "number" || !Number.isSafeInteger(o.id) || o.id <= 0) return undefined;
  if (o.is_bot === true) return undefined;
  // Обрезка по кодовым точкам (как char_length в CHECK), а не по UTF-16: не разрезать суррогатную пару.
  const str = (x: unknown, max: number) =>
    typeof x === "string" && x.length > 0 ? [...x].slice(0, max).join("") : null;
  return {
    id: o.id,
    firstName: str(o.first_name, 256),
    lastName: str(o.last_name, 256),
    username: str(o.username, 64),
    languageCode: str(o.language_code, 35),
    isPremium: o.is_premium === true,
    allowsWriteToPm: o.allows_write_to_pm === true,
    photoUrl:
      typeof o.photo_url === "string" && /^https:\/\//.test(o.photo_url) && o.photo_url.length <= 2048
        ? o.photo_url
        : null,
  };
}

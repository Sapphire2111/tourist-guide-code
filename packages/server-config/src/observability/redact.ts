/**
 * Маскирование ПДн и секретов в логах (T1-18): Telegram initData, телефоны, e-mail, токены, Authorization.
 * Применяется к каждому сообщению и полю перед выводом — и в JSON-логгере, и в трекере ошибок.
 */

export const REDACTED = "[REDACTED]";

/** Имена полей, значения которых всегда скрываются целиком (сравнение без регистра и разделителей). */
const SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "apikey",
  "xapikey",
  "initdata",
  "telegraminitdata",
  "xtelegraminitdata",
  "phone",
  "phonenumber",
  "email",
  "dsn",
  "sentrydsn",
  "telegrambottoken",
  "bottoken",
]);

const normalizeKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Поле, значение которого скрывается целиком (authorization, initData, phone, email, token…). */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(normalizeKey(key));
}

/** Длиннее — обрезается до маскирования: регулярки и размер записи ограничены (защита event loop). */
export const MAX_REDACT_LENGTH = 16_384;
const MAX_KEYS = 100;

// Все шаблоны линейны: каждый начинается с якоря (lookbehind/\b), квантификаторы ограничены,
// соседние классы не пересекаются — без квадратичного перебора на длинных строках без пробелов.
// Порядок важен: сначала токены (initData), затем Authorization, токены, e-mail и телефоны.
const PATTERNS: readonly [RegExp, string][] = [
  // Authorization: Bearer/Basic/tma …
  [/\b(Bearer|Basic|tma)\s+[\w\-.~+/=%]{1,8192}/gi, `$1 ${REDACTED}`],
  // Токен Telegram-бота 123456789:AA… (в т.ч. в URL api.telegram.org/bot<token>/).
  [/(?<!\d)\d{6,12}:[\w-]{30,256}/g, REDACTED],
  // JWT.
  [/(?<![\w-])eyJ[\w-]{1,4096}\.[\w-]{1,8192}\.[\w-]{1,4096}/g, REDACTED],
  // E-mail.
  [/(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g, REDACTED],
  // Телефоны: +380 67 123 45 67, 380671234567, (067) 123-45-67 — от 10 до 15 цифр с разделителями.
  // Не внутри слов, дат и времени (`2026-11-02 10:00:00`, ISO, `10:00:00 02.11.2026`): слева нет [\w.-] и `цифра:`,
  // справа нет [\w-] и `:цифра`. `phone:…`, `/users/…/`, `…: не найден` — маскируются.
  [/(?<![\w.-]|\d:)\+?\(?\d(?:[\s().-]{0,2}\d){9,14}(?![\w-]|:\d)/g, REDACTED],
];

// Токен — непрерывный участок без пробелов/кавычек (линейный поиск); initData внутри — скрыть токен целиком.
const TOKEN = /[^\s"'<>]+/g;
const INIT_DATA = /(?:auth_date|hash|signature)(?:=|%3D)/i;

/** Маскирует ПДн и секреты в строке. Длиннее MAX_REDACT_LENGTH — обрезается (`…[truncated]`). */
export function redactString(input: string): string {
  // initData — по полной строке (линейный проход): обрезка не должна разрезать токен и оставить его часть видимой.
  let out = input.replace(TOKEN, (tok) => (INIT_DATA.test(tok) ? REDACTED : tok));
  if (out.length > MAX_REDACT_LENGTH) out = `${out.slice(0, MAX_REDACT_LENGTH)}…[truncated]`;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Рекурсивно маскирует значение (строки, объекты, массивы, Error). Глубина и число ключей ограничены;
 * бинарные данные — `[Binary n]`; ошибка чтения поля (геттер) — `[Unreadable]`.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[Object]";
  if (ArrayBuffer.isView(value)) return `[Binary ${value.byteLength}]`;
  if (value instanceof ArrayBuffer) return `[Binary ${value.byteLength}]`;
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: redactString(value.message) };
    if (value.stack) out.stack = redactString(value.stack);
    if (value.cause !== undefined) out.cause = redact(value.cause, depth + 1);
    return out;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_KEYS).map((v) => redact(v, depth + 1));
    if (value.length > MAX_KEYS) items.push(`[+${value.length - MAX_KEYS}]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return "[Unreadable]";
  }
  for (const k of keys.slice(0, MAX_KEYS)) {
    let v: unknown;
    try {
      v = (value as Record<string, unknown>)[k];
    } catch {
      out[k] = "[Unreadable]";
      continue;
    }
    out[k] = isSecretKey(k) && v !== undefined && v !== null ? REDACTED : redact(v, depth + 1);
  }
  if (keys.length > MAX_KEYS) out["…"] = `[+${keys.length - MAX_KEYS} keys]`;
  return out;
}

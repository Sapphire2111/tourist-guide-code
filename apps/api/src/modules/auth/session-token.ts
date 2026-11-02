// Токен сессии (T1-26, ADR-0009): непрозрачная случайная строка, клиент шлёт её в `Authorization: Bearer <токен>`.
// В БД хранится только sha256 токена: 256 бит случайности перебором не подобрать, поэтому медленный хэш
// (bcrypt/argon2) не нужен, а поиск по хэшу — один индексный запрос.
import { createHash, randomBytes } from "node:crypto";

/** Префикс — чтобы токен узнавался в логах и сканерами утечек секретов. */
const PREFIX = "tgs_";
/** tgs_ + base64url от 32 байт (43 символа без «=»). */
const TOKEN_RE = /^tgs_[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer +(\S+) *$/i;

/** Новый токен сессии: 32 байта из CSPRNG. Возвращается клиенту один раз, нигде не сохраняется и не логируется. */
export function generateSessionToken(): string {
  return PREFIX + randomBytes(32).toString("base64url");
}

/** sha256 токена (32 байта) — то, что хранится в sessions.token_hash. */
export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function isSessionToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/**
 * Токен из заголовка Authorization (`Bearer <токен>`) или undefined: заголовка нет, другая схема, токен не нашего
 * формата (такой запрос в БД не идёт).
 */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const token = BEARER_RE.exec(header)?.[1];
  return token !== undefined && isSessionToken(token) ? token : undefined;
}

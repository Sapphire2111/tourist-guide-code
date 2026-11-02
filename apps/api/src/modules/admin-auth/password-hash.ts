// Хэш пароля админа (ADR-0018): scrypt из node:crypto, случайная соль, параметры — в строке хэша.
// Формат: `scrypt$<N>$<r>$<p>$<соль base64url>$<ключ base64url>` (CHECK admin_credentials_password_hash_format).
// Усиление параметров — смена DEFAULT_SCRYPT без миграции: старые хэши проверяются по своим параметрам.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

export type ScryptParams = { readonly N: number; readonly r: number; readonly p: number };

/**
 * N = 2^15, r = 8, p = 1: ~32 МБ памяти и ~50–100 мс на вход — выдерживает перебор офлайн и не перегружает
 * Render free (512 МБ). OWASP (2026) — от N = 2^17 при свободной памяти; поднимать вместе с тарифом.
 */
export const DEFAULT_SCRYPT: ScryptParams = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });
/** Длина ключа новых хэшей; при проверке длина берётся из самого хэша (KEY_MIN…KEY_MAX). */
const KEY_LENGTH = 32;
const KEY_MIN = 16;
const KEY_MAX = 64;
const SALT_LENGTH = 16;
/** Пределы параметров из строки хэша: защита от «хэша-бомбы» (огромный N из повреждённой записи). */
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;
/** Память scrypt ≈ 128·N·r байт: не больше 64 МБ на одну проверку (Render free — 512 МБ на процесс). */
const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024;

/** Пароль: 12–256 символов (кодовых точек); проверка при создании учётки (CLI admin:create). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

function scrypt(
  password: string,
  salt: Buffer,
  params: ScryptParams,
  keyLength = KEY_LENGTH,
): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    // По умолчанию maxmem 32 МБ — ровно впритык к 128·N·r при N = 2^15; запас вдвое (параметры уже ограничены).
    maxmem: 2 * 128 * params.N * params.r,
  };
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFC"), salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Новый хэш пароля со случайной солью. */
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

type Parsed = { params: ScryptParams; salt: Buffer; key: Buffer };

function parse(hash: string): Parsed | undefined {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return undefined;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // N — степень двойки > 1 (требование scrypt).
  if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return undefined;
  if (128 * N * r > MAX_SCRYPT_MEMORY) return undefined;
  const salt = Buffer.from(m[4]!, "base64url");
  const key = Buffer.from(m[5]!, "base64url");
  if (salt.length < 8 || key.length < KEY_MIN || key.length > KEY_MAX) return undefined;
  return { params: { N, r, p }, salt, key };
}

/**
 * Проверка пароля за постоянное время сравнения (timingSafeEqual). Повреждённый хэш — false (без исключения):
 * вход отвечает тем же 401, что и на неверный пароль.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parse(hash);
  if (!parsed) return false;
  const key = await scrypt(password, parsed.salt, parsed.params, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

let dummyHash: Promise<string> | undefined;

/** Заранее посчитать фиктивный хэш (при старте api): первая проверка несуществующего логина не будет дольше. */
export async function warmUpDummy(): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await dummyHash;
}

/**
 * Проверка «впустую» для несуществующего логина или заблокированной учётки: те же затраты scrypt, что и у
 * настоящей проверки, чтобы по времени ответа нельзя было отличить «нет пользователя» от «неверный пароль».
 */
export async function verifyDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
  return false;
}

/** Длина пароля в кодовых точках в пределах PASSWORD_MIN_LENGTH…PASSWORD_MAX_LENGTH. */
export function isAcceptablePassword(password: string): boolean {
  const n = Array.from(password).length;
  return n >= PASSWORD_MIN_LENGTH && n <= PASSWORD_MAX_LENGTH && password.trim() === password;
}

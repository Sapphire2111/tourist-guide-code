// Формат start_param QR-точки (ТЗ §3.3: QR не содержит ПДн — только непрозрачный идентификатор; ADR-0016).
// Те же правила — в CHECK qr_points_code_format и qr_scan_events_raw_format (миграция 0011).
import { randomInt } from "node:crypto";

/** Символы Telegram startapp (как START_PAYLOAD_RE бота) и длина кода: 10–64. */
export const QR_CODE_RE = /^[A-Za-z0-9_-]{10,64}$/;
export const QR_CODE_MIN_LENGTH = 10;
export const QR_CODE_MAX_LENGTH = 64;
/** Длина генерируемого кода: 12 символов base62 ≈ 71 бит — перебором не угадать (плюс rate limit). */
export const QR_CODE_GENERATED_LENGTH = 12;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export type StartParamCheck =
  | { readonly valid: true; readonly code: string }
  | { readonly valid: false; readonly reason: "format" | "digits_only" };

/**
 * Проверка start_param: только символы и длина кода, и не одни цифры (телефон, номер карты или документа — признак
 * ПДн, а не нашего кода). Невалидный параметр дальше не идёт: не ищется, не логируется и не сохраняется.
 * Код чувствителен к регистру (как в ссылке), пробелы по краям не обрезаются.
 */
export function checkStartParam(raw: unknown): StartParamCheck {
  if (typeof raw !== "string" || !QR_CODE_RE.test(raw)) return { valid: false, reason: "format" };
  if (/^[0-9]+$/.test(raw)) return { valid: false, reason: "digits_only" };
  return { valid: true, code: raw };
}

/**
 * Новый код QR-точки: QR_CODE_GENERATED_LENGTH случайных символов base62 (crypto.randomInt — без смещения).
 * Код из одних цифр (вероятность ~10⁻¹⁰) перегенерируется — такой не прошёл бы checkStartParam.
 * Уникальность гарантирует UNIQUE qr_points_code_key: при конфликте вызывающий генерирует заново.
 */
export function generateQrCode(random: (max: number) => number = randomInt): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < QR_CODE_GENERATED_LENGTH; i++) code += BASE62[random(BASE62.length)];
    if (checkStartParam(code).valid) return code;
  }
}

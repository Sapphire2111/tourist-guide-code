// Проверка загрузки: заявленный тип и размер (до выдачи ссылки) и реальная сигнатура файла (при подтверждении).
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, type MediaKind, type MediaMime } from "./constants.js";

export type UploadRejectReason = "mime_not_allowed" | "size_invalid" | "size_too_large";

/** Заявка на загрузку до выдачи подписанной ссылки: тип из белого списка вида, размер 1…MAX_UPLOAD_BYTES. */
export function validateUploadRequest(input: {
  kind: MediaKind;
  mime: string;
  size: number;
}): { ok: true; mime: MediaMime } | { ok: false; reason: UploadRejectReason } {
  const mime = input.mime.trim().toLowerCase();
  if (!(ALLOWED_MIME[input.kind] as readonly string[]).includes(mime))
    return { ok: false, reason: "mime_not_allowed" };
  if (!Number.isSafeInteger(input.size) || input.size <= 0) return { ok: false, reason: "size_invalid" };
  if (input.size > MAX_UPLOAD_BYTES) return { ok: false, reason: "size_too_large" };
  return { ok: true, mime: mime as MediaMime };
}

/** Сколько первых байт нужно для detectMime. */
export const MAGIC_BYTES_LENGTH = 16;

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

/**
 * Тип файла по сигнатуре (magic bytes), а не по заявленному Content-Type или расширению.
 * JPEG: FF D8 FF; PNG: 89 50 4E 47 0D 0A 1A 0A; WebP: «RIFF» ???? «WEBP»; PDF: «%PDF-». Иначе — null.
 */
export function detectMime(head: Uint8Array): MediaMime | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
}

export type UploadedCheck =
  | { ok: true }
  | { ok: false; reason: "not_uploaded" | "size_mismatch" | "type_mismatch" };

/**
 * Проверка загруженного объекта при подтверждении: размер совпадает с заявленным (и не больше лимита),
 * сигнатура — заявленный тип. Не тот тип (в т.ч. неизвестная сигнатура) — type_mismatch.
 */
export function checkUploadedObject(
  declared: { mime: string; size: number },
  actual: { size: number; head: Uint8Array } | null,
): UploadedCheck {
  if (!actual) return { ok: false, reason: "not_uploaded" };
  if (actual.size !== declared.size || actual.size > MAX_UPLOAD_BYTES)
    return { ok: false, reason: "size_mismatch" };
  if (detectMime(actual.head) !== declared.mime) return { ok: false, reason: "type_mismatch" };
  return { ok: true };
}

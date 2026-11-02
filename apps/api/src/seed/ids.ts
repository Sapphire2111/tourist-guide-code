import { createHash } from "node:crypto";

/**
 * Детерминированный uuid (версия 5 по схеме RFC 4122) от имени в пространстве seed: одно имя — один id при
 * каждом запуске. На этом строится идемпотентность seed — повторная вставка той же записи упирается в
 * PRIMARY KEY и пропускается (`ON CONFLICT DO NOTHING`), а не дублируется.
 */
export function seedUuid(name: string): string {
  const h = createHash("sha1").update(`tg-seed:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Секции редактора заведения (#basic, #photos, #schedule, #extra; ?section=<id>) — общие для PlaceEditor и дашборда,
// отдельным модулем, чтобы ленивый чанк дашборда не тянул редактор.
import type { PartnerField } from "./partner-api.js";

export const SECTIONS = ["basic", "photos", "schedule", "extra"] as const;
export type SectionId = (typeof SECTIONS)[number];

/** В какой секции редактируется обязательное поле шаблона. */
export function sectionOf(f: PartnerField): SectionId {
  if (f === "photo") return "photos";
  if (f === "schedule") return "schedule";
  if (f === "location") return "extra";
  return "basic";
}

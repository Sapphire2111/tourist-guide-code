// Курорты коридора Н-09 по порядку вдоль Пруту. Высоты и время в пути — данные владельца (дизайн-спецификация);
// центр и радиус — как у населённых пунктов импорта Google (apps/api/src/places-import/config.ts): выбор курорта —
// поиск мест в радиусе от его центра (GET /places/search с lat/lng/radius), без изменений api.
import type { MessageKey } from "@tg/i18n";
import type { LatLng } from "../guide/geo.js";

export const RESORT_IDS = ["all", "yaremche", "mykulychyn", "tatariv", "yablunytsia", "bukovel"] as const;
export type ResortId = (typeof RESORT_IDS)[number];

export type Resort = {
  id: ResortId;
  name: MessageKey;
  /** Подпись под названием: ключ и параметры. */
  meta: { key: MessageKey; params: Record<string, string | number> };
  /** Центр и радиус поиска, м; null — весь регион. */
  area: { center: LatLng; radius: number } | null;
};

export const RESORTS: readonly Resort[] = [
  {
    id: "all",
    name: "miniapp.resort.all",
    meta: { key: "miniapp.resort.metaAll", params: { alt: "585–1372", km: 38 } },
    area: null,
  },
  {
    id: "yaremche",
    name: "miniapp.resort.yaremche",
    meta: { key: "miniapp.resort.metaStart", params: { alt: 585 } },
    area: { center: { lat: 48.4505, lng: 24.5547 }, radius: 4500 },
  },
  {
    id: "mykulychyn",
    name: "miniapp.resort.mykulychyn",
    meta: { key: "miniapp.resort.meta", params: { alt: 650, min: 12, km: 10 } },
    area: { center: { lat: 48.399, lng: 24.598 }, radius: 4000 },
  },
  {
    id: "tatariv",
    name: "miniapp.resort.tatariv",
    meta: { key: "miniapp.resort.meta", params: { alt: 750, min: 22, km: 20 } },
    area: { center: { lat: 48.3497, lng: 24.5735 }, radius: 3000 },
  },
  {
    id: "yablunytsia",
    name: "miniapp.resort.yablunytsia",
    meta: { key: "miniapp.resort.metaPass", params: { alt: 931, min: 32, km: 30 } },
    area: { center: { lat: 48.302, lng: 24.47 }, radius: 3500 },
  },
  {
    id: "bukovel",
    name: "miniapp.resort.bukovel",
    meta: { key: "miniapp.resort.meta", params: { alt: "920–1372", min: 40, km: 38 } },
    // Буковель — в границах Поляниці: центр и радиус её импорта.
    area: { center: { lat: 48.36, lng: 24.41 }, radius: 5000 },
  },
];

export function resortById(id: ResortId): Resort {
  return RESORTS.find((r) => r.id === id) ?? RESORTS[0]!;
}

export function isResortId(v: unknown): v is ResortId {
  return typeof v === "string" && (RESORT_IDS as readonly string[]).includes(v);
}

export const RESORT_STORAGE_KEY = "tg.resort";

/** Код региона, к которому относятся курорты: регион «Прикарпаття» (в seed api — test-region). */
export const RESORTS_REGION_CODE = "test-region";

/** Свайпер курортов — только в своём регионе (в другом регионе эти координаты не имеют смысла). */
export function hasResorts(regionCode: string | null | undefined): boolean {
  return regionCode === RESORTS_REGION_CODE;
}

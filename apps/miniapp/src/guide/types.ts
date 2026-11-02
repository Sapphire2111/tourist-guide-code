// Модель гида на стороне Mini App: экраны работают с ней, а не с DTO api напрямую — адаптер в guide-api.ts.
import type { LocalizedText } from "@tg/i18n";
import type { LatLng } from "./geo.js";

export const HOME_SECTIONS = ["about", "eat", "shop", "relax", "fun", "nearby", "transfer", "help"] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];
/** Разделы главной, открывающие каталог C04 по корневой категории. */
export const CATALOG_SECTIONS = ["eat", "shop", "relax", "fun", "transfer"] as const;
export type CatalogSection = (typeof CATALOG_SECTIONS)[number];

export type Category = {
  id: string;
  parentId: string | null;
  name: LocalizedText;
  homeSection: HomeSection | null;
};

export type Photo = { url: string; alt: LocalizedText | null };

export type PlaceSummary = {
  id: string;
  name: LocalizedText;
  categoryId: string;
  /** Адрес (населённый пункт, улица) — подпись в карточке. */
  address?: LocalizedText | null;
  location: LatLng | null;
  /** Расстояние от точки поиска, м (считает сервер). */
  distanceMeters: number | null;
  cover: Photo | null;
  /** «Відкрито зараз» по графику: null — график неизвестен. */
  openNow: boolean | null;
  /** «Ми рекомендуємо» (редакционный бейдж, D-32). */
  recommended: boolean;
  /** Платное размещение: метка «Реклама» / «Партнер» показывается всегда (C-02, ТЗ §4.3). */
  adLabel: "advertising" | "partner" | null;
};

/** Интервал графика: weekday 1 = понедельник … 7 = воскресенье, время местное «HH:MM». */
export type ScheduleInterval = { weekday: number; opens: string; closes: string };

export type PlaceDetail = PlaceSummary & {
  description: LocalizedText | null;
  phone: string | null;
  website: string | null;
  /** Telegram без @. */
  telegram: string | null;
  photos: Photo[];
  schedule: ScheduleInterval[];
  tags: LocalizedText[];
  /** Дата проверки информации (ТЗ §4.4), ISO. */
  verifiedAt: string | null;
  /** До скольки открыто (HH:MM), если openNow. */
  openUntil: string | null;
  /** В избранном; null — без сессии. */
  favorite: boolean | null;
};

export type EmergencyKind = "general" | "police" | "ambulance" | "rescue" | "mountain_rescue" | "other";
export type EmergencyContact = {
  id: string;
  kind: EmergencyKind;
  name: LocalizedText;
  phone: string;
  description: LocalizedText | null;
};

export type SearchParams = {
  point?: LatLng | null;
  radius?: number;
  categoryId?: string;
  q?: string;
};

/** Ошибка «не найдено» (404) — отличается от сбоя сети/сервера. */
export class NotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

/** Нет или истекла сессия (401) — нужен повторный вход, повтор запроса не поможет. */
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

/** Доступ к данным гида. Методы бросают ошибку при сбое; place — NotFoundError при 404. */
export type GuideApi = {
  categories(): Promise<Category[]>;
  search(params: SearchParams): Promise<PlaceSummary[]>;
  place(id: string): Promise<PlaceDetail>;
  favorites(): Promise<PlaceSummary[]>;
  addFavorite(placeId: string): Promise<void>;
  removeFavorite(placeId: string): Promise<void>;
  emergencyContacts(): Promise<EmergencyContact[]>;
};

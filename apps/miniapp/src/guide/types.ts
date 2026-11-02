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

export type Photo = {
  url: string;
  alt: LocalizedText | null;
  /** Обложка из Google/Wikimedia (хранится у нас): авторы и лицензия — подпись обязательна. */
  credit?: {
    authors: Author[];
    license: string | null;
    sourceUrl: string | null;
    source: "google" | "wikimedia";
  };
};

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

/** Автор фото или отзыва Google: подпись обязательна (правила Google Maps Platform). */
export type Author = { name: string; uri: string | null; photoUri: string | null };

/** Фото Google: превью 400 px и полноэкранное 1200 px — через прокси api; авторы — подпись. */
export type GooglePhoto = { url: string; largeUrl: string; authors: Author[] };

export type Review = {
  author: Author;
  rating: number | null;
  text: string;
  relativeTime: string | null;
  uri: string | null;
};

export type WikipediaInfo = {
  title: string;
  url: string;
  extract: string;
  /** Опис скорочено (у статье больше текста). */
  truncated: boolean;
  image: { url: string; author: string | null; license: string | null; sourceUrl: string } | null;
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
  /** description — автоописание импорта Google (можно скрыть при содержательном тексте); ручное — false. */
  descriptionAuto?: boolean;
  // Богатая карточка: данные Google Maps, Вікіпедія, ИИ-текст. Нет данных — null/[] (блок не показывается).
  /** Тип места по Google (uk): «Піцерія». */
  typeLabel?: string | null;
  /** Описание Google (editorialSummary). */
  summary?: string | null;
  /** Текст ИИ из фактов Google и Вікіпедії — показывается с пометкой «Згенеровано ШІ». */
  aiSummary?: { text: string; model: string } | null;
  /** 0 — бесплатно, 1–4 — от недорого до очень дорого. */
  priceLevel?: number | null;
  /** «Що пропонує» — коды удобств (подписи — miniapp.place.amenity.*). */
  amenities?: string[];
  rating?: { value: number; count: number } | null;
  reviews?: Review[];
  googlePhotos?: GooglePhoto[];
  googleMapsUri?: string | null;
  wikipedia?: WikipediaInfo | null;
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
  /** Населённые пункты «Локація» (id из localities); пусто — весь регион. */
  localityIds?: readonly string[];
  /** Размер страницы (по умолчанию 50). */
  limit?: number;
};

/** Населённый пункт региона для «Локація» (GET /localities). */
export type LocalityOption = {
  id: string;
  name: LocalizedText;
  /** Опубликованных мест; 0 — в выборе не показывается. */
  placeCount: number;
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
  localities(): Promise<LocalityOption[]>;
  search(params: SearchParams): Promise<PlaceSummary[]>;
  place(id: string): Promise<PlaceDetail>;
  favorites(): Promise<PlaceSummary[]>;
  addFavorite(placeId: string): Promise<void>;
  removeFavorite(placeId: string): Promise<void>;
  emergencyContacts(): Promise<EmergencyContact[]>;
};

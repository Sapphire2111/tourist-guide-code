// Классификация таблиц по изоляции регионов (ADR-005, ADR-006 «Соглашения схемы», roles-and-data §2.13).
// Каждая таблица из `Database` (schema.ts) обязана быть здесь: `satisfies` ниже не даст собрать код с
// неклассифицированной таблицей, unit-тест сверяет список ещё и с CREATE TABLE в миграциях.
import type { Database } from "./schema.js";

/**
 * - `global` — без `region_id`, общие для всех регионов (PLATFORM-справочники, пользователь, служебные).
 * - `tenant` — `region_id NOT NULL`; доступ только в контексте региона (или SYSTEM/PLATFORM).
 * - `tenant-optional` — журналы с `region_id NULL` (действие PLATFORM/SYSTEM, событие гостя): контекст
 *   региона видит только `region_id = контекст`, строки с NULL — только SYSTEM/PLATFORM.
 *
 * Для tenant и tenant-optional: TenantGuardPlugin добавляет фильтр `region_id` (T1-10), в БД — RLS
 * (`app_enable_tenant_rls()`, миграция 0003, T1-11).
 */
export type TableTenancy = "global" | "tenant" | "tenant-optional";

export type TenancyMap = Readonly<Record<string, TableTenancy>>;

export const TABLE_TENANCY = {
  app_meta: "global",
  // Настройка платформы (T1-22): target_region_id — цель переопределения, не tenant-колонка.
  feature_flags: "global",
  feature_flag_gate_marks: "global",
  regions: "global",
  users: "global",
  idempotency_keys: "global",
  // Сессия пользователя (T1-26); active_region_id — выбранный регион режима, а не tenant-колонка.
  sessions: "global",
  audit_logs: "tenant-optional",
  audit_log_pii: "tenant-optional",
  analytics_events: "tenant-optional",
  // Назначения на PLATFORM — region_id NULL (roles-and-data §2.13).
  role_assignments: "tenant-optional",
  // Файлы региона (T1-20): регион владельца.
  media_assets: "tenant",
  // Вход через Telegram и профиль (блок 2, миграция 0010): человек и его согласия — во всех регионах (ADR-0015).
  telegram_accounts: "global",
  consents: "global",
  messaging_consents: "global",
  privacy_requests: "global",
  // Признаки риска: фрод — региональный (блоки 9, 11), отказ во входе — без региона (NULL).
  risk_flags: "tenant-optional",
  // QR-контекст (0011, ADR-0016): точка и итоговый контекст — регион; журналы сканов и касаний — NULL, если
  // в платформе нет активного региона (нейтральный контекст без региона).
  qr_points: "tenant",
  entry_contexts: "tenant",
  qr_scan_events: "tenant-optional",
  attribution_touches: "tenant-optional",
  // Ядро админки (0013, ADR-0018): учётка входа — человека (global), как сессия; экстренные контакты и
  // платные размещения — региона.
  admin_credentials: "global",
  admin_login_failures: "global",
  emergency_contacts: "tenant",
  promotions: "tenant",
  // Каталог (0012, ADR-0017): справочники и места региона; категории и теги пока региональные (без глобальных).
  localities: "tenant",
  categories: "tenant",
  tags: "tenant",
  places: "tenant",
  place_tags: "tenant",
  place_extra_categories: "tenant",
  place_schedules: "tenant",
  place_schedule_exceptions: "tenant",
  place_media: "tenant",
  place_badge_events: "tenant",
  // Избранное туриста (0014, ADR-0019): регион места; пользователь — фильтр api.
  favorites: "tenant",
  // Заявки гостиницы и планировщик (0015, ADR-0020): регион места/сценария; пользователь — фильтр api.
  host_modules: "tenant",
  service_requests: "tenant",
  service_request_events: "tenant",
  notifications: "tenant",
  scenarios: "tenant",
  scenario_items: "tenant",
  user_plans: "tenant",
  // Кабинет партнёра (0017, ADR-0021): шаблоны — платформы (global, у app только чтение); организации, модерация,
  // приглашения и акции — регион организации/места.
  partner_templates: "global",
  organizations: "tenant",
  moderation_cases: "tenant",
  staff_invites: "tenant",
  offers: "tenant",
  // Богатая картка місця (0018): обогащение места — регион места; кэш адресов фото Google — общий (имя фото глобально).
  place_enrichments: "tenant",
  google_photo_uris: "global",
  google_api_usage: "global",
  place_cover_photos: "tenant",
  // Бронирования (0022, блок 7): ресурс, правила, согласие на телефон партнёру, бронь и история — регион места.
  resources: "tenant",
  availability_rules: "tenant",
  partner_phone_consents: "tenant",
  bookings: "tenant",
  booking_events: "tenant",
  // Напоминания броней (0023): отметка «уже отправлено» — регион брони.
  booking_reminders: "tenant",
  // Отзывы (0028, блок 10): право на отзыв, отзыв и версии, ответ партнёра, жалобы, апелляции, кэш рейтинга — регион места.
  review_eligibilities: "tenant",
  reviews: "tenant",
  review_revisions: "tenant",
  review_responses: "tenant",
  review_complaints: "tenant",
  review_appeals: "tenant",
  place_review_ratings: "tenant",
  // Прогноз погоды (0026): публичные данные по координатам точки — общие.
  weather_forecasts: "global",
} as const satisfies { readonly [T in keyof Database]: TableTenancy };

/** Колонка tenant в tenant/tenant-optional таблицах. */
export const REGION_COLUMN = "region_id";

/** Таблицы, к которым нужен tenant-контекст (tenant и tenant-optional). */
export function tenantTableNames(map: TenancyMap = TABLE_TENANCY): ReadonlySet<string> {
  return new Set(Object.keys(map).filter((t) => map[t] !== "global"));
}

// Типы таблиц для Kysely (ADR-006). Пишутся вручную рядом с миграцией, которая меняет таблицу;
// имена таблиц и колонок — как в SQL (snake_case, без CamelCasePlugin).
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type { Geometry } from "./geo.js";

/** timestamptz: pg отдаёт Date; при записи можно передать Date или ISO-строку. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

/** Ключ uuid с DEFAULT uuidv7() в БД: при вставке необязателен, не меняется. */
export type UuidPk = ColumnType<string, string | undefined, never>;

/** created_at/updated_at с DEFAULT now(); updated_at ставит триггер set_updated_at(). */
export type CreatedAt = ColumnType<Date, never, never>;
export type UpdatedAt = ColumnType<Date, never, never>;

export interface AppMetaTable {
  key: string;
  value: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// --- feature_flags, feature_flag_gate_marks (global; каталог флагов — в коде, миграция 0008, T1-22) ---

export interface FeatureFlagsTable {
  id: UuidPk;
  key: ColumnType<string, string, never>;
  /** Регион переопределения; NULL — всё окружение. Не tenant-колонка (таблица global). */
  target_region_id: ColumnType<string | null, string | null | undefined, never>;
  enabled: boolean;
  updated_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type FeatureFlagRow = Selectable<FeatureFlagsTable>;
export type NewFeatureFlagRow = Insertable<FeatureFlagsTable>;

export interface FeatureFlagGateMarksTable {
  decision: ColumnType<string, string, never>;
  document_ref: ColumnType<string, string, never>;
  marked_by: ColumnType<string | null, string | null | undefined, never>;
  marked_at: ColumnType<Date, never, never>;
}
export type FeatureFlagGateMark = Selectable<FeatureFlagGateMarksTable>;

/** Код языка (CHECK is_language_code): "uk", "en", "pt-BR". */
export type LanguageCode = string;

/**
 * Мультиязычное поле `*_i18n` (jsonb, конвенция T1-15): «код языка -> текст», `uk` обязателен и непуст
 * (CHECK is_localized_text), остальные языки необязательны; выбор языка с fallback на uk — T1-15.
 */
export type LocalizedText = { uk: string } & Partial<Record<LanguageCode, string>>;

/** jsonb-объект. pg сериализует объект в JSON сам; массив он отправил бы как массив PostgreSQL, поэтому только объект. */
export type JsonObject = { [key: string]: unknown };

/** jsonb-колонка с объектом. */
export type Jsonb<T extends JsonObject = JsonObject> = ColumnType<T, T, T>;

/** Момент создания записи без updated_at (журналы, append-only). */
export type InsertedAt = ColumnType<Date, never, never>;

// --- regions (global) ---

export const REGION_STATUSES = ["draft", "active", "suspended"] as const;
export type RegionStatus = (typeof REGION_STATUSES)[number];

export interface RegionsTable {
  id: UuidPk;
  code: string;
  name_i18n: Jsonb<LocalizedText>;
  status: Generated<RegionStatus>;
  timezone: Generated<string>;
  default_language: Generated<LanguageCode>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Region = Selectable<RegionsTable>;
export type NewRegion = Insertable<RegionsTable>;
export type RegionUpdate = Updateable<RegionsTable>;

// --- users (global) ---

export const USER_STATUSES = ["active", "blocked", "deleted_anonymized"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UsersTable {
  id: UuidPk;
  status: Generated<UserStatus>;
  language: Generated<LanguageCode>;
  /** Имя отображения (миграция 0010): из Telegram при первом входе, дальше — PATCH /me. ПДн. */
  display_name: ColumnType<string | null, string | null | undefined, string | null>;
  /** Псевдоним для аналитики (pseudonymous_user_id, ADR-004): случайный uuid, не users.id (0010). */
  analytics_id: ColumnType<string, string | undefined, string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

// --- audit_logs (append-only: UPDATE/DELETE запрещены правами и триггером, миграция 0004) ---

export const AUDIT_ACTOR_TYPES = ["user", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditLogsTable {
  id: UuidPk;
  actor_type: ColumnType<AuditActorType, AuditActorType, never>;
  actor_user_id: ColumnType<string | null, string | null | undefined, never>;
  region_id: ColumnType<string | null, string | null | undefined, never>;
  action: ColumnType<string, string, never>;
  entity_type: ColumnType<string, string, never>;
  entity_id: ColumnType<string | null, string | null | undefined, never>;
  old_values: ColumnType<JsonObject | null, JsonObject | null | undefined, never>;
  new_values: ColumnType<JsonObject | null, JsonObject | null | undefined, never>;
  reason: ColumnType<string | null, string | null | undefined, never>;
  request_id: ColumnType<string | null, string | null | undefined, never>;
  /** Назначение роли, по которому действовал актор-пользователь (миграция 0005, T1-12). */
  role_assignment_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: InsertedAt;
}
export type AuditLog = Selectable<AuditLogsTable>;
export type NewAuditLog = Insertable<AuditLogsTable>;

// --- audit_log_pii (ПДн-часть аудита 1:1; удаляется по expires_at, D-73) ---

export interface AuditLogPiiTable {
  audit_log_id: ColumnType<string, string, never>;
  region_id: ColumnType<string | null, string | null | undefined, never>;
  /** inet: pg отдаёт строку. */
  ip: ColumnType<string | null, string | null | undefined, never>;
  user_agent: ColumnType<string | null, string | null | undefined, never>;
  session_id: ColumnType<string | null, string | null | undefined, never>;
  expires_at: ColumnType<Date, Date | string, never>;
  created_at: InsertedAt;
}
export type AuditLogPii = Selectable<AuditLogPiiTable>;
export type NewAuditLogPii = Insertable<AuditLogPiiTable>;

// --- idempotency_keys (global, область — принципал) ---

export const IDEMPOTENCY_STATUSES = ["in_progress", "completed", "failed"] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

export interface IdempotencyKeysTable {
  id: UuidPk;
  scope: ColumnType<string, string, never>;
  key: ColumnType<string, string, never>;
  request_hash: ColumnType<string, string, never>;
  status: Generated<IdempotencyStatus>;
  response_status: number | null;
  response_body: ColumnType<JsonObject | null, JsonObject | null | undefined, JsonObject | null>;
  expires_at: Timestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type IdempotencyKey = Selectable<IdempotencyKeysTable>;
export type NewIdempotencyKey = Insertable<IdempotencyKeysTable>;
export type IdempotencyKeyUpdate = Updateable<IdempotencyKeysTable>;

// --- analytics_events (запись не меняется; форма события — @tg/shared analytics.ts, T1-25, миграция 0007) ---

export interface AnalyticsEventsTable {
  id: UuidPk;
  event_name: ColumnType<string, string, never>;
  schema_version: ColumnType<number, number, never>;
  occurred_at: ColumnType<Date, Date | string, never>;
  /** Псевдоним пользователя (без FK; псевдонимные ПДн; способ получения — T1-26). Обнуляется при удалении аккаунта. */
  pseudonymous_user_id: ColumnType<string | null, string | null | undefined, null>;
  /**
   * Анонимное устройство до регистрации/без согласия (0007). Псевдонимные ПДн: обнуление по запросу; срок — D-73.
   */
  anonymous_id: ColumnType<string | null, string | null | undefined, null>;
  /** Сессия приложения (0007). Псевдонимные ПДн: обнуление по запросу; срок — D-73. */
  session_id: ColumnType<string | null, string | null | undefined, null>;
  region_id: ColumnType<string | null, string | null | undefined, never>;
  /** Источник входа/эмиссии (ANALYTICS_SOURCES); по умолчанию system (0007). */
  source: ColumnType<string, string | undefined, never>;
  entry_context_id: ColumnType<string | null, string | null | undefined, never>;
  place_id: ColumnType<string | null, string | null | undefined, never>;
  properties: ColumnType<JsonObject, JsonObject | undefined, never>;
  created_at: InsertedAt;
}
export type AnalyticsEvent = Selectable<AnalyticsEventsTable>;
export type NewAnalyticsEvent = Insertable<AnalyticsEventsTable>;

// --- role_assignments (tenant-optional; меняется только отзыв — триггер, миграция 0005) ---

/** Области RBAC сверху вниз: PLATFORM ⊃ REGION ⊃ ORGANIZATION ⊃ PLACE ⊃ RESOURCE (roles-and-data §1.2). */
export const SCOPE_TYPES = ["PLATFORM", "REGION", "ORGANIZATION", "PLACE", "RESOURCE"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface RoleAssignmentsTable {
  id: UuidPk;
  user_id: ColumnType<string, string, never>;
  role: ColumnType<string, string, never>;
  scope_type: ColumnType<ScopeType, ScopeType, never>;
  scope_id: ColumnType<string | null, string | null | undefined, never>;
  region_id: ColumnType<string | null, string | null | undefined, never>;
  granted_by: ColumnType<string | null, string | null | undefined, never>;
  granted_at: ColumnType<Date, Date | string | undefined, never>;
  valid_until: ColumnType<Date | null, Date | string | null | undefined, never>;
  revoked_at: ColumnType<Date | null, never, Date | string>;
  revoked_by: ColumnType<string | null, never, string | null>;
  revoke_reason: ColumnType<string | null, never, string | null>;
}
export type RoleAssignment = Selectable<RoleAssignmentsTable>;
export type NewRoleAssignment = Insertable<RoleAssignmentsTable>;
export type RoleAssignmentRevoke = Updateable<RoleAssignmentsTable>;

// --- sessions (global; токен — только sha256, миграция 0006, T1-26) ---

export const SESSION_CHANNELS = ["mini_app", "admin_web", "dev"] as const;
export type SessionChannel = (typeof SESSION_CHANNELS)[number];

export const SESSION_REVOKE_REASONS = ["logout", "user_blocked", "admin"] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

export interface SessionsTable {
  id: UuidPk;
  user_id: ColumnType<string, string, never>;
  /** sha256 токена (32 байта, bytea): pg отдаёт Buffer. Сам токен не хранится. */
  token_hash: ColumnType<Buffer, Buffer, never>;
  channel: ColumnType<SessionChannel, SessionChannel, never>;
  /** Выбранный регион режима партнёра/админа (D-50); не tenant-колонка. */
  active_region_id: ColumnType<string | null, string | null | undefined, string | null>;
  expires_at: ColumnType<Date, Date | string, never>;
  revoked_at: ColumnType<Date | null, never, Date | string>;
  revoke_reason: ColumnType<SessionRevokeReason | null, never, SessionRevokeReason>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Session = Selectable<SessionsTable>;
export type NewSession = Insertable<SessionsTable>;

// --- media_assets (tenant; файлы в объектном хранилище, миграция 0009, T1-20) ---
// Перечисления — из @tg/media (MEDIA_KINDS, MEDIA_STATUSES, MEDIA_OWNER_TYPES, MEDIA_MIME_TYPES).

/** Вариант изображения в media_assets.variants (ключ — имя варианта "w320"). */
export type MediaVariantRecord = { key: string; width: number; height: number; bytes: number };

export interface MediaAssetsTable {
  id: UuidPk;
  region_id: ColumnType<string, string, never>;
  owner_type: ColumnType<string, string, never>;
  owner_id: ColumnType<string, string, never>;
  kind: ColumnType<string, string, never>;
  status: ColumnType<string, string | undefined, string>;
  mime: ColumnType<string, string, never>;
  size_bytes: ColumnType<number, number, never>;
  original_key: ColumnType<string, string, string>;
  alt_i18n: ColumnType<LocalizedText | null, LocalizedText | null | undefined, LocalizedText | null>;
  width: ColumnType<number | null, never, number | null>;
  height: ColumnType<number | null, never, number | null>;
  variants: ColumnType<Record<string, MediaVariantRecord>, never, Record<string, MediaVariantRecord>>;
  reject_reason: ColumnType<string | null, never, string | null>;
  created_by: ColumnType<string | null, string | null | undefined, never>;
  uploaded_at: ColumnType<Date | null, never, Date | string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type MediaAsset = Selectable<MediaAssetsTable>;
export type NewMediaAsset = Insertable<MediaAssetsTable>;
export type MediaAssetUpdate = Updateable<MediaAssetsTable>;

// --- telegram_accounts (global; привязка к Telegram 1:1, ПДн; миграция 0010, блок 2) ---

export interface TelegramAccountsTable {
  id: UuidPk;
  user_id: ColumnType<string, string, never>;
  /** bigint: pg отдаёт строку; при записи — число или строка. */
  telegram_user_id: ColumnType<string, number | string, never>;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  photo_url: string | null;
  is_premium: ColumnType<boolean, boolean | undefined, boolean>;
  allows_write_to_pm: ColumnType<boolean, boolean | undefined, boolean>;
  last_auth_date: Timestamp;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type TelegramAccount = Selectable<TelegramAccountsTable>;
export type NewTelegramAccount = Insertable<TelegramAccountsTable>;
export type TelegramAccountUpdate = Updateable<TelegramAccountsTable>;

// --- consents (global; append-only, меняется только withdrawn_at — триггер; миграция 0010, D-41) ---

export const CONSENT_KINDS = ["terms", "privacy", "service", "marketing"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const CONSENT_CHANNELS = ["mini_app", "bot", "admin_web"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export interface ConsentsTable {
  id: UuidPk;
  user_id: ColumnType<string, string, never>;
  kind: ColumnType<ConsentKind, ConsentKind, never>;
  document_version: ColumnType<string, string, never>;
  channel: ColumnType<ConsentChannel, ConsentChannel | undefined, never>;
  granted_at: ColumnType<Date, Date | string | undefined, never>;
  withdrawn_at: ColumnType<Date | null, never, Date | string>;
  created_at: InsertedAt;
}
export type Consent = Selectable<ConsentsTable>;
export type NewConsent = Insertable<ConsentsTable>;

// --- messaging_consents (global; текущее состояние, история — аудит; миграция 0010, ТЗ §11.2) ---

export const MESSAGING_PURPOSES = ["service", "marketing"] as const;
export type MessagingPurpose = (typeof MESSAGING_PURPOSES)[number];
export const MESSAGING_CONSENT_SOURCES = ["request_write_access", "settings", "bot"] as const;
export type MessagingConsentSource = (typeof MESSAGING_CONSENT_SOURCES)[number];

export interface MessagingConsentsTable {
  id: UuidPk;
  user_id: ColumnType<string, string, never>;
  channel: ColumnType<"telegram_bot", "telegram_bot" | undefined, never>;
  purpose: ColumnType<MessagingPurpose, MessagingPurpose, never>;
  granted: boolean;
  source: MessagingConsentSource;
  granted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  withdrawn_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type MessagingConsent = Selectable<MessagingConsentsTable>;
export type NewMessagingConsent = Insertable<MessagingConsentsTable>;

// --- privacy_requests (global; каркас D-48; миграция 0010) ---

export const PRIVACY_REQUEST_KINDS = ["export", "delete"] as const;
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];
export const PRIVACY_REQUEST_STATUSES = ["received", "in_progress", "done", "rejected"] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

export interface PrivacyRequestsTable {
  id: UuidPk;
  user_id: ColumnType<string, string, never>;
  kind: ColumnType<PrivacyRequestKind, PrivacyRequestKind, never>;
  status: ColumnType<PrivacyRequestStatus, PrivacyRequestStatus | undefined, PrivacyRequestStatus>;
  handled_by: ColumnType<string | null, never, string | null>;
  handled_at: ColumnType<Date | null, never, Date | string | null>;
  rejection_reason: ColumnType<string | null, never, string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type PrivacyRequest = Selectable<PrivacyRequestsTable>;
export type NewPrivacyRequest = Insertable<PrivacyRequestsTable>;

// --- risk_flags (tenant-optional; детали без ПДн; миграция 0010) ---

export const RISK_FLAG_KINDS = ["invalid_init_data", "expired_init_data", "manual"] as const;
export type RiskFlagKind = (typeof RISK_FLAG_KINDS)[number];
export const RISK_FLAG_SEVERITIES = ["low", "medium", "high"] as const;
export type RiskFlagSeverity = (typeof RISK_FLAG_SEVERITIES)[number];
export const RISK_FLAG_STATUSES = ["open", "confirmed", "dismissed"] as const;
export type RiskFlagStatus = (typeof RISK_FLAG_STATUSES)[number];

export interface RiskFlagsTable {
  id: UuidPk;
  region_id: ColumnType<string | null, string | null | undefined, never>;
  user_id: ColumnType<string | null, string | null | undefined, never>;
  kind: ColumnType<RiskFlagKind, RiskFlagKind, never>;
  severity: ColumnType<RiskFlagSeverity, RiskFlagSeverity | undefined, RiskFlagSeverity>;
  status: ColumnType<RiskFlagStatus, RiskFlagStatus | undefined, RiskFlagStatus>;
  /** Без ПДн: коды и id. */
  details: ColumnType<JsonObject, JsonObject | undefined, never>;
  request_id: ColumnType<string | null, string | null | undefined, never>;
  resolved_by: ColumnType<string | null, never, string | null>;
  resolved_at: ColumnType<Date | null, never, Date | string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type RiskFlag = Selectable<RiskFlagsTable>;
export type NewRiskFlag = Insertable<RiskFlagsTable>;
// --- qr_points (tenant), qr_scan_events, attribution_touches (tenant-optional), entry_contexts (tenant);
// миграция 0011, блок 2, ADR-0016 ---

export const QR_POINT_TYPES = ["hotel", "place", "region", "campaign"] as const;
export type QrPointType = (typeof QR_POINT_TYPES)[number];

export interface QrPointsTable {
  id: UuidPk;
  region_id: ColumnType<string, string, never>;
  /** Непрозрачный код start_param (qr-context/start-param.ts); не меняется — перевыпуск = новая точка. */
  code: ColumnType<string, string, never>;
  type: ColumnType<QrPointType, QrPointType, QrPointType>;
  /** Место каталога (блок 3); FK нет — таблицы мест ещё нет. */
  place_id: ColumnType<string | null, string | null | undefined, string | null>;
  campaign: ColumnType<string | null, string | null | undefined, string | null>;
  source: ColumnType<string | null, string | null | undefined, string | null>;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  label: string;
  venue_name_i18n: ColumnType<LocalizedText | null, LocalizedText | null | undefined, LocalizedText | null>;
  venue_description_i18n: ColumnType<
    LocalizedText | null,
    LocalizedText | null | undefined,
    LocalizedText | null
  >;
  venue_address_i18n: ColumnType<
    LocalizedText | null,
    LocalizedText | null | undefined,
    LocalizedText | null
  >;
  venue_phone: ColumnType<string | null, string | null | undefined, string | null>;
  venue_website: ColumnType<string | null, string | null | undefined, string | null>;
  venue_telegram: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type QrPoint = Selectable<QrPointsTable>;
export type NewQrPoint = Insertable<QrPointsTable>;
export type QrPointUpdate = Updateable<QrPointsTable>;

export const QR_SCAN_RESULTS = ["ok", "inactive", "not_found", "invalid"] as const;
export type QrScanResult = (typeof QR_SCAN_RESULTS)[number];

export interface QrScanEventsTable {
  id: UuidPk;
  region_id: ColumnType<string | null, string | null | undefined, never>;
  qr_point_id: ColumnType<string | null, string | null | undefined, never>;
  /** Только прошедший проверку формата параметр (иначе NULL). */
  raw_start_param: ColumnType<string | null, string | null | undefined, never>;
  result: ColumnType<QrScanResult, QrScanResult, never>;
  /** Псевдонимные ПДн (user_id/anonymous_id): обнуление по privacy request (D-48). */
  user_id: ColumnType<string | null, string | null | undefined, null>;
  anonymous_id: ColumnType<string | null, string | null | undefined, null>;
  scanned_at: ColumnType<Date, Date | string | undefined, never>;
}
export type QrScanEvent = Selectable<QrScanEventsTable>;
export type NewQrScanEvent = Insertable<QrScanEventsTable>;

export const ENTRY_TYPES = [...QR_POINT_TYPES, "default"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export interface EntryContextsTable {
  id: UuidPk;
  region_id: ColumnType<string, string, never>;
  qr_point_id: ColumnType<string | null, string | null | undefined, never>;
  place_id: ColumnType<string | null, string | null | undefined, never>;
  entry_type: ColumnType<EntryType, EntryType, never>;
  source: ColumnType<string, string, never>;
  qr_scan_event_id: ColumnType<string | null, string | null | undefined, never>;
  user_id: ColumnType<string | null, string | null | undefined, null>;
  anonymous_id: ColumnType<string | null, string | null | undefined, null>;
  created_at: CreatedAt;
}
export type EntryContext = Selectable<EntryContextsTable>;
export type NewEntryContext = Insertable<EntryContextsTable>;

export interface AttributionTouchesTable {
  id: UuidPk;
  region_id: ColumnType<string | null, string | null | undefined, never>;
  user_id: ColumnType<string | null, string | null | undefined, null>;
  anonymous_id: ColumnType<string | null, string | null | undefined, null>;
  source: ColumnType<string, string, never>;
  qr_point_id: ColumnType<string | null, string | null | undefined, never>;
  campaign: ColumnType<string | null, string | null | undefined, never>;
  qr_scan_event_id: ColumnType<string | null, string | null | undefined, never>;
  entry_context_id: ColumnType<string | null, string | null | undefined, never>;
  touched_at: ColumnType<Date, Date | string | undefined, never>;
}
export type AttributionTouch = Selectable<AttributionTouchesTable>;
export type NewAttributionTouch = Insertable<AttributionTouchesTable>;

// --- admin_credentials (global), emergency_contacts, promotions (tenant); миграция 0013, блок 3, ADR-0018 ---

export const ADMIN_MFA_METHODS = ["totp"] as const;
export type AdminMfaMethod = (typeof ADMIN_MFA_METHODS)[number];

export interface AdminCredentialsTable {
  id: UuidPk;
  user_id: ColumnType<string, string, never>;
  /** Нижний регистр (CHECK admin_credentials_login_format). */
  login: ColumnType<string, string, never>;
  /** scrypt$N$r$p$соль$ключ (admin-auth/password-hash.ts). */
  password_hash: string;
  /** Неудачи по логину со всех адресов в окне 1 ч (порог 50 — блокировка учётки). */
  failed_attempts: ColumnType<number, number | undefined, number>;
  failure_window_started_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  locked_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_login_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** 2FA (D-52) — каркас: задан — вход отклоняется, пока метод не реализован. */
  mfa_method: ColumnType<AdminMfaMethod | null, AdminMfaMethod | null | undefined, AdminMfaMethod | null>;
  password_changed_at: ColumnType<Date, Date | string | undefined, Date | string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type AdminCredential = Selectable<AdminCredentialsTable>;
export type NewAdminCredential = Insertable<AdminCredentialsTable>;
export type AdminCredentialUpdate = Updateable<AdminCredentialsTable>;

/** Неудачные входы по паре sha256(логин) + sha256(адрес клиента) — блокировка пары (5 за 15 мин). */
export interface AdminLoginFailuresTable {
  login_hash: ColumnType<Buffer, Buffer, never>;
  client_hash: ColumnType<Buffer, Buffer, never>;
  failed_attempts: number;
  locked_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_failed_at: ColumnType<Date, Date | string | undefined, Date | string>;
}
export type AdminLoginFailure = Selectable<AdminLoginFailuresTable>;

export const EMERGENCY_CONTACT_KINDS = [
  "general",
  "police",
  "ambulance",
  "rescue",
  "mountain_rescue",
  "other",
] as const;
export type EmergencyContactKind = (typeof EMERGENCY_CONTACT_KINDS)[number];

export interface EmergencyContactsTable {
  id: UuidPk;
  region_id: ColumnType<string, string | undefined, never>;
  kind: EmergencyContactKind;
  name_i18n: Jsonb<LocalizedText>;
  /** E.164 или короткий номер службы (112, 101…). */
  phone: string;
  description_i18n: ColumnType<LocalizedText | null, LocalizedText | null | undefined, LocalizedText | null>;
  sort_order: ColumnType<number, number | undefined, number>;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type EmergencyContact = Selectable<EmergencyContactsTable>;
export type NewEmergencyContact = Insertable<EmergencyContactsTable>;
export type EmergencyContactUpdate = Updateable<EmergencyContactsTable>;

export const PROMOTION_AD_LABELS = ["advertising", "partner"] as const;
export type PromotionAdLabel = (typeof PROMOTION_AD_LABELS)[number];
export const PROMOTION_STATUSES = ["draft", "scheduled", "active", "paused", "ended", "cancelled"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/**
 * Платное размещение — только сущность: эндпоинтов создания и продажи нет до D-63. Публичный каталог (блок 4,
 * ADR-0019) только читает действующее размещение ради метки adLabel (порядок и бейдж не меняет).
 */
export interface PromotionsTable {
  id: UuidPk;
  region_id: ColumnType<string, string | undefined, never>;
  place_id: ColumnType<string | null, string | null | undefined, string | null>;
  title_i18n: Jsonb<LocalizedText>;
  ad_label: ColumnType<PromotionAdLabel, PromotionAdLabel | undefined, PromotionAdLabel>;
  starts_at: Timestamp;
  ends_at: Timestamp;
  status: ColumnType<PromotionStatus, PromotionStatus | undefined, PromotionStatus>;
  created_by: ColumnType<string | null, string | null | undefined, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Promotion = Selectable<PromotionsTable>;
export type NewPromotion = Insertable<PromotionsTable>;

// --- Каталог (tenant; миграция 0012, ADR-0017): населённые пункты, категории, теги, места, график, фото, бейдж ---

/** Изменяемая колонка с NULL: при вставке необязательна. */
type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;
/** region_id tenant-таблицы: подставляет TenantGuardPlugin из контекста (в SYSTEM — явно), не меняется. */
type RegionId = ColumnType<string, string | undefined, never>;
/** geometry(Point, 4326): запись — выражением point() (db/geo.ts), чтение — lonLatOf(). */
type GeoPoint = ColumnType<Geometry | null, Geometry | null | undefined, Geometry | null>;

export const LOCALITY_KINDS = ["settlement", "zone", "landmark"] as const;
export type LocalityKind = (typeof LOCALITY_KINDS)[number];

export interface LocalitiesTable {
  id: UuidPk;
  region_id: RegionId;
  code: string;
  kind: ColumnType<LocalityKind, LocalityKind | undefined, LocalityKind>;
  name_i18n: Jsonb<LocalizedText>;
  location: GeoPoint;
  sort_order: Generated<number>;
  active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Locality = Selectable<LocalitiesTable>;
export type NewLocality = Insertable<LocalitiesTable>;
export type LocalityUpdate = Updateable<LocalitiesTable>;

/** Кнопки главной C02 (ТЗ §4.2), CHECK categories_home_section_check. */
export const HOME_SECTIONS = ["about", "eat", "shop", "relax", "fun", "nearby", "transfer", "help"] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];

export interface CategoriesTable {
  id: UuidPk;
  region_id: RegionId;
  parent_id: Nullable<string>;
  code: string;
  name_i18n: Jsonb<LocalizedText>;
  icon: Nullable<string>;
  home_section: Nullable<HomeSection>;
  sort_order: Generated<number>;
  active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Category = Selectable<CategoriesTable>;
export type NewCategory = Insertable<CategoriesTable>;
export type CategoryUpdate = Updateable<CategoriesTable>;

export const TAG_GROUPS = ["cuisine", "audience", "amenity", "season", "weather", "other"] as const;
export type TagGroup = (typeof TAG_GROUPS)[number];

export interface TagsTable {
  id: UuidPk;
  region_id: RegionId;
  code: string;
  name_i18n: Jsonb<LocalizedText>;
  tag_group: ColumnType<TagGroup, TagGroup | undefined, TagGroup>;
  sort_order: Generated<number>;
  active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Tag = Selectable<TagsTable>;
export type NewTag = Insertable<TagsTable>;
export type TagUpdate = Updateable<TagsTable>;

export const PLACE_STATUSES = ["draft", "published", "suspended", "archived"] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

export interface PlacesTable {
  id: UuidPk;
  region_id: RegionId;
  category_id: string;
  locality_id: Nullable<string>;
  name_i18n: Jsonb<LocalizedText>;
  description_i18n: Nullable<LocalizedText>;
  address_i18n: Nullable<LocalizedText>;
  location: GeoPoint;
  phone: Nullable<string>;
  website: Nullable<string>;
  telegram: Nullable<string>;
  status: ColumnType<PlaceStatus, PlaceStatus | undefined, PlaceStatus>;
  recommended: ColumnType<boolean, boolean | undefined, boolean>;
  verified_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  first_published_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_by: ColumnType<string | null, string | null | undefined, never>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type Place = Selectable<PlacesTable>;
export type NewPlace = Insertable<PlacesTable>;
export type PlaceUpdate = Updateable<PlacesTable>;

export interface PlaceTagsTable {
  region_id: RegionId;
  place_id: ColumnType<string, string, never>;
  tag_id: ColumnType<string, string, never>;
  created_at: CreatedAt;
}

/** Время местное, "HH:MM:SS" (pg отдаёт time строкой). */
export type LocalTime = string;

export interface PlaceSchedulesTable {
  id: UuidPk;
  region_id: RegionId;
  place_id: ColumnType<string, string, never>;
  day_of_week: number;
  opens_at: LocalTime;
  closes_at: LocalTime;
  created_at: CreatedAt;
}
export type PlaceSchedule = Selectable<PlaceSchedulesTable>;

export interface PlaceScheduleExceptionsTable {
  id: UuidPk;
  region_id: RegionId;
  place_id: ColumnType<string, string, never>;
  /** date: pg отдаёт Date (полночь по часовому поясу процесса) — читается через to_char в репозитории. */
  date: ColumnType<string, string, string>;
  closed: boolean;
  opens_at: Nullable<LocalTime>;
  closes_at: Nullable<LocalTime>;
  note_i18n: Nullable<LocalizedText>;
  created_at: CreatedAt;
}
export type PlaceScheduleException = Selectable<PlaceScheduleExceptionsTable>;

export interface PlaceMediaTable {
  id: UuidPk;
  region_id: RegionId;
  place_id: ColumnType<string, string, never>;
  media_asset_id: ColumnType<string, string, never>;
  sort_order: ColumnType<number, number | undefined, number>;
  is_cover: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}
export type PlaceMedia = Selectable<PlaceMediaTable>;

export const BADGE_ACTIONS = ["grant", "revoke"] as const;
export type BadgeAction = (typeof BADGE_ACTIONS)[number];

/** Только дописывается (0012: у app — SELECT, INSERT). */
export interface PlaceBadgeEventsTable {
  id: UuidPk;
  region_id: RegionId;
  place_id: ColumnType<string, string, never>;
  action: ColumnType<BadgeAction, BadgeAction, never>;
  reason: ColumnType<string, string, never>;
  actor_user_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: InsertedAt;
}
export type PlaceBadgeEvent = Selectable<PlaceBadgeEventsTable>;

// --- favorites (tenant; миграция 0014, блок 4, ADR-0019) ---

/** Место в избранном пользователя; у app — SELECT, INSERT, DELETE. */
export interface FavoritesTable {
  id: UuidPk;
  region_id: RegionId;
  user_id: ColumnType<string, string, never>;
  place_id: ColumnType<string, string, never>;
  created_at: InsertedAt;
}
export type Favorite = Selectable<FavoritesTable>;
export type NewFavorite = Insertable<FavoritesTable>;

export interface Database {
  app_meta: AppMetaTable;
  feature_flags: FeatureFlagsTable;
  feature_flag_gate_marks: FeatureFlagGateMarksTable;
  regions: RegionsTable;
  users: UsersTable;
  audit_logs: AuditLogsTable;
  audit_log_pii: AuditLogPiiTable;
  idempotency_keys: IdempotencyKeysTable;
  analytics_events: AnalyticsEventsTable;
  role_assignments: RoleAssignmentsTable;
  sessions: SessionsTable;
  media_assets: MediaAssetsTable;
  telegram_accounts: TelegramAccountsTable;
  consents: ConsentsTable;
  messaging_consents: MessagingConsentsTable;
  privacy_requests: PrivacyRequestsTable;
  risk_flags: RiskFlagsTable;
  qr_points: QrPointsTable;
  qr_scan_events: QrScanEventsTable;
  entry_contexts: EntryContextsTable;
  attribution_touches: AttributionTouchesTable;
  admin_credentials: AdminCredentialsTable;
  admin_login_failures: AdminLoginFailuresTable;
  emergency_contacts: EmergencyContactsTable;
  promotions: PromotionsTable;
  // Каталог (0012, ADR-0017).
  localities: LocalitiesTable;
  categories: CategoriesTable;
  tags: TagsTable;
  places: PlacesTable;
  place_tags: PlaceTagsTable;
  place_schedules: PlaceSchedulesTable;
  place_schedule_exceptions: PlaceScheduleExceptionsTable;
  place_media: PlaceMediaTable;
  place_badge_events: PlaceBadgeEventsTable;
  // Публичный каталог (0014, ADR-0019).
  favorites: FavoritesTable;
}

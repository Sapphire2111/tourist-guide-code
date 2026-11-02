-- 0002: каркас базовых сущностей (T1-09): regions, users, audit_logs, idempotency_keys, analytics_events.
-- Без бизнес-логики. Соглашения — docs/adr/0006-orm-migrations.md; модель — docs/discovery/roles-and-data.md
-- (§2.1, §2.2, §2.12, §2.13). Перечисления — text + CHECK, а не enum: новое значение добавляется
-- обычной миграцией (DROP/ADD CONSTRAINT) и сразу доступно в той же транзакции.
-- Типы для Kysely — apps/api/src/db/schema.ts.

-- Код языка: ISO 639-1/2 в нижнем регистре, опционально регион ISO 3166 (uk, en, pl, pt-BR).
CREATE FUNCTION is_language_code(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT v ~ '^[a-z]{2,3}(-[A-Z]{2})?$' $$;

-- Мультиязычное поле (*_i18n, T1-15): jsonb-объект «код языка -> текст»; uk — обязательный базовый язык
-- (непустая строка), остальные языки необязательны, все значения — строки, ключи — коды языков.
-- Вызов внутри тела — со схемой: при pg_restore search_path пуст, а функция участвует в CHECK.
-- CASE задаёт порядок: jsonb_each на не-объекте бросает ошибку, а AND порядок вычисления не гарантирует.
CREATE FUNCTION is_localized_text(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN v IS NULL OR jsonb_typeof(v) <> 'object' THEN false
    WHEN jsonb_typeof(v -> 'uk') IS DISTINCT FROM 'string' OR btrim(v ->> 'uk') = '' THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_each(v) AS e(lang, txt)
      WHERE NOT public.is_language_code(e.lang) OR jsonb_typeof(e.txt) <> 'string'
    )
  END
$$;

-- global: регион — сам tenant (корень изоляции, PLATFORM-справочник), region_id у него нет.
-- Удаление региона запрещено (только suspend) — все FK на regions с ON DELETE RESTRICT.
CREATE TABLE regions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  code text NOT NULL CONSTRAINT regions_code_key UNIQUE
    CONSTRAINT regions_code_format CHECK (code ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  name_i18n jsonb NOT NULL CONSTRAINT regions_name_i18n_uk CHECK (is_localized_text(name_i18n)),
  status text NOT NULL DEFAULT 'draft'
    CONSTRAINT regions_status_check CHECK (status IN ('draft', 'active', 'suspended')),
  -- IANA-зона; правильность имени проверяет приложение (CHECK не может обращаться к pg_timezone_names).
  timezone text NOT NULL DEFAULT 'Europe/Kyiv',
  default_language text NOT NULL DEFAULT 'uk'
    CONSTRAINT regions_default_language_format CHECK (is_language_code(default_language)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER regions_set_updated_at BEFORE UPDATE ON regions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- global: один человек во всех регионах (roles-and-data §2.1). Минимальный каркас: профиль, телефон,
-- home_region_id, last_seen_at и др. — в задачах блока 2. Привязка к Telegram — отдельная сущность
-- TelegramAccount (telegram_user_id уникален, удаляется при анонимизации), здесь её нет.
-- Физически не удаляется: удаление аккаунта = анонимизация со статусом deleted_anonymized (D-48).
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT users_status_check CHECK (status IN ('active', 'blocked', 'deleted_anonymized')),
  language text NOT NULL DEFAULT 'uk' CONSTRAINT users_language_format CHECK (is_language_code(language)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- tenant-optional (ADR-006): region_id допускает NULL — действие уровня PLATFORM/SYSTEM (глобальные
-- справочники, назначения PLATFORM) не относится к региону. Регион-админ видит только region_id = контекст,
-- NULL — только PLATFORM-роли (T1-10, RLS — T1-11).
-- Журнал действий (ТЗ §12.1; roles-and-data §2.12). Записи не меняются, поэтому updated_at нет.
-- НЕ здесь (T1-13): запрет UPDATE/DELETE (триггер + права роли), ПДн-часть (IP/device/session) в отдельной
-- таблице с удаляемым сроком хранения (D-73), role_assignment_id (T1-12), approval_request_id.
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  actor_type text NOT NULL CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IN ('user', 'system')),
  -- RESTRICT: пользователи не удаляются физически (анонимизация), журнал не теряет актора.
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  region_id uuid REFERENCES regions(id) ON DELETE RESTRICT,
  -- Код действия — permission-код из roles-and-data §1.3 (например role.assign).
  action text NOT NULL CONSTRAINT audit_logs_action_not_blank CHECK (btrim(action) <> ''),
  entity_type text NOT NULL CONSTRAINT audit_logs_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
  -- text, а не uuid: у части сущностей естественный ключ (флаги T1-22, app_meta).
  entity_id text,
  -- ПДн в old/new — маскированно или ссылкой (roles-and-data §2.12).
  old_values jsonb,
  new_values jsonb,
  reason text,
  -- correlation id запроса (T1-17/T1-18).
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- system — без пользователя; user — обязательно с пользователем.
  CONSTRAINT audit_logs_actor_consistent CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL))
);

-- История объекта, лента региона, действия пользователя (заодно индексы на FK).
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at);
CREATE INDEX audit_logs_region_created_idx ON audit_logs (region_id, created_at);
CREATE INDEX audit_logs_actor_user_created_idx ON audit_logs (actor_user_id, created_at)
  WHERE actor_user_id IS NOT NULL;

-- global: область — принципал (roles-and-data §2.13). Хранилище для Idempotency-Key (T1-14):
-- scope — строка принципала и эндпоинта, формат задаёт middleware (например "user:<uuid>:POST /transactions").
-- Ключи временные: истёкшие удаляет фоновая задача по expires_at. Логика повтора/блокировки — T1-14.
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  scope text NOT NULL CONSTRAINT idempotency_keys_scope_not_blank CHECK (btrim(scope) <> ''),
  key text NOT NULL CONSTRAINT idempotency_keys_key_length CHECK (char_length(key) BETWEEN 1 AND 255),
  -- sha256 тела запроса (hex): тот же ключ с другим телом — ошибка.
  request_hash text NOT NULL CONSTRAINT idempotency_keys_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'in_progress'
    CONSTRAINT idempotency_keys_status_check CHECK (status IN ('in_progress', 'completed', 'failed')),
  -- Сохранённый ответ для повтора.
  response_status integer CONSTRAINT idempotency_keys_response_status_range CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_scope_key_key UNIQUE (scope, key),
  CONSTRAINT idempotency_keys_completed_has_response CHECK (status <> 'completed' OR response_status IS NOT NULL)
);

CREATE TRIGGER idempotency_keys_set_updated_at BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

-- Продуктовые события (ТЗ §15.1; ADR-004, рекомендация D-56). Только таблица: каталог событий, валидация
-- свойств, путь записи через очередь, партиционирование и срок хранения (D-73) — T1-25/T1-30.
-- tenant-optional (ADR-006): region_id допускает NULL — событие гостя до выбора региона (app_opened);
-- такие события видят только PLATFORM-роли (T1-10/T1-11).
-- properties — без ПДн (телефонов, имён, точных координат). Записи не меняются, поэтому updated_at нет.
CREATE TABLE analytics_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_name text NOT NULL CONSTRAINT analytics_events_event_name_format CHECK (event_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  schema_version integer NOT NULL CONSTRAINT analytics_events_schema_version_positive CHECK (schema_version > 0),
  -- Момент события у источника; created_at — момент записи.
  occurred_at timestamptz NOT NULL,
  -- Псевдоним пользователя (roles-and-data §2.12, ADR-004: актор — псевдоним, не ПДн), без FK на users:
  -- события не связаны с учётной записью напрямую. Способ получения псевдонима — T1-25; NULL — гость/без
  -- согласия. При удалении аккаунта связь разрывается обнулением (индекс ниже).
  pseudonymous_user_id uuid,
  region_id uuid REFERENCES regions(id) ON DELETE RESTRICT,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT analytics_events_properties_object CHECK (jsonb_typeof(properties) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX analytics_events_name_occurred_idx ON analytics_events (event_name, occurred_at);
CREATE INDEX analytics_events_region_occurred_idx ON analytics_events (region_id, occurred_at);
-- События одного псевдонима (воронки) и обнуление при удалении аккаунта.
CREATE INDEX analytics_events_pseudonymous_user_idx ON analytics_events (pseudonymous_user_id)
  WHERE pseudonymous_user_id IS NOT NULL;

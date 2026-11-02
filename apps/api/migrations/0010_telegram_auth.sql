-- 0010: вход через Telegram и профиль (блок 2, часть 2A; ADR-0015). README apps/api, «Вход через Telegram».
-- Вход: initData Mini App → проверка HMAC и auth_date → User + TelegramAccount → Session (0006). Профиль: язык и имя
-- отображения, согласия (D-41, каркас), согласие боту писать (requestWriteAccess, ТЗ §11.2), запросы экспорта/удаления
-- (D-48, каркас), признаки риска (неудачные входы).
--
-- Изоляция (ADR-005): всё, кроме risk_flags, — global: человек один во всех регионах (users — global), согласия
-- с условиями/политикой платформы и подписка на единственного бота (D-50) не принадлежат региону. risk_flags —
-- tenant-optional: признаки фрода бонусов/амбассадоров (блоки 9, 11) будут региональными, а признак неудачного
-- входа региона не имеет (NULL — видит только SYSTEM/PLATFORM, как в audit_logs).
--
-- ПДн (D-48): только в users (display_name) и telegram_accounts; остальные таблицы ссылаются на user_id.
-- Анонимизация (блок 8): telegram_accounts удаляется, display_name и analytics_id стираются/меняются.

-- Имя отображения (из Telegram при первом входе, затем правит пользователь) и псевдоним для аналитики:
-- analytics_events.pseudonymous_user_id — не users.id (ADR-004), случайный uuid; при анонимизации меняется.
ALTER TABLE users
  ADD COLUMN display_name text CONSTRAINT users_display_name_check
    CHECK (display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND 64 AND display_name = btrim(display_name))),
  ADD COLUMN analytics_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX users_analytics_id_key ON users (analytics_id);

-- global: привязка пользователя к Telegram (roles-and-data §2.1 «TelegramAccount»), 1:1 в MVP. Поля — из
-- initData.user последнего входа (обновляются при каждом входе).
CREATE TABLE telegram_accounts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  -- RESTRICT: пользователи физически не удаляются; при анонимизации удаляется привязка.
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Telegram user id: до 52 бит (Bot API), в JS — безопасное целое; pg отдаёт bigint строкой.
  telegram_user_id bigint NOT NULL CONSTRAINT telegram_accounts_tg_id_check
    CHECK (telegram_user_id > 0 AND telegram_user_id <= 9007199254740991),
  username text CONSTRAINT telegram_accounts_username_check CHECK (char_length(username) BETWEEN 1 AND 64),
  first_name text CONSTRAINT telegram_accounts_first_name_check CHECK (char_length(first_name) <= 256),
  last_name text CONSTRAINT telegram_accounts_last_name_check CHECK (char_length(last_name) <= 256),
  language_code text CONSTRAINT telegram_accounts_language_code_check CHECK (char_length(language_code) <= 35),
  photo_url text CONSTRAINT telegram_accounts_photo_url_check CHECK (char_length(photo_url) <= 2048),
  is_premium boolean NOT NULL DEFAULT false,
  -- Флаг из initData (пользователь разрешил боту писать); согласие — messaging_consents.
  allows_write_to_pm boolean NOT NULL DEFAULT false,
  -- auth_date последнего принятого initData.
  last_auth_date timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER telegram_accounts_set_updated_at BEFORE UPDATE ON telegram_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Вход: поиск по telegram_user_id; один аккаунт на пользователя (1:1).
CREATE UNIQUE INDEX telegram_accounts_tg_user_key ON telegram_accounts (telegram_user_id);
CREATE UNIQUE INDEX telegram_accounts_user_key ON telegram_accounts (user_id);

-- global: согласия пользователя (D-41 каркас, roles-and-data §2.1 «Consent»). Append-only: принятие — новая
-- строка, отзыв — withdrawn_at (один раз); повторное принятие после отзыва — новая строка. Текущее состояние вида —
-- последняя действующая строка. Версия — версия текста документа (тексты — D-41, на staging заглушки).
CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- terms — условия, privacy — политика конфиденциальности, service/marketing — обработка данных для сервисных и
  -- маркетинговых сообщений (ТЗ §4.1, §11.2: раздельно).
  kind text NOT NULL CONSTRAINT consents_kind_check CHECK (kind IN ('terms', 'privacy', 'service', 'marketing')),
  document_version text NOT NULL CONSTRAINT consents_document_version_check
    CHECK (document_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  -- Где принято: Mini App (C01/C15), бот, админка (ручная запись по заявлению).
  channel text NOT NULL DEFAULT 'mini_app' CONSTRAINT consents_channel_check
    CHECK (channel IN ('mini_app', 'bot', 'admin_web')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consents_withdrawn_after_grant CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

-- Одна действующая строка на вид и версию (повторное принятие той же версии не плодит строки).
CREATE UNIQUE INDEX consents_active_key ON consents (user_id, kind, document_version) WHERE withdrawn_at IS NULL;
CREATE INDEX consents_user_idx ON consents (user_id, kind, granted_at);

-- Неизменность: меняется только withdrawn_at и только с NULL на значение (отзыв не отменяется).
CREATE FUNCTION consents_guard_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'consents: отозванное согласие не меняется (id %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.user_id, NEW.kind, NEW.document_version, NEW.channel, NEW.granted_at, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.kind, OLD.document_version, OLD.channel, OLD.granted_at, OLD.created_at)
  THEN
    RAISE EXCEPTION 'consents: меняется только withdrawn_at (id %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER consents_guard_update BEFORE UPDATE ON consents
  FOR EACH ROW EXECUTE FUNCTION consents_guard_update();

-- global: разрешение боту писать пользователю (ТЗ §11.2; результат WebApp.requestWriteAccess). Текущее состояние на
-- (пользователь, канал, назначение): сервисные и маркетинговые — раздельно; история изменений — в audit_logs.
CREATE TABLE messaging_consents (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  channel text NOT NULL DEFAULT 'telegram_bot' CONSTRAINT messaging_consents_channel_check
    CHECK (channel IN ('telegram_bot')),
  purpose text NOT NULL CONSTRAINT messaging_consents_purpose_check CHECK (purpose IN ('service', 'marketing')),
  granted boolean NOT NULL,
  -- Откуда пришло последнее изменение: request_write_access — ответ Telegram на запрос в Mini App, settings — профиль.
  source text NOT NULL CONSTRAINT messaging_consents_source_check
    CHECK (source IN ('request_write_access', 'settings', 'bot')),
  granted_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messaging_consents_state CHECK (NOT granted OR granted_at IS NOT NULL)
);

CREATE TRIGGER messaging_consents_set_updated_at BEFORE UPDATE ON messaging_consents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX messaging_consents_user_key ON messaging_consents (user_id, channel, purpose);

-- global: запрос экспорта/удаления данных (D-48, каркас; roles-and-data §2.1 «PrivacyRequest»). Обработка
-- (privacy.request.process), сроки и результат — блок 8 / D-41, D-48.
CREATE TABLE privacy_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CONSTRAINT privacy_requests_kind_check CHECK (kind IN ('export', 'delete')),
  status text NOT NULL DEFAULT 'received' CONSTRAINT privacy_requests_status_check
    CHECK (status IN ('received', 'in_progress', 'done', 'rejected')),
  handled_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  handled_at timestamptz,
  rejection_reason text CONSTRAINT privacy_requests_rejection_reason_check
    CHECK (char_length(rejection_reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT privacy_requests_rejection_consistent CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL))
);

CREATE TRIGGER privacy_requests_set_updated_at BEFORE UPDATE ON privacy_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Один открытый запрос каждого вида на пользователя (повтор возвращает существующий).
CREATE UNIQUE INDEX privacy_requests_open_key ON privacy_requests (user_id, kind)
  WHERE status IN ('received', 'in_progress');
CREATE INDEX privacy_requests_status_idx ON privacy_requests (status, created_at);
CREATE INDEX privacy_requests_handled_by_idx ON privacy_requests (handled_by) WHERE handled_by IS NOT NULL;

-- tenant-optional: признак риска (roles-and-data §2.1 «RiskFlag»; ТЗ §12.1, §14.4). Сейчас пишется при отказе во
-- входе (подделанный/просроченный initData): region_id NULL, user_id — если личность известна. details — без ПДн
-- (без initData, IP, имён): только коды и id.
CREATE TABLE risk_flags (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid REFERENCES regions(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CONSTRAINT risk_flags_kind_check
    CHECK (kind IN ('invalid_init_data', 'expired_init_data', 'manual')),
  severity text NOT NULL DEFAULT 'low' CONSTRAINT risk_flags_severity_check
    CHECK (severity IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'open' CONSTRAINT risk_flags_status_check
    CHECK (status IN ('open', 'confirmed', 'dismissed')),
  details jsonb NOT NULL DEFAULT '{}' CONSTRAINT risk_flags_details_object CHECK (jsonb_typeof(details) = 'object'),
  -- Correlation id запроса (найти строки лога).
  request_id text CONSTRAINT risk_flags_request_id_check CHECK (char_length(request_id) <= 255),
  resolved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_flags_resolution_consistent CHECK ((status = 'open') = (resolved_at IS NULL))
);

CREATE TRIGGER risk_flags_set_updated_at BEFORE UPDATE ON risk_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Лента признаков (фильтр TenantGuardPlugin по региону) и FK.
CREATE INDEX risk_flags_region_idx ON risk_flags (region_id, created_at);
CREATE INDEX risk_flags_user_idx ON risk_flags (user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX risk_flags_open_idx ON risk_flags (kind, created_at) WHERE status = 'open';
CREATE INDEX risk_flags_resolved_by_idx ON risk_flags (resolved_by) WHERE resolved_by IS NOT NULL;

SELECT app_enable_tenant_rls('risk_flags');

-- ALTER DEFAULT PRIVILEGES (0003) действует, только если миграции выполняет та же роль-владелец, — права явно.
-- Логин-роль api (tg_api) — член группы app (README «Роли БД»). DELETE — только привязке Telegram (анонимизация).
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_accounts TO app;
GRANT SELECT, INSERT, UPDATE ON consents, messaging_consents, privacy_requests, risk_flags TO app;
-- ALTER DEFAULT PRIVILEGES (0003) уже выдал app DELETE на новые таблицы (если владелец тот же) — снять явно:
-- согласия, запросы данных и признаки риска не удаляются (история; анонимизация — блок 8).
REVOKE DELETE, TRUNCATE ON consents, messaging_consents, privacy_requests, risk_flags FROM app;

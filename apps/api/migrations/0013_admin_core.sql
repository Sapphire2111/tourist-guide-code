-- 0013: ядро админки (блок 3, часть 3B; ADR-0018). README apps/api, «Вход админа», «Экстренные контакты».
-- Вход админа по логину и паролю (admin_credentials), экстренные контакты региона для экрана «Халепа?»
-- (emergency_contacts) и каркас платного размещения (promotions, выдача и показ — после D-63).
-- Не зависит от 0012 (каталог мест идёт параллельно): только regions и users. place_id в promotions — uuid без FK,
-- как в qr_points (0011): FK на places — отдельной миграцией после слияния каталога (expand/contract).

-- global (ADR-005): учётные данные человека, не региона (users — global). Одна запись на пользователя.
-- Пароль — только хэш scrypt в самоописываемой строке `scrypt$<N>$<r>$<p>$<соль base64url>$<ключ base64url>`
-- (apps/api/src/modules/admin-auth/password-hash.ts): параметры можно усилить без миграции, старые хэши
-- продолжают проверяться. Логин — нижний регистр (e-mail или имя), сравнивается без учёта регистра в api.
-- 2FA (D-52, TOTP по рекомендации) отложена тестовым режимом (implementation-backlog §1.6): mfa_method — каркас,
-- api отказывает во входе учётке с заданным методом (тот же 401), пока он не реализован (fail closed, ADR-0018).
CREATE TABLE admin_credentials (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  -- RESTRICT: пользователи физически не удаляются (анонимизация удаляет эту запись).
  user_id uuid NOT NULL CONSTRAINT admin_credentials_user_key UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  login text NOT NULL CONSTRAINT admin_credentials_login_key UNIQUE
    CONSTRAINT admin_credentials_login_format CHECK (login ~ '^[a-z0-9][a-z0-9._@+-]{2,253}$'),
  password_hash text NOT NULL CONSTRAINT admin_credentials_password_hash_format
    CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'),
  -- Глобальный счётчик неудач по логину (со всех адресов) в окне 1 час с failure_window_started_at; при 50-й —
  -- блокировка учётки до locked_until (15 мин). Высокий порог: блокировку после 5 неудач считает пара логин + адрес
  -- (admin_login_failures), иначе любой мог бы запереть чужую учётку (ADR-0018).
  failed_attempts integer NOT NULL DEFAULT 0 CONSTRAINT admin_credentials_failed_attempts_check
    CHECK (failed_attempts BETWEEN 0 AND 100),
  failure_window_started_at timestamptz,
  locked_until timestamptz,
  last_login_at timestamptz,
  mfa_method text CONSTRAINT admin_credentials_mfa_method_check CHECK (mfa_method IN ('totp')),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER admin_credentials_set_updated_at BEFORE UPDATE ON admin_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ALTER DEFAULT PRIVILEGES (0003) мог выдать app лишнее — права явно. DELETE нет: запись удаляет только
-- анонимизация (блок 8, отдельная функция); история входов — в audit_logs.
REVOKE ALL ON admin_credentials FROM app;
GRANT SELECT, INSERT, UPDATE ON admin_credentials TO app;

-- global: неудачные входы по паре «логин + адрес клиента» — 5 неудач за 15 минут блокируют вход с этого адреса на
-- 15 минут, не запирая учётку для остальных (ADR-0018). Ключи — HMAC-SHA256 логина и адреса с серверным ключом
-- ADMIN_LOGIN_HMAC_SECRET: это псевдонимизация, а не обезличивание (с ключом значение проверяется, поэтому строки —
-- псевдонимные ПДн со сроком хранения сутки); без ключа перебрать логины и IPv4 по таблице нельзя. FK на учётку нет
-- намеренно: несуществующий логин считается так же, как существующий (одинаковые запросы — одинаковое время).
-- Строки старше суток api удаляет после каждой неудачной попытки отдельным оператором (до 100 строк, SKIP LOCKED);
-- успешный вход удаляет строку своей пары.
CREATE TABLE admin_login_failures (
  login_hash bytea NOT NULL CONSTRAINT admin_login_failures_login_hash_length CHECK (octet_length(login_hash) = 32),
  client_hash bytea NOT NULL CONSTRAINT admin_login_failures_client_hash_length
    CHECK (octet_length(client_hash) = 32),
  failed_attempts integer NOT NULL CONSTRAINT admin_login_failures_failed_attempts_check
    CHECK (failed_attempts BETWEEN 1 AND 100),
  locked_until timestamptz,
  last_failed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_login_failures_pkey PRIMARY KEY (login_hash, client_hash)
);

-- Очистка устаревших строк.
CREATE INDEX admin_login_failures_last_failed_idx ON admin_login_failures (last_failed_at);

REVOKE ALL ON admin_login_failures FROM app;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_login_failures TO app;

-- tenant (ADR-005): экстренные контакты региона (ТЗ §4.2 «Халепа?»). Публичная выдача туристу — только active,
-- по sort_order; правка — админ региона (emergency_contact.manage). Телефон — E.164 или короткий номер
-- экстренной службы (112, 101, 102, 103): короткие номера в E.164 не записываются, а набираются как есть.
CREATE TABLE emergency_contacts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  -- general — единый номер (112); police, ambulance, rescue (ДСНС), mountain_rescue, other.
  kind text NOT NULL CONSTRAINT emergency_contacts_kind_check
    CHECK (kind IN ('general', 'police', 'ambulance', 'rescue', 'mountain_rescue', 'other')),
  name_i18n jsonb NOT NULL CONSTRAINT emergency_contacts_name_check CHECK (is_localized_text(name_i18n)),
  phone text NOT NULL CONSTRAINT emergency_contacts_phone_format
    CHECK (phone ~ '^(\+[1-9][0-9]{6,14}|[0-9]{2,6})$'),
  description_i18n jsonb CONSTRAINT emergency_contacts_description_check
    CHECK (description_i18n IS NULL OR is_localized_text(description_i18n)),
  sort_order integer NOT NULL DEFAULT 0 CONSTRAINT emergency_contacts_sort_order_check
    CHECK (sort_order BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER emergency_contacts_set_updated_at BEFORE UPDATE ON emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Публичный список региона (active, по порядку) и список админки.
CREATE INDEX emergency_contacts_region_idx ON emergency_contacts (region_id, sort_order, id);

SELECT app_enable_tenant_rls('emergency_contacts');
REVOKE ALL ON emergency_contacts FROM app;
GRANT SELECT, INSERT, UPDATE, DELETE ON emergency_contacts TO app;

-- tenant (ADR-005): платное размещение (ТЗ §4.3, §14.2) — только сущность. Выдача и показ туристу выключены до
-- D-63 (⚖, рекомендация — «только поле в модели»): api не читает таблицу ни в одном эндпоинте. Метка «реклама»
-- обязательна (ad_label NOT NULL + CHECK): реклама не может появиться без маркировки и отдельна от бейджа
-- «Ми рекомендуємо» (RecommendationBadge, C-01/C-02).
CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  -- Место каталога (0012, блок 3); FK — после слияния каталога.
  place_id uuid,
  title_i18n jsonb NOT NULL CONSTRAINT promotions_title_check CHECK (is_localized_text(title_i18n)),
  -- «Реклама» / «Партнер» (ТЗ §4.3): какой ярлык увидит турист; без ярлыка строку не записать.
  ad_label text NOT NULL DEFAULT 'advertising' CONSTRAINT promotions_ad_label_check
    CHECK (ad_label IN ('advertising', 'partner')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CONSTRAINT promotions_status_check
    CHECK (status IN ('draft', 'scheduled', 'active', 'paused', 'ended', 'cancelled')),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotions_period_check CHECK (ends_at > starts_at)
);

CREATE TRIGGER promotions_set_updated_at BEFORE UPDATE ON promotions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX promotions_region_idx ON promotions (region_id, starts_at);
CREATE INDEX promotions_place_idx ON promotions (place_id) WHERE place_id IS NOT NULL;
CREATE INDEX promotions_created_by_idx ON promotions (created_by) WHERE created_by IS NOT NULL;

SELECT app_enable_tenant_rls('promotions');
REVOKE ALL ON promotions FROM app;
GRANT SELECT, INSERT, UPDATE, DELETE ON promotions TO app;

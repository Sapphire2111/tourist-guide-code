-- 0006: серверные сессии (T1-26; roles-and-data §1.2 шаг 1, §2.1 «Session»; ADR-0009). README apps/api, «Сессии».
-- Клиент получает непрозрачный токен один раз при выдаче; в БД — только его sha256 (32 байта): утечка таблицы
-- не даёт рабочих токенов. Отзыв — revoked_at (выход, блокировка); истёкшие и отозванные удаляет очистка.
-- Поля Session из roles-and-data, которых здесь нет (mode, mfa_verified_at, ip_hash, device_hash), — с их
-- сценариями (блок 2 — вход Telegram, блок 6 — 2FA админов, D-52).

-- global: сессия принадлежит пользователю (users — global), не региону. active_region_id — не tenant-колонка, а
-- выбранный регион режима партнёра/админа (D-50): из него сервер берёт tenant-контекст, если в регионе есть
-- назначение роли (иначе 403). Регион туриста для публичного каталога — отдельно (блок 2, README).
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  -- RESTRICT: пользователи физически не удаляются (анонимизация отзывает сессии).
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL CONSTRAINT sessions_token_hash_length CHECK (octet_length(token_hash) = 32),
  -- Канал входа: mini_app (initData Telegram, блок 2), admin_web (вход админки, блок 6), dev (только local).
  channel text NOT NULL CONSTRAINT sessions_channel_check CHECK (channel IN ('mini_app', 'admin_web', 'dev')),
  active_region_id uuid REFERENCES regions(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CONSTRAINT sessions_revoke_reason_check
    CHECK (revoke_reason IN ('logout', 'user_blocked', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_expires_after_create CHECK (expires_at > created_at),
  CONSTRAINT sessions_revoke_consistent CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);

CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Поиск сессии по токену на каждом запросе.
CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
-- Действующие сессии пользователя (отзыв всех при блокировке/выходе со всех устройств).
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
-- Очистка истёкших.
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
-- FK на regions.
CREATE INDEX sessions_active_region_idx ON sessions (active_region_id) WHERE active_region_id IS NOT NULL;

-- ALTER DEFAULT PRIVILEGES (0003) действует, только если миграции выполняет та же роль-владелец, — права явно,
-- как в 0004/0005. DELETE — очистка истёкших сессий.
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app;

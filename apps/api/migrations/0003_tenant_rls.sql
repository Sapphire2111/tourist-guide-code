-- 0003: второй рубеж изоляции регионов — row-level security (T1-11; ADR-005, ADR-006). Первый рубеж —
-- серверный фильтр TenantGuardPlugin (apps/api/src/db/tenant-guard.plugin.ts, T1-10).
--
-- Роли. Роли общие для кластера PostgreSQL, поэтому создаются идемпотентно; паролей в миграции нет.
--   app — NOLOGIN-группа прав приложения: DML на таблицы, без владения объектами и без DDL; не SUPERUSER и
--         не BYPASSRLS, поэтому RLS к её членам применяется. Логин-роль api (DATABASE_URL) заводится вне
--         миграций и включается в группу (README apps/api, «Роли БД»):
--           CREATE ROLE tg_api LOGIN PASSWORD '…' IN ROLE app;
--   роль миграций — владелец схемы (DATABASE_MIGRATION_URL), та, что выполняет миграции; отдельно не
--         создаётся. Для создания app ей нужен CREATEROLE (или app создана заранее администратором).
--
-- Контекст — переменные сессии, которые withTenant() (apps/api/src/db/tenant-context.ts) выставляет первой
-- командой транзакции через set_config(…, true) = SET LOCAL (сбрасываются при COMMIT/ROLLBACK):
--   app.region_id — uuid региона: видны и пишутся только строки region_id = app.region_id;
--   app.actor     — 'system' (фоновые задачи) или 'platform' (PLATFORM-роли): все регионы и строки с
--                   region_id IS NULL у tenant-optional таблиц.
-- Без контекста политики не пропускают ни одной строки: SELECT/UPDATE/DELETE видят пусто, INSERT — ошибка.
-- FORCE ROW LEVEL SECURITY: политики действуют и на владельца таблиц (если он не SUPERUSER/BYPASSRLS),
-- поэтому миграция данных в tenant-таблицах начинается с SELECT set_config('app.actor', 'system', true).
-- Новая tenant-таблица: в своей миграции — SELECT app_enable_tenant_rls('<таблица>'); права app — по
-- ALTER DEFAULT PRIVILEGES ниже (если миграции выполняет та же роль-владелец).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    BEGIN
      CREATE ROLE app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION
      -- Создана параллельно миграцией другой базы того же кластера: в зависимости от момента гонки —
      -- duplicate_object или unique_violation (уникальный индекс pg_authid).
      WHEN duplicate_object OR unique_violation THEN NULL;
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'Нет прав создать роль app (нужен CREATEROLE)'
          USING HINT = 'Создайте её администратором: CREATE ROLE app NOLOGIN; и повторите миграции.';
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Роль app с SUPERUSER или BYPASSRLS: RLS к ней не применяется';
  END IF;
END
$$;

-- Права app: чтение и DML, без DDL. CREATE в схеме public у PUBLIC отозван по умолчанию с PostgreSQL 15;
-- отзыв явно — на случай базы, созданной иначе. schema_migrations (учёт раннера) app не доступна.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT ON app_meta TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON regions, users, idempotency_keys, audit_logs, analytics_events TO app;
-- Таблицы и последовательности следующих миграций (созданные той же ролью-владельцем) — сразу с правами app.
-- Запрет UPDATE/DELETE журналов (audit_logs, analytics_events) — T1-13.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app;

-- Регион контекста или NULL (не выставлен / сброшен после транзакции — тогда значение ''). Не uuid — ошибка
-- приведения типа (withTenant проверяет формат заранее). Простые STABLE SQL-функции встраиваются в план.
-- Индексы по region_id сама политика не задействует: две PERMISSIVE-политики складываются в
-- `region_id = app_current_region_id() OR app_is_cross_tenant()`. Индексный доступ даёт фильтр
-- `region_id = :регион`, который TenantGuardPlugin добавляет в запрос (RLS — страховка, не путь доступа).
CREATE FUNCTION app_current_region_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.region_id', true), '')::uuid $$;

-- Кросс-tenant режим: SYSTEM (фоновые задачи) или PLATFORM (PLATFORM-роли).
CREATE FUNCTION app_is_cross_tenant() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT coalesce(current_setting('app.actor', true), '') IN ('system', 'platform') $$;

-- RLS для tenant и tenant-optional таблицы (колонка region_id). Политики PERMISSIVE складываются через OR:
--   tenant_region — строки своего региона (region_id IS NULL не проходит: NULL = x — не true);
--   tenant_cross  — всё в режиме SYSTEM/PLATFORM.
-- USING ограничивает видимые/изменяемые строки, WITH CHECK — новые значения (INSERT и UPDATE): регион не
-- запишет строку в чужой регион или с NULL и не перенесёт свою строку в другой регион.
-- Функции в политиках — со схемой: при pg_restore search_path пуст.
CREATE FUNCTION app_enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_region ON %s USING (region_id = public.app_current_region_id()) '
    'WITH CHECK (region_id = public.app_current_region_id())',
    tbl
  );
  EXECUTE format(
    'CREATE POLICY tenant_cross ON %s USING (public.app_is_cross_tenant()) '
    'WITH CHECK (public.app_is_cross_tenant())',
    tbl
  );
END
$$;

-- Вызывает только роль миграций (ALTER TABLE всё равно требует владения).
REVOKE EXECUTE ON FUNCTION app_enable_tenant_rls(regclass) FROM PUBLIC;

SELECT app_enable_tenant_rls('audit_logs');
SELECT app_enable_tenant_rls('analytics_events');

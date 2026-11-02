-- 0001: базовая инициализация БД (T1-05, переписана в T1-08 до первого развёртывания).
-- Соглашения схемы — docs/adr/0006-orm-migrations.md. Применённую миграцию не менять:
-- раннер сверяет контрольную сумму файла.

-- PostGIS: геометрии SRID 4326, расстояния в метрах через geography.
CREATE EXTENSION IF NOT EXISTS postgis;
-- pgcrypto не нужен: gen_random_uuid() встроен в PostgreSQL 13+.

-- UUIDv7 (RFC 9562): время в первых 48 битах (мс) -> ключи растут по времени, B-tree индекс
-- не фрагментируется на больших таблицах (события, аудит). Остальные биты — из gen_random_uuid().
-- В PostgreSQL 18 есть встроенная pg_catalog.uuidv7(). DEFAULT хранит ссылку на функцию (OID), а не
-- имя, поэтому после pg_upgrade существующие таблицы продолжат вызывать public.uuidv7(); новые таблицы
-- на 18 разрешат имя в pg_catalog.uuidv7(). Переход на встроенную — отдельной миграцией
-- (ALTER TABLE ... ALTER COLUMN id SET DEFAULT pg_catalog.uuidv7(), затем DROP FUNCTION public.uuidv7()).
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;

-- updated_at ставит БД, а не приложение: покрывает и сырой SQL, и ручные правки.
-- Подключение к таблице: CREATE TRIGGER <t>_set_updated_at BEFORE UPDATE ON <t>
--   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Служебная таблица (глобальная, не tenant): метаданные схемы; заодно проверяет, что миграции применяются.
CREATE TABLE app_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER app_meta_set_updated_at BEFORE UPDATE ON app_meta
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO app_meta (key, value) VALUES ('schema_origin', 'T1-08');

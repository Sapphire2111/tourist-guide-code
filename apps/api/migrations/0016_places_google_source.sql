-- 0016: источник места каталога — импорт настоящих мест из Google Maps (Places API (New), решение владельца
-- 02.11.2026: гид работает на живых данных пилота D-01). CLI places:import-google, README apps/api, «Импорт мест из
-- Google». Номер 0015 занят параллельной задачей блока 5; порядок применения не важен — миграции независимы.
--
-- source — откуда место: manual (админка, seed) или google (импорт). google_place_id — id места Google: по нему
-- импорт делает идемпотентный upsert (UNIQUE в регионе; у manual — NULL, NULL-ы UNIQUE не мешают).
-- last_synced_at — когда данные места последний раз сверены с Google (verified_at — «дата перевірки» для туриста,
-- её админ может обновить и вручную).
ALTER TABLE places
  ADD COLUMN source text NOT NULL DEFAULT 'manual'
    CONSTRAINT places_source_check CHECK (source IN ('manual', 'google')),
  ADD COLUMN google_place_id text
    CONSTRAINT places_google_place_id_format CHECK (google_place_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  ADD COLUMN last_synced_at timestamptz,
  ADD CONSTRAINT places_google_source_consistent CHECK ((source = 'google') = (google_place_id IS NOT NULL)),
  ADD CONSTRAINT places_region_google_place_id_key UNIQUE (region_id, google_place_id);

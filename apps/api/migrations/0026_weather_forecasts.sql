-- 0026: прогноз погоды на нашем сервере (просьба владельца 03.11.2026). Mini App ходит только к нашему api
-- (GET /weather), к Google/Open-Meteo — никогда. Прогноз хранится по фиксированным точкам: центры населённых
-- пунктов (localities kind = settlement) и горные точки из кода api (Говерла, Заросляк, Хом'як, Буковель); запрос
-- туриста по координатам отдаётся из ближайшей точки. Обновляет api (фоновый тик под advisory lock и лениво при
-- запросе, если снимок устарел); источник — Google Weather (квота google_api_usage, kind weather), запасной —
-- Open-Meteo.

SELECT set_config('app.actor', 'system', true);

-- global: данные погоды публичные и одинаковы для всех регионов (точка — координаты, не объект региона).
-- point_key: "locality:<uuid>" или "mountain:<code>". forecast — нормализованный прогноз (форма — WeatherSnapshot в
-- api, modules/weather), NULL — точка заведена, данных ещё нет. content_hash — отпечаток содержимого без времени
-- замера: updated_at меняется только при изменении прогноза, fetched_at — при каждом успешном обновлении.
CREATE TABLE weather_forecasts (
  point_key text PRIMARY KEY CONSTRAINT weather_forecasts_point_key_check CHECK (point_key ~ '^[a-z]+:[a-z0-9_-]{1,64}$'),
  kind text NOT NULL CONSTRAINT weather_forecasts_kind_check CHECK (kind IN ('settlement', 'mountain')),
  lat double precision NOT NULL CONSTRAINT weather_forecasts_lat_check CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CONSTRAINT weather_forecasts_lng_check CHECK (lng BETWEEN -180 AND 180),
  source text CONSTRAINT weather_forecasts_source_check CHECK (source IS NULL OR source IN ('google', 'open-meteo')),
  forecast jsonb CONSTRAINT weather_forecasts_forecast_check CHECK (forecast IS NULL OR jsonb_typeof(forecast) = 'object'),
  content_hash text CONSTRAINT weather_forecasts_hash_check CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON weather_forecasts FROM app;
GRANT SELECT, INSERT, UPDATE, DELETE ON weather_forecasts TO app;

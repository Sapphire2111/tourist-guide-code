-- 0025: сезонность сценариев «Мій план» (просьба владельца 03.11.2026). scenarios.seasons — времена года, когда
-- сценарий уместен (winter/spring/summer/autumn по Europe/Kyiv; пустой массив — круглый год). Турист видит только
-- сценарии текущего сезона (зимой — без летних походов в горы), админка показывает и фильтрует по сезону.
-- Прежние теги «Взимку»/«Влітку» (winter/summer) переезжают в seasons и из tags убираются — тег больше не означает
-- сезон. Перечень — как SCENARIO_SEASONS в api (ScenarioSeason в OpenAPI).

SELECT set_config('app.actor', 'system', true);

ALTER TABLE scenarios
  ADD COLUMN seasons text[] NOT NULL DEFAULT '{}' CONSTRAINT scenarios_seasons_check
    CHECK (seasons <@ ARRAY['winter', 'spring', 'summer', 'autumn']::text[]);

UPDATE scenarios
-- Порядок — как SCENARIO_SEASONS в api (зима → осінь), без повторов.
SET seasons = ARRAY(
      SELECT o.s FROM unnest(ARRAY['winter', 'spring', 'summer', 'autumn']) WITH ORDINALITY AS o(s, n)
      WHERE o.s = ANY(tags) AND o.s IN ('winter', 'summer') ORDER BY o.n
    ),
    tags = array_remove(array_remove(tags, 'winter'), 'summer')
WHERE tags && ARRAY['winter', 'summer']::text[];

-- Выдача туристу: опубликованные сценарии региона нужного сезона (seasons = '{}' или содержит сезон).
CREATE INDEX scenarios_seasons_idx ON scenarios USING gin (seasons);

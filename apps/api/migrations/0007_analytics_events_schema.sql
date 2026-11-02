-- 0007: схема аналитических событий (T1-25; ТЗ §15.1, D-56, ADR-004; roles-and-data «AnalyticsEvent»).
-- Каталог событий и проверка props — в коде (@tg/shared, analytics.ts); здесь — поля конверта, которых не было
-- в каркасе 0002, и функция записи для worker (очередь analytics) и api (прямая запись на staging).

-- Анонимное устройство/установка (до регистрации или без согласия), сессия приложения, источник входа,
-- контекст входа (EntryContext, блок 2) и место. FK нет: таблиц EntryContext/Place ещё нет, а событие
-- не должно мешать удалению сущности — это журнал. anonymous_id и session_id — псевдонимные ПДн (идентификаторы
-- устройства и сессии): обнуление по запросу (privacy request), срок хранения — D-73.
ALTER TABLE analytics_events
  ADD COLUMN anonymous_id uuid,
  ADD COLUMN session_id uuid,
  ADD COLUMN source text NOT NULL DEFAULT 'system'
    CONSTRAINT analytics_events_source_format CHECK (source ~ '^[a-z][a-z_]{0,31}$'),
  ADD COLUMN entry_context_id uuid,
  ADD COLUMN place_id uuid;

-- Обнуление анонимного id по запросу (privacy request) — как у pseudonymous_user_id.
CREATE INDEX analytics_events_anonymous_idx ON analytics_events (anonymous_id) WHERE anonymous_id IS NOT NULL;

-- Запись одного события (поля — snake_case, как колонки). Идемпотентна по id (eventId эмиттера): повтор задачи
-- очереди не создаёт дубль; возвращает true, если строка вставлена. На время INSERT выставляет app.actor = 'system'
-- (RLS: событие гостя без региона пишет только SYSTEM) и восстанавливает прежнее значение — как
-- audit_purge_expired_pii (0004). Функция только вставляет в журнал событий; проверка схемы события — в коде
-- до вызова. Несуществующий region_id — нарушение FK (23503): api отклоняет такой пакет заранее, worker считает
-- ошибку постоянной (без ретраев). Не SECURITY DEFINER: права — роли app.
CREATE FUNCTION analytics_record_event(e jsonb) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  inserted integer;
BEGIN
  IF e IS NULL OR jsonb_typeof(e) <> 'object' THEN
    RAISE EXCEPTION 'analytics_record_event: ожидается jsonb-объект' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  INSERT INTO public.analytics_events (
    id, event_name, schema_version, occurred_at, pseudonymous_user_id, anonymous_id, session_id, region_id,
    source, entry_context_id, place_id, properties
  ) VALUES (
    (e ->> 'id')::uuid,
    e ->> 'event_name',
    (e ->> 'schema_version')::integer,
    (e ->> 'occurred_at')::timestamptz,
    (e ->> 'pseudonymous_user_id')::uuid,
    (e ->> 'anonymous_id')::uuid,
    (e ->> 'session_id')::uuid,
    (e ->> 'region_id')::uuid,
    e ->> 'source',
    (e ->> 'entry_context_id')::uuid,
    (e ->> 'place_id')::uuid,
    coalesce(e -> 'properties', '{}'::jsonb)
  )
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN inserted > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION analytics_record_event(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_record_event(jsonb) TO app;

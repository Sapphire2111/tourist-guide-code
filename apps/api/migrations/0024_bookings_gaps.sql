-- 0024: пробелы блока 7 перед включением module.bookings. (1) Служебный код причины — отдельно от свободного текста:
-- bookings.status_reason_code (метки системы и воркера), status_reason — только текст туриста/партнёра; в истории
-- брони — reason (текст) и payload.code (метка), системные переходы пишут reason = NULL. (2) Неизвестный PostgreSQL
-- часовой пояс региона не роняет всю пачку истечений и напоминаний: время форматируется через
-- booking_safe_timezone() (Europe/Kyiv → Europe/Kiev на старой tzdata, иначе UTC), а уведомления каждой брони — в
-- отдельном блоке исключений (ошибка одной записи не откатывает переходы остальных). (3) Outbox воркера: взятая, но не
-- отмеченная строка (воркер упал, attempts = 1) больше не висит вечно — аренда next_attempt_at, повтор до
-- p_max_attempts, затем failed; повторяемая ошибка (429 Telegram с retry_after, 5xx, сеть) — notifications_release
-- откладывает повтор.

SELECT set_config('app.actor', 'system', true);

-- (1) Код причины брони. Перечень — как BOOKING_REASON_CODES в api (BookingReasonCode в OpenAPI).
ALTER TABLE bookings
  ADD COLUMN status_reason_code text CONSTRAINT bookings_status_reason_code_check CHECK (status_reason_code IN (
    'delivered_to_partner', 'auto_confirm', 'alternative_declined', 'partner_sla', 'customer_timeout', 'auto_complete'));

-- Перенос: метка, записанная в status_reason (функции 0022/0023 и отказ от альтернативы без текста), — в код.
UPDATE bookings
SET status_reason_code = status_reason, status_reason = NULL
WHERE status_reason IN ('alternative_declined', 'partner_sla', 'customer_timeout', 'auto_complete');
-- Отказ от альтернативы с текстом туриста: метка была только в payload события.
UPDATE bookings b
SET status_reason_code = 'alternative_declined'
FROM booking_events e
WHERE e.region_id = b.region_id AND e.booking_id = b.id
  AND b.status = 'cancelled_by_user' AND b.status_reason_code IS NULL
  AND e.to_status = 'cancelled_by_user' AND e.payload ->> 'code' = 'alternative_declined';

-- (2) Пояс региона, который знает PostgreSQL: сам пояс; Europe/Kyiv на tzdata до 2022b — Europe/Kiev; иначе UTC.
CREATE FUNCTION booking_safe_timezone(p_tz text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate text;
BEGIN
  FOREACH candidate IN ARRAY ARRAY[p_tz, CASE WHEN p_tz = 'Europe/Kyiv' THEN 'Europe/Kiev' END] LOOP
    CONTINUE WHEN candidate IS NULL;
    BEGIN
      PERFORM now() AT TIME ZONE candidate;
      RETURN candidate;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
  RETURN 'UTC';
END
$$;

REVOKE EXECUTE ON FUNCTION booking_safe_timezone(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION booking_notification_head(p_booking_id uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT 'Бронювання №' || right(b.id::text, 6) || ' (' || coalesce(p.name_i18n ->> 'uk', '') || ' — '
    || coalesce(r.name_i18n ->> 'uk', '') || ', '
    || to_char(p_at AT TIME ZONE public.booking_safe_timezone(g.timezone), 'DD.MM, HH24:MI') || ')'
  FROM public.bookings b
  JOIN public.places p ON p.id = b.place_id
  JOIN public.resources r ON r.id = b.resource_id
  JOIN public.regions g ON g.id = b.region_id
  WHERE b.id = p_booking_id
$$;

-- Авто-истечение (0023) + код причины в status_reason_code (status_reason и reason события — NULL: свободного текста
-- нет) и изоляция уведомлений одной брони: ошибка (пояс, данные получателя) — WARNING, переход остаётся.
CREATE OR REPLACE FUNCTION bookings_expire_due(p_batch integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  rec record;
  head text;
  n integer := 0;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'bookings_expire_due: пачка — >= 1' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  FOR rec IN
    WITH due AS (
      SELECT b.id, b.status, b.alternative_starts_at FROM public.bookings b
      WHERE (b.status = 'pending_partner' AND b.partner_response_due_at <= now())
         OR (b.status = 'alternative_proposed' AND b.customer_response_due_at <= now())
      ORDER BY b.id
      LIMIT p_batch
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.bookings b
    SET status = 'expired',
        status_reason = NULL,
        status_reason_code = CASE WHEN due.status = 'pending_partner' THEN 'partner_sla' ELSE 'customer_timeout' END,
        alternative_starts_at = NULL, alternative_ends_at = NULL, customer_response_due_at = NULL,
        closed_at = now(), version = b.version + 1
    FROM due WHERE b.id = due.id
    RETURNING b.id, b.region_id, b.organization_id, b.place_id, b.user_id, b.starts_at, due.status AS from_status,
      due.alternative_starts_at AS alt_starts_at, b.status_reason_code AS code
  LOOP
    n := n + 1;
    INSERT INTO public.booking_events (region_id, booking_id, from_status, to_status, actor_type, reason, payload)
    VALUES (rec.region_id, rec.id, rec.from_status, 'expired', 'system', NULL, jsonb_build_object('code', rec.code));
    INSERT INTO public.analytics_events (id, event_name, schema_version, occurred_at, pseudonymous_user_id,
      region_id, source, place_id, properties)
    SELECT public.uuidv7(), 'booking_expired', 1, now(), u.analytics_id, rec.region_id, 'system', rec.place_id,
      jsonb_build_object('bookingId', rec.id, 'placeId', rec.place_id, 'reason', rec.code)
    FROM public.users u WHERE u.id = rec.user_id;
    BEGIN
      head := public.booking_notification_head(rec.id, coalesce(rec.alt_starts_at, rec.starts_at));
      IF rec.code = 'partner_sla' THEN
        PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id, ARRAY[rec.user_id], 'booking.expired',
          head || ': заклад не відповів вчасно, бронювання скасовано. Оберіть інший час або інший заклад.');
        PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id,
          public.booking_partner_recipients(rec.organization_id, rec.place_id), 'booking.expired',
          head || ': минув час на відповідь — бронювання скасовано автоматично, час звільнено.');
      ELSE
        PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id, ARRAY[rec.user_id], 'booking.expired',
          head || ': ви не відповіли на запропонований час, бронювання скасовано. Можна забронювати знову.');
        PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id,
          public.booking_partner_recipients(rec.organization_id, rec.place_id), 'booking.expired',
          head || ': клієнт не відповів на запропонований час — бронювання скасовано автоматично, час звільнено.');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'bookings_expire_due: уведомления брони % не поставлены: %', rec.id, SQLERRM;
    END;
  END LOOP;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN n;
END
$$;

-- Автозавершение (0023) + код причины и изоляция уведомления одной брони.
CREATE OR REPLACE FUNCTION bookings_auto_complete(p_after_hours integer DEFAULT 24, p_batch integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  rec record;
  n integer := 0;
BEGIN
  IF p_after_hours IS NULL OR p_after_hours < 1 OR p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'bookings_auto_complete: часы — >= 1, пачка — >= 1' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  FOR rec IN
    WITH due AS (
      SELECT b.id FROM public.bookings b
      WHERE b.status = 'confirmed' AND b.ends_at <= now() - make_interval(hours => p_after_hours)
      ORDER BY b.id
      LIMIT p_batch
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.bookings b
    SET status = 'completed', status_reason = NULL, status_reason_code = 'auto_complete', completed_at = now(),
        closed_at = now(), version = b.version + 1
    FROM due WHERE b.id = due.id
    RETURNING b.id, b.region_id, b.place_id, b.user_id, b.starts_at
  LOOP
    n := n + 1;
    INSERT INTO public.booking_events (region_id, booking_id, from_status, to_status, actor_type, reason, payload)
    VALUES (rec.region_id, rec.id, 'confirmed', 'completed', 'system', NULL, jsonb_build_object('code', 'auto_complete'));
    INSERT INTO public.analytics_events (id, event_name, schema_version, occurred_at, pseudonymous_user_id,
      region_id, source, place_id, properties)
    SELECT public.uuidv7(), 'booking_completed', 1, now(), u.analytics_id, rec.region_id, 'system', rec.place_id,
      jsonb_build_object('bookingId', rec.id, 'placeId', rec.place_id)
    FROM public.users u WHERE u.id = rec.user_id;
    BEGIN
      PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id, ARRAY[rec.user_id], 'booking.auto_completed',
        public.booking_notification_head(rec.id, rec.starts_at) || ': завершено. Дякуємо, що завітали!');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'bookings_auto_complete: уведомление брони % не поставлено: %', rec.id, SQLERRM;
    END;
  END LOOP;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN n;
END
$$;

-- Напоминания (0023) + безопасный пояс и изоляция уведомления одной брони (отметка остаётся: повтор не нужен).
CREATE OR REPLACE FUNCTION bookings_send_reminders(
  p_user_before_min integer[], p_partner_before_due_min integer, p_batch integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  offsets integer[];
  k integer;
  lower_k integer;
  i integer;
  rec record;
  n integer := 0;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_partner_before_due_min IS NULL OR p_partner_before_due_min < 0
     OR p_user_before_min IS NULL
     OR EXISTS (SELECT 1 FROM unnest(p_user_before_min) v WHERE v IS NULL OR v < 1 OR v > 99999) THEN
    RAISE EXCEPTION 'bookings_send_reminders: минуты — 1…99999, срок партнёра — >= 0, пачка — >= 1'
      USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  SELECT coalesce(array_agg(DISTINCT v ORDER BY v), '{}'::integer[]) INTO offsets FROM unnest(p_user_before_min) v;
  FOR i IN 1 .. coalesce(array_length(offsets, 1), 0) LOOP
    k := offsets[i];
    lower_k := CASE WHEN i = 1 THEN 0 ELSE offsets[i - 1] END;
    FOR rec IN
      WITH due AS (
        SELECT b.id, b.region_id, b.user_id, b.starts_at, b.people_count FROM public.bookings b
        WHERE b.status = 'confirmed' AND b.user_id IS NOT NULL
          AND b.starts_at > now() + make_interval(mins => lower_k)
          AND b.starts_at <= now() + make_interval(mins => k)
          AND b.confirmed_at <= b.starts_at - make_interval(mins => k)
          AND NOT EXISTS (SELECT 1 FROM public.booking_reminders r WHERE r.booking_id = b.id AND r.kind = 'user_' || k)
        ORDER BY b.starts_at, b.id
        LIMIT p_batch
        FOR UPDATE OF b SKIP LOCKED
      ), marked AS (
        INSERT INTO public.booking_reminders (region_id, booking_id, kind)
        SELECT due.region_id, due.id, 'user_' || k FROM due
        ON CONFLICT (booking_id, kind) DO NOTHING
        RETURNING booking_id
      )
      SELECT due.* FROM due JOIN marked ON marked.booking_id = due.id
    LOOP
      n := n + 1;
      BEGIN
        PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id, ARRAY[rec.user_id], 'booking.reminder',
          'Нагадування: ' || public.booking_notification_head(rec.id, rec.starts_at) || ', гостей: '
          || rec.people_count || '. Якщо плани змінились — скасуйте бронювання в застосунку.');
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'bookings_send_reminders: напоминание брони % не поставлено: %', rec.id, SQLERRM;
      END;
    END LOOP;
  END LOOP;
  FOR rec IN
    WITH due AS (
      SELECT b.id, b.region_id, b.organization_id, b.place_id, b.starts_at, b.partner_response_due_at,
        g.timezone FROM public.bookings b
      JOIN public.regions g ON g.id = b.region_id
      WHERE b.status = 'pending_partner'
        AND b.partner_response_due_at > now()
        AND b.partner_response_due_at <= now() + make_interval(mins => p_partner_before_due_min)
        AND b.partner_response_due_at - make_interval(mins => p_partner_before_due_min) > b.created_at
        AND NOT EXISTS (SELECT 1 FROM public.booking_reminders r WHERE r.booking_id = b.id AND r.kind = 'partner_sla')
      ORDER BY b.partner_response_due_at, b.id
      LIMIT p_batch
      FOR UPDATE OF b SKIP LOCKED
    ), marked AS (
      INSERT INTO public.booking_reminders (region_id, booking_id, kind)
      SELECT due.region_id, due.id, 'partner_sla' FROM due
      ON CONFLICT (booking_id, kind) DO NOTHING
      RETURNING booking_id
    )
    SELECT due.* FROM due JOIN marked ON marked.booking_id = due.id
  LOOP
    n := n + 1;
    BEGIN
      PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id,
        public.booking_partner_recipients(rec.organization_id, rec.place_id), 'booking.partner_reminder',
        public.booking_notification_head(rec.id, rec.starts_at) || ' чекає на підтвердження. Дайте відповідь до '
        || to_char(rec.partner_response_due_at AT TIME ZONE public.booking_safe_timezone(rec.timezone), 'HH24:MI')
        || ', інакше бронювання скасується автоматично.');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'bookings_send_reminders: напоминание партнёру брони % не поставлено: %', rec.id, SQLERRM;
    END;
  END LOOP;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN n;
END
$$;

-- (3) Outbox воркера: аренда взятой строки и срок повтора. NULL — строку никто не держит (новая или итоговая).
ALTER TABLE notifications ADD COLUMN next_attempt_at timestamptz;

-- Строки, взятые воркером до 0024 и не отмеченные (attempts = 1, воркер упал между взятием и отметкой), — повтор.
UPDATE notifications
SET next_attempt_at = now()
WHERE status = 'pending' AND attempts > 0 AND next_attempt_at IS NULL
  AND template IN ('booking.expired', 'booking.auto_completed', 'booking.reminder', 'booking.partner_reminder');

CREATE INDEX notifications_worker_retry_idx ON notifications (next_attempt_at)
  WHERE status = 'pending' AND attempts > 0;

-- Взятие строк к отправке: новые (attempts = 0) и те, чья аренда или срок повтора истёк (attempts < p_max_attempts).
-- Взятая строка получает attempts + 1 и аренду now() + p_lease_sec: воркер упал — через аренду её возьмут снова.
-- Исчерпавшие попытки с истёкшей арендой — failed (max_attempts). Возвращает строки к отправке и номер попытки.
DROP FUNCTION notifications_claim_pending(text[], integer);

CREATE FUNCTION notifications_claim_pending(
  p_templates text[], p_batch integer DEFAULT 100, p_max_attempts integer DEFAULT 5, p_lease_sec integer DEFAULT 600)
RETURNS TABLE (id uuid, chat_id text, body text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_templates IS NULL OR p_max_attempts IS NULL OR p_max_attempts < 1
     OR p_lease_sec IS NULL OR p_lease_sec < 1 THEN
    RAISE EXCEPTION 'notifications_claim_pending: шаблоны обязательны, пачка, попытки и аренда — >= 1'
      USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  UPDATE public.notifications x
  SET status = 'failed', next_attempt_at = NULL,
      last_error = left(coalesce(x.last_error || '; ', '') || 'max_attempts', 300)
  WHERE x.status = 'pending' AND x.attempts >= p_max_attempts AND x.next_attempt_at <= now()
    AND x.template = ANY (p_templates);
  RETURN QUERY
    WITH picked AS (
      SELECT x.id FROM public.notifications x
      WHERE x.status = 'pending' AND x.template = ANY (p_templates)
        AND (x.attempts = 0 OR (x.attempts < p_max_attempts AND x.next_attempt_at <= now()))
      ORDER BY x.created_at, x.id
      LIMIT p_batch
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE public.notifications x
      SET attempts = x.attempts + 1,
          status = CASE WHEN ta.telegram_user_id IS NULL THEN 'skipped' ELSE x.status END,
          last_error = CASE WHEN ta.telegram_user_id IS NULL THEN 'no_telegram_account' ELSE x.last_error END,
          next_attempt_at = CASE WHEN ta.telegram_user_id IS NULL THEN NULL
            ELSE now() + make_interval(secs => p_lease_sec) END
      FROM picked
      LEFT JOIN public.notifications src ON src.id = picked.id
      LEFT JOIN public.telegram_accounts ta ON ta.user_id = src.recipient_user_id
      WHERE x.id = picked.id
      RETURNING x.id, ta.telegram_user_id, x.body, x.status, x.attempts
    )
    SELECT c.id, c.telegram_user_id::text, c.body, c.attempts FROM claimed c WHERE c.status = 'pending';
  PERFORM set_config('app.actor', prev_actor, true);
END
$$;

REVOKE EXECUTE ON FUNCTION notifications_claim_pending(text[], integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications_claim_pending(text[], integer, integer, integer) TO app;

-- Итог отправки (0023) + снятие аренды.
CREATE OR REPLACE FUNCTION notifications_mark_dispatched(p_id uuid, p_status text, p_error text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  updated integer;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'notifications_mark_dispatched: статус — sent, failed или skipped' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  UPDATE public.notifications
  SET status = p_status, last_error = left(p_error, 300), sent_at = CASE WHEN p_status = 'sent' THEN now() END,
      next_attempt_at = NULL
  WHERE id = p_id AND status = 'pending';
  GET DIAGNOSTICS updated = ROW_COUNT;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN updated > 0;
END
$$;

-- Повторяемая ошибка отправки взятой строки (429 Telegram — retry_after, 5xx, сеть): строка остаётся pending, повтор
-- не раньше now() + p_delay_sec (попытки уже посчитаны при взятии). true — строка обновлена.
CREATE FUNCTION notifications_release(p_id uuid, p_delay_sec integer, p_error text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  updated integer;
BEGIN
  IF p_delay_sec IS NULL OR p_delay_sec < 0 OR p_delay_sec > 86400 THEN
    RAISE EXCEPTION 'notifications_release: задержка — 0…86400 с' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  UPDATE public.notifications
  SET next_attempt_at = now() + make_interval(secs => p_delay_sec), last_error = left(p_error, 300)
  WHERE id = p_id AND status = 'pending';
  GET DIAGNOSTICS updated = ROW_COUNT;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION notifications_release(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications_release(uuid, integer, text) TO app;

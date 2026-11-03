-- 0023: уведомления и напоминания броней от воркера (блок 7; states-and-rules §3.4, ТЗ §10.4; D-43 А «турист
-- уведомляется», D-66). Переходы SYSTEM (bookings_expire_due, bookings_auto_complete — миграция 0022) теперь в той же
-- транзакции пишут уведомления в outbox notifications (блок 5) — повтор воркера не дублирует их: бронь уже вышла из
-- статуса. Напоминания (туристу перед началом, партнёру о неподтверждённой брони перед SLA) — один раз на бронь и вид:
-- отметка booking_reminders (уникальна). Служебная метка причины — всегда в booking_events.payload.code. Отправку
-- строк outbox, созданных воркером, делает воркер (notifications_claim_pending / notifications_mark_dispatched): api
-- отправляет только свои строки по id сразу после коммита — пересечений нет.

-- tenant: отметка отправленного напоминания брони (одна на бронь и вид; ставится и тогда, когда получателю писать
-- нельзя — нет Telegram или согласия, — чтобы бронь не перебиралась каждый тик). kind: user_<минуты до начала>,
-- partner_sla.
CREATE TABLE booking_reminders (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL,
  kind text NOT NULL CONSTRAINT booking_reminders_kind_check CHECK (kind ~ '^(user_[0-9]{1,5}|partner_sla)$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_reminders_booking_fk FOREIGN KEY (region_id, booking_id)
    REFERENCES bookings (region_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_reminders_once UNIQUE (booking_id, kind)
);

CREATE INDEX booking_reminders_region_booking_idx ON booking_reminders (region_id, booking_id);

SELECT app_enable_tenant_rls('booking_reminders');
REVOKE ALL ON booking_reminders FROM app;
GRANT SELECT ON booking_reminders TO app;

-- Напоминания туристу: подтверждённые брони по времени начала.
CREATE INDEX bookings_confirmed_start_idx ON bookings (starts_at) WHERE status = 'confirmed';
-- Строки outbox, которые отправляет воркер (шаблоны booking.* системных переходов и напоминаний).
CREATE INDEX notifications_worker_pending_idx ON notifications (template, created_at)
  WHERE status = 'pending' AND attempts = 0;

-- Заголовок уведомления брони, как в api (BookingsService.notifyStatus): «Бронювання №<6 знаков id> (<место> —
-- <ресурс>, ДД.ММ, ЧЧ:ММ)»; время — местное время региона брони. Вызывается из функций ниже (SYSTEM).
CREATE FUNCTION booking_notification_head(p_booking_id uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT 'Бронювання №' || right(b.id::text, 6) || ' (' || coalesce(p.name_i18n ->> 'uk', '') || ' — '
    || coalesce(r.name_i18n ->> 'uk', '') || ', ' || to_char(p_at AT TIME ZONE g.timezone, 'DD.MM, HH24:MI') || ')'
  FROM public.bookings b
  JOIN public.places p ON p.id = b.place_id
  JOIN public.resources r ON r.id = b.resource_id
  JOIN public.regions g ON g.id = b.region_id
  WHERE b.id = p_booking_id
$$;

REVOKE EXECUTE ON FUNCTION booking_notification_head(uuid, timestamptz) FROM PUBLIC;

-- Получатели-партнёры брони — как BookingsRepository.partnerUsers: действующие назначения ORG_OWNER/ORG_MANAGER/
-- ORG_STAFF на организацию или место.
CREATE FUNCTION booking_partner_recipients(p_organization_id uuid, p_place_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(array_agg(DISTINCT ra.user_id), '{}'::uuid[])
  FROM public.role_assignments ra
  WHERE ra.revoked_at IS NULL
    AND ra.role IN ('ORG_OWNER', 'ORG_MANAGER', 'ORG_STAFF')
    AND ((ra.scope_type = 'ORGANIZATION' AND ra.scope_id = p_organization_id)
      OR (ra.scope_type = 'PLACE' AND ra.scope_id = p_place_id))
    AND (ra.valid_until IS NULL OR ra.valid_until > now())
$$;

REVOKE EXECUTE ON FUNCTION booking_partner_recipients(uuid, uuid) FROM PUBLIC;

-- Строки outbox брони — только получателям с привязкой Telegram и согласием на сервисные сообщения (как
-- NotificationsService.enqueue). Возвращает число вставленных строк.
CREATE FUNCTION booking_enqueue_notifications(
  p_region_id uuid, p_booking_id uuid, p_recipients uuid[], p_template text, p_body text)
RETURNS integer
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public
AS $$
  WITH ins AS (
    INSERT INTO public.notifications (region_id, recipient_user_id, template, entity_type, entity_id, body)
    SELECT p_region_id, x.u, p_template, 'booking', p_booking_id, left(p_body, 4000)
    FROM (SELECT DISTINCT unnest(p_recipients) AS u) x
    WHERE x.u IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.telegram_accounts ta WHERE ta.user_id = x.u)
      AND EXISTS (SELECT 1 FROM public.messaging_consents mc
                  WHERE mc.user_id = x.u AND mc.purpose = 'service' AND mc.granted)
    RETURNING 1
  )
  SELECT count(*)::integer FROM ins
$$;

REVOKE EXECUTE ON FUNCTION booking_enqueue_notifications(uuid, uuid, uuid[], text, text) FROM PUBLIC;

-- Авто-истечение (0022) + метка в payload события и уведомления: туристу (бот, сервисное) и партнёру.
-- partner_sla — «заклад не відповів»; customer_timeout — турист не ответил на альтернативу (время — предложенное).
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
        status_reason = CASE WHEN due.status = 'pending_partner' THEN 'partner_sla' ELSE 'customer_timeout' END,
        alternative_starts_at = NULL, alternative_ends_at = NULL, customer_response_due_at = NULL,
        closed_at = now(), version = b.version + 1
    FROM due WHERE b.id = due.id
    RETURNING b.id, b.region_id, b.organization_id, b.place_id, b.user_id, b.starts_at, due.status AS from_status,
      due.alternative_starts_at AS alt_starts_at, b.status_reason
  LOOP
    n := n + 1;
    INSERT INTO public.booking_events (region_id, booking_id, from_status, to_status, actor_type, reason, payload)
    VALUES (rec.region_id, rec.id, rec.from_status, 'expired', 'system', rec.status_reason,
      jsonb_build_object('code', rec.status_reason));
    INSERT INTO public.analytics_events (id, event_name, schema_version, occurred_at, pseudonymous_user_id,
      region_id, source, place_id, properties)
    SELECT public.uuidv7(), 'booking_expired', 1, now(), u.analytics_id, rec.region_id, 'system', rec.place_id,
      jsonb_build_object('bookingId', rec.id, 'placeId', rec.place_id, 'reason', rec.status_reason)
    FROM public.users u WHERE u.id = rec.user_id;
    head := public.booking_notification_head(rec.id, coalesce(rec.alt_starts_at, rec.starts_at));
    IF rec.status_reason = 'partner_sla' THEN
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
  END LOOP;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN n;
END
$$;

-- Автозавершение (0022) + метка в payload и уведомление туристу (states-and-rules §3.4: USER — бот, сервисное).
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
    SET status = 'completed', status_reason = 'auto_complete', completed_at = now(), closed_at = now(),
        version = b.version + 1
    FROM due WHERE b.id = due.id
    RETURNING b.id, b.region_id, b.place_id, b.user_id, b.starts_at
  LOOP
    n := n + 1;
    INSERT INTO public.booking_events (region_id, booking_id, from_status, to_status, actor_type, reason, payload)
    VALUES (rec.region_id, rec.id, 'confirmed', 'completed', 'system', 'auto_complete',
      jsonb_build_object('code', 'auto_complete'));
    INSERT INTO public.analytics_events (id, event_name, schema_version, occurred_at, pseudonymous_user_id,
      region_id, source, place_id, properties)
    SELECT public.uuidv7(), 'booking_completed', 1, now(), u.analytics_id, rec.region_id, 'system', rec.place_id,
      jsonb_build_object('bookingId', rec.id, 'placeId', rec.place_id)
    FROM public.users u WHERE u.id = rec.user_id;
    PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id, ARRAY[rec.user_id], 'booking.auto_completed',
      public.booking_notification_head(rec.id, rec.starts_at) || ': завершено. Дякуємо, що завітали!');
  END LOOP;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN n;
END
$$;

-- Напоминания (ТЗ §10.4; states-and-rules §3.4 «планируются напоминания клиенту и партнёру»):
-- 1) туристу о confirmed за p_user_before_min минут до начала (несколько значений — окна не пересекаются: бронь в
--    окне (следующее меньшее значение, k] до начала получает напоминание k; подтверждённая уже внутри окна — нет:
--    подтверждение пришло ей только что);
-- 2) партнёру о pending_partner за p_partner_before_due_min минут до срока ответа (если срок был дальше этого).
-- Один раз на бронь и вид — booking_reminders (ON CONFLICT). Отменённые, истёкшие и прочие — не берутся (статус).
-- Возвращает число поставленных отметок.
CREATE FUNCTION bookings_send_reminders(
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
      PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id, ARRAY[rec.user_id], 'booking.reminder',
        'Нагадування: ' || public.booking_notification_head(rec.id, rec.starts_at) || ', гостей: '
        || rec.people_count || '. Якщо плани змінились — скасуйте бронювання в застосунку.');
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
    PERFORM public.booking_enqueue_notifications(rec.region_id, rec.id,
      public.booking_partner_recipients(rec.organization_id, rec.place_id), 'booking.partner_reminder',
      public.booking_notification_head(rec.id, rec.starts_at) || ' чекає на підтвердження. Дайте відповідь до '
      || to_char(rec.partner_response_due_at AT TIME ZONE rec.timezone, 'HH24:MI')
      || ', інакше бронювання скасується автоматично.');
  END LOOP;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN n;
END
$$;

REVOKE EXECUTE ON FUNCTION bookings_send_reminders(integer[], integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bookings_send_reminders(integer[], integer, integer) TO app;

-- Отправка строк outbox воркером: забирает pending-строки шаблонов p_templates, ещё не бравшиеся (attempts = 0), и
-- помечает их взятыми (attempts = 1) в той же транзакции — параллельный воркер их не возьмёт (SKIP LOCKED + условие).
-- Получатель без привязки Telegram (отвязался после постановки) — сразу skipped. Возвращает строки к отправке.
CREATE FUNCTION notifications_claim_pending(p_templates text[], p_batch integer DEFAULT 100)
RETURNS TABLE (id uuid, chat_id text, body text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_templates IS NULL THEN
    RAISE EXCEPTION 'notifications_claim_pending: шаблоны обязательны, пачка — >= 1' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  RETURN QUERY
    WITH picked AS (
      SELECT x.id FROM public.notifications x
      WHERE x.status = 'pending' AND x.attempts = 0 AND x.template = ANY (p_templates)
      ORDER BY x.created_at, x.id
      LIMIT p_batch
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE public.notifications x
      SET attempts = 1,
          status = CASE WHEN ta.telegram_user_id IS NULL THEN 'skipped' ELSE x.status END,
          last_error = CASE WHEN ta.telegram_user_id IS NULL THEN 'no_telegram_account' ELSE x.last_error END
      FROM picked
      LEFT JOIN public.notifications src ON src.id = picked.id
      LEFT JOIN public.telegram_accounts ta ON ta.user_id = src.recipient_user_id
      WHERE x.id = picked.id
      RETURNING x.id, ta.telegram_user_id, x.body, x.status
    )
    SELECT c.id, c.telegram_user_id::text, c.body FROM claimed c WHERE c.status = 'pending';
  PERFORM set_config('app.actor', prev_actor, true);
END
$$;

REVOKE EXECUTE ON FUNCTION notifications_claim_pending(text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications_claim_pending(text[], integer) TO app;

-- Итог отправки взятой строки: sent / failed / skipped (бот не настроен). Только из pending; true — строка обновлена.
CREATE FUNCTION notifications_mark_dispatched(p_id uuid, p_status text, p_error text DEFAULT NULL)
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
  SET status = p_status, last_error = left(p_error, 300), sent_at = CASE WHEN p_status = 'sent' THEN now() END
  WHERE id = p_id AND status = 'pending';
  GET DIAGNOSTICS updated = ROW_COUNT;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION notifications_mark_dispatched(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications_mark_dispatched(uuid, text, text) TO app;

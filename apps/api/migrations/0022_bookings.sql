-- 0022: бронирования (блок 7; ТЗ §10, §14.1, §16.1, §16.2; D-04, D-42, D-43, D-44, D-45, D-66, D-78, C-04, C-14,
-- C-27, A-14). Серверная часть: ресурс (почасовые слоты, D-04 А), правила доступности, согласие на передачу телефона
-- конкретному партнёру (D-42 А), бронь и её история, счётчик no_show пользователя (D-44 А), авто-expired по SLA и
-- автозавершение (функции БД для воркера). Слот вычисляется из правил на лету (roles-and-data §2.4, рекомендация):
-- занятость материализуется в самой брони — интервал [occupied_from, occupied_until) с buffer до/после; ни одна пара
-- занимающих броней ресурса не пересекается — ограничение исключения (BR-08), а не только проверка в коде.
-- Новые таблицы — tenant (ADR-005): region_id NOT NULL, RLS, составные FK (region_id, …).

-- Ограничение исключения по (ресурс =, интервал &&): uuid в GiST — через btree_gist (доверенное расширение).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Счётчик no_show пользователя (D-44, принята рекомендация А): растёт при отметке no_show, уменьшается при
-- исправлении no_show → completed; при пороге (параметр api) — онлайн-бронь недоступна, только «зателефонувати».
ALTER TABLE users
  ADD COLUMN booking_no_show_count integer NOT NULL DEFAULT 0
    CONSTRAINT users_booking_no_show_count_check CHECK (booking_no_show_count >= 0);

-- tenant: бронируемый ресурс (roles-and-data §2.4 Resource; D-04 А — почасовые слоты, одна бронь на слот;
-- capacity_mode закладывается с первого дня, пока только exclusive). Цена — информационно (онлайн-оплаты нет, A-14).
-- «Доступно зараз» вручную (D-78 А): статус с коротким TTL, кто и когда поставил.
CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  place_id uuid NOT NULL,
  type text NOT NULL DEFAULT 'hourly_slot' CONSTRAINT resources_type_check CHECK (type IN ('hourly_slot')),
  capacity_mode text NOT NULL DEFAULT 'exclusive'
    CONSTRAINT resources_capacity_mode_check CHECK (capacity_mode IN ('exclusive')),
  name_i18n jsonb NOT NULL CONSTRAINT resources_name_check CHECK (is_localized_text(name_i18n)),
  description_i18n jsonb CONSTRAINT resources_description_check
    CHECK (description_i18n IS NULL OR is_localized_text(description_i18n)),
  capacity_people integer NOT NULL DEFAULT 1 CONSTRAINT resources_capacity_check CHECK (capacity_people BETWEEN 1 AND 100),
  slot_duration_min integer NOT NULL DEFAULT 60
    CONSTRAINT resources_slot_duration_check CHECK (slot_duration_min BETWEEN 15 AND 720),
  buffer_before_min integer NOT NULL DEFAULT 0
    CONSTRAINT resources_buffer_before_check CHECK (buffer_before_min BETWEEN 0 AND 240),
  buffer_after_min integer NOT NULL DEFAULT 0
    CONSTRAINT resources_buffer_after_check CHECK (buffer_after_min BETWEEN 0 AND 240),
  lead_time_min integer NOT NULL DEFAULT 60 CONSTRAINT resources_lead_time_check CHECK (lead_time_min BETWEEN 0 AND 10080),
  horizon_days integer NOT NULL DEFAULT 30 CONSTRAINT resources_horizon_check CHECK (horizon_days BETWEEN 1 AND 365),
  -- SLA ответа партнёра, мин (D-43 А: параметр; итоговый срок ещё ограничен временем до начала — api).
  confirm_sla_min integer NOT NULL DEFAULT 60 CONSTRAINT resources_confirm_sla_check CHECK (confirm_sla_min BETWEEN 5 AND 1440),
  booking_mode text NOT NULL DEFAULT 'request_confirm'
    CONSTRAINT resources_booking_mode_check CHECK (booking_mode IN ('request_confirm', 'auto_confirm')),
  price_minor bigint CONSTRAINT resources_price_check CHECK (price_minor >= 0),
  currency text CONSTRAINT resources_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  manual_availability text NOT NULL DEFAULT 'unknown'
    CONSTRAINT resources_manual_availability_check CHECK (manual_availability IN ('available_now', 'busy', 'unknown')),
  manual_availability_expires_at timestamptz,
  manual_availability_set_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  manual_availability_set_at timestamptz,
  status text NOT NULL DEFAULT 'active' CONSTRAINT resources_status_check CHECK (status IN ('active', 'inactive', 'archived')),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resources_region_id_key UNIQUE (region_id, id),
  CONSTRAINT resources_place_fk FOREIGN KEY (region_id, place_id) REFERENCES places (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT resources_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT resources_price_currency CHECK ((price_minor IS NULL) = (currency IS NULL)),
  CONSTRAINT resources_manual_consistent CHECK (manual_availability = 'unknown' OR (
    manual_availability_expires_at IS NOT NULL AND manual_availability_set_by IS NOT NULL
    AND manual_availability_set_at IS NOT NULL))
);

CREATE TRIGGER resources_set_updated_at BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX resources_place_idx ON resources (region_id, place_id, status);
CREATE INDEX resources_organization_idx ON resources (region_id, organization_id);
CREATE INDEX resources_created_by_idx ON resources (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX resources_manual_set_by_idx ON resources (manual_availability_set_by)
  WHERE manual_availability_set_by IS NOT NULL;

SELECT app_enable_tenant_rls('resources');
REVOKE ALL ON resources FROM app;
GRANT SELECT, INSERT, UPDATE ON resources TO app;

-- tenant: правила доступности ресурса (roles-and-data §2.4 AvailabilityRule): недельные окна (day_of_week 1–7, ISO)
-- и правила на дату (date) — перекрывают недельные на эту дату (closed — выходной). Минуты от полуночи местного
-- времени региона; окно не переходит через полночь (закрытие — до 24:00 = 1440). Заменяются целиком (PUT).
CREATE TABLE availability_rules (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  resource_id uuid NOT NULL,
  day_of_week smallint CONSTRAINT availability_rules_dow_check CHECK (day_of_week BETWEEN 1 AND 7),
  date date,
  closed boolean NOT NULL DEFAULT false,
  opens_min smallint CONSTRAINT availability_rules_opens_check CHECK (opens_min BETWEEN 0 AND 1439),
  closes_min smallint CONSTRAINT availability_rules_closes_check CHECK (closes_min BETWEEN 1 AND 1440),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_rules_resource_fk FOREIGN KEY (region_id, resource_id)
    REFERENCES resources (region_id, id) ON DELETE CASCADE,
  CONSTRAINT availability_rules_kind CHECK ((day_of_week IS NULL) <> (date IS NULL)),
  CONSTRAINT availability_rules_closed_only_date CHECK (NOT closed OR date IS NOT NULL),
  CONSTRAINT availability_rules_window CHECK (
    (closed AND opens_min IS NULL AND closes_min IS NULL)
    OR (NOT closed AND opens_min IS NOT NULL AND closes_min IS NOT NULL AND closes_min > opens_min))
);

CREATE INDEX availability_rules_resource_idx ON availability_rules (region_id, resource_id);

SELECT app_enable_tenant_rls('availability_rules');
REVOKE ALL ON availability_rules FROM app;
GRANT SELECT, INSERT, DELETE ON availability_rules TO app;

-- tenant: согласие на передачу телефона конкретному партнёру (ТЗ §14.1, D-42 — принята рекомендация А: на каждую
-- бронь, галочка в C08, с версией текста). Отдельная tenant-таблица, а не consents (global): согласие адресовано
-- организации и месту региона и видно только в нём (RLS). Append-only: отзыв — withdrawn_at (один раз).
CREATE TABLE partner_phone_consents (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  place_id uuid NOT NULL,
  document_version text NOT NULL CONSTRAINT partner_phone_consents_version_check
    CHECK (document_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  channel text NOT NULL DEFAULT 'mini_app' CONSTRAINT partner_phone_consents_channel_check
    CHECK (channel IN ('mini_app', 'bot')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_phone_consents_region_id_key UNIQUE (region_id, id),
  CONSTRAINT partner_phone_consents_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_phone_consents_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_phone_consents_withdrawn_after_grant CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

CREATE INDEX partner_phone_consents_user_idx ON partner_phone_consents (user_id);
CREATE INDEX partner_phone_consents_organization_idx ON partner_phone_consents (region_id, organization_id);
CREATE INDEX partner_phone_consents_place_idx ON partner_phone_consents (region_id, place_id);

SELECT app_enable_tenant_rls('partner_phone_consents');
REVOKE ALL ON partner_phone_consents FROM app;
GRANT SELECT, INSERT ON partner_phone_consents TO app;
GRANT UPDATE (withdrawn_at) ON partner_phone_consents TO app;

-- tenant: бронь (roles-and-data §2.4 Booking; states-and-rules §3). Статусы — канонические ТЗ §10.2 + expired
-- (C-14: new и pending_partner не сливаются; C-04: refunded в MVP не используется — нет в перечне). Источник:
-- platform — турист из Mini App (user_id, телефон и согласие обязательны), manual/phone — ручная запись партнёра
-- (данные клиента вводит партнёр). Занятость [occupied_from, occupied_until): интервал брони с buffer до/после; у
-- alternative_proposed — предложенный интервал (исходный освобождён). Ограничение bookings_no_overlap — BR-08.
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  place_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  source text NOT NULL CONSTRAINT bookings_source_check CHECK (source IN ('platform', 'manual', 'phone')),
  entry_context_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  occupied_from timestamptz NOT NULL,
  occupied_until timestamptz NOT NULL,
  people_count integer NOT NULL CONSTRAINT bookings_people_check CHECK (people_count BETWEEN 1 AND 100),
  comment text CONSTRAINT bookings_comment_check CHECK (char_length(comment) BETWEEN 1 AND 500),
  customer_name text CONSTRAINT bookings_customer_name_check CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 200),
  contact_phone text CONSTRAINT bookings_contact_phone_check CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  contact_phone_source text CONSTRAINT bookings_contact_phone_source_check
    CHECK (contact_phone_source IN ('telegram_contact', 'manual', 'partner')),
  phone_consent_id uuid,
  price_quote_minor bigint CONSTRAINT bookings_price_check CHECK (price_quote_minor >= 0),
  currency text CONSTRAINT bookings_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CONSTRAINT bookings_status_check CHECK (status IN ('new', 'pending_partner', 'confirmed',
    'alternative_proposed', 'cancelled_by_user', 'cancelled_by_partner', 'expired', 'completed', 'no_show')),
  status_reason text CONSTRAINT bookings_status_reason_check CHECK (char_length(status_reason) BETWEEN 1 AND 500),
  partner_response_due_at timestamptz,
  alternative_starts_at timestamptz,
  alternative_ends_at timestamptz,
  customer_response_due_at timestamptz,
  confirmed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_region_id_key UNIQUE (region_id, id),
  CONSTRAINT bookings_resource_fk FOREIGN KEY (region_id, resource_id)
    REFERENCES resources (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT bookings_place_fk FOREIGN KEY (region_id, place_id) REFERENCES places (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT bookings_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT bookings_entry_context_fk FOREIGN KEY (region_id, entry_context_id)
    REFERENCES entry_contexts (region_id, id) ON DELETE SET NULL (entry_context_id),
  CONSTRAINT bookings_phone_consent_fk FOREIGN KEY (region_id, phone_consent_id)
    REFERENCES partner_phone_consents (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT bookings_interval CHECK (ends_at > starts_at),
  CONSTRAINT bookings_occupied_interval CHECK (occupied_until > occupied_from),
  CONSTRAINT bookings_price_currency CHECK ((price_quote_minor IS NULL) = (currency IS NULL)),
  -- Онлайн-бронь туриста — только с телефоном и согласием на его передачу этому партнёру (BR-29, ТЗ §14.1).
  CONSTRAINT bookings_platform_contact CHECK (source <> 'platform'
    OR (user_id IS NOT NULL AND contact_phone IS NOT NULL AND phone_consent_id IS NOT NULL)),
  CONSTRAINT bookings_manual_customer CHECK (source = 'platform' OR customer_name IS NOT NULL),
  CONSTRAINT bookings_pending_due CHECK (status <> 'pending_partner' OR partner_response_due_at IS NOT NULL),
  -- Одна активная альтернатива (D-66): предложенный интервал и срок ответа — только в alternative_proposed.
  CONSTRAINT bookings_alternative_consistent CHECK ((status = 'alternative_proposed') = (
    alternative_starts_at IS NOT NULL AND alternative_ends_at IS NOT NULL AND customer_response_due_at IS NOT NULL)),
  CONSTRAINT bookings_alternative_interval CHECK (alternative_ends_at IS NULL OR alternative_ends_at > alternative_starts_at),
  -- BR-08: занимающие статусы (states-and-rules §3.3) одного ресурса не пересекаются по интервалу с buffer.
  -- completed и no_show — исторически занимают (статистика загрузки); освобождающие — cancelled_*, expired.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(occupied_from, occupied_until, '[)') WITH &&
  ) WHERE (status IN ('new', 'pending_partner', 'alternative_proposed', 'confirmed', 'completed', 'no_show'))
);

CREATE TRIGGER bookings_set_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX bookings_place_idx ON bookings (region_id, place_id, starts_at);
CREATE INDEX bookings_organization_idx ON bookings (region_id, organization_id, starts_at);
CREATE INDEX bookings_resource_idx ON bookings (region_id, resource_id, starts_at);
CREATE INDEX bookings_user_idx ON bookings (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX bookings_entry_context_idx ON bookings (region_id, entry_context_id) WHERE entry_context_id IS NOT NULL;
CREATE INDEX bookings_phone_consent_idx ON bookings (region_id, phone_consent_id) WHERE phone_consent_id IS NOT NULL;
CREATE INDEX bookings_confirmed_by_idx ON bookings (confirmed_by) WHERE confirmed_by IS NOT NULL;
CREATE INDEX bookings_created_by_idx ON bookings (created_by) WHERE created_by IS NOT NULL;
-- Задача воркера: сроки ответа (SLA партнёра, ответ туриста на альтернативу) и автозавершение.
CREATE INDEX bookings_partner_due_idx ON bookings (partner_response_due_at) WHERE status = 'pending_partner';
CREATE INDEX bookings_customer_due_idx ON bookings (customer_response_due_at) WHERE status = 'alternative_proposed';
CREATE INDEX bookings_confirmed_end_idx ON bookings (ends_at) WHERE status = 'confirmed';

SELECT app_enable_tenant_rls('bookings');
REVOKE ALL ON bookings FROM app;
GRANT SELECT, INSERT, UPDATE ON bookings TO app;

-- tenant: история брони (append-only): кто, когда, из/в, причина, payload (альтернатива).
CREATE TABLE booking_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL CONSTRAINT booking_events_actor_check CHECK (actor_type IN ('user', 'staff', 'system')),
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  role_assignment_id uuid REFERENCES role_assignments(id) ON DELETE RESTRICT,
  reason text CONSTRAINT booking_events_reason_check CHECK (char_length(reason) BETWEEN 1 AND 500),
  payload jsonb NOT NULL DEFAULT '{}' CONSTRAINT booking_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  -- clock_timestamp(): несколько переходов в одной транзакции (new → pending_partner) упорядочены по времени.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT booking_events_booking_fk FOREIGN KEY (region_id, booking_id)
    REFERENCES bookings (region_id, id) ON DELETE CASCADE
);

CREATE INDEX booking_events_booking_idx ON booking_events (region_id, booking_id, created_at);
CREATE INDEX booking_events_actor_idx ON booking_events (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX booking_events_assignment_idx ON booking_events (role_assignment_id) WHERE role_assignment_id IS NOT NULL;

SELECT app_enable_tenant_rls('booking_events');
REVOKE ALL ON booking_events FROM app;
GRANT SELECT, INSERT ON booking_events TO app;

-- Авто-истечение по сроку ответа (D-43 А; D-66 — принята рекомендация: таймаут ответа туриста на альтернативу):
-- pending_partner после partner_response_due_at и alternative_proposed после customer_response_due_at → expired;
-- слот освобождается той же командой (статус выходит из ограничения bookings_no_overlap). Кросс-tenant (воркер,
-- SYSTEM): функция сама выставляет app.actor. Пачками, SKIP LOCKED — параллельный PATCH партнёра не ждёт. Событие
-- booking_expired — в analytics_events (как analytics_record_event, 0007). Возвращает число истёкших броней.
CREATE FUNCTION bookings_expire_due(p_batch integer DEFAULT 500)
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
  IF p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'bookings_expire_due: пачка — >= 1' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  FOR rec IN
    WITH due AS (
      SELECT b.id, b.status FROM public.bookings b
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
    RETURNING b.id, b.region_id, b.place_id, b.user_id, due.status AS from_status, b.status_reason
  LOOP
    n := n + 1;
    INSERT INTO public.booking_events (region_id, booking_id, from_status, to_status, actor_type, reason)
    VALUES (rec.region_id, rec.id, rec.from_status, 'expired', 'system', rec.status_reason);
    INSERT INTO public.analytics_events (id, event_name, schema_version, occurred_at, pseudonymous_user_id,
      region_id, source, place_id, properties)
    SELECT public.uuidv7(), 'booking_expired', 1, now(), u.analytics_id, rec.region_id, 'system', rec.place_id,
      jsonb_build_object('bookingId', rec.id, 'placeId', rec.place_id, 'reason', rec.status_reason)
    FROM public.users u WHERE u.id = rec.user_id;
  END LOOP;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN n;
END
$$;

REVOKE EXECUTE ON FUNCTION bookings_expire_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bookings_expire_due(integer) TO app;

-- Автозавершение (C-27 (а), принята рекомендация): confirmed, не отмеченная партнёром no_show за p_after_hours после
-- окончания, → completed (SYSTEM). Партнёр не может «забыть» completed и тем лишить клиента права на отзыв. Проводок
-- ledger нет (D-45 А). Возвращает число завершённых.
CREATE FUNCTION bookings_auto_complete(p_after_hours integer DEFAULT 24, p_batch integer DEFAULT 500)
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
    RETURNING b.id, b.region_id, b.place_id, b.user_id
  LOOP
    n := n + 1;
    INSERT INTO public.booking_events (region_id, booking_id, from_status, to_status, actor_type, reason)
    VALUES (rec.region_id, rec.id, 'confirmed', 'completed', 'system', 'auto_complete');
    INSERT INTO public.analytics_events (id, event_name, schema_version, occurred_at, pseudonymous_user_id,
      region_id, source, place_id, properties)
    SELECT public.uuidv7(), 'booking_completed', 1, now(), u.analytics_id, rec.region_id, 'system', rec.place_id,
      jsonb_build_object('bookingId', rec.id, 'placeId', rec.place_id)
    FROM public.users u WHERE u.id = rec.user_id;
  END LOOP;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN n;
END
$$;

REVOKE EXECUTE ON FUNCTION bookings_auto_complete(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bookings_auto_complete(integer, integer) TO app;

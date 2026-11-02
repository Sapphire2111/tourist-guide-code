-- 0015: гостиничные заявки и планировщик (блок 5; ТЗ §4.5, §5.4, §11.1; D-49, D-50, D-53, D-55; ADR-0020).
-- README apps/api, «Заявки гостиницы и планировщик».
-- «Про заклад» (host_modules), заявки гостя (service_requests) и их история (service_request_events), уведомления
-- персоналу и гостю (notifications — outbox бота), готовые сценарии (scenarios, scenario_items) и планы
-- пользователя (user_plans). Номер комнаты QR номера — qr_points.room_label (D-49: контекст без ПДн).
-- Упрощения тестового режима (§1.6): организаций нет — персонал отеля назначается на место (role_assignments,
-- scope PLACE); настройки «Про заклад» — одна строка на место с разделами и услугами в jsonb (форма проверяется api).
-- Все новые таблицы — tenant (ADR-005): region_id NOT NULL, RLS, составные FK (region_id, …).

-- Номер комнаты на QR номера (D-49 вариант А): метка комнаты — не ПДн, только у QR отеля.
ALTER TABLE qr_points
  ADD COLUMN room_label text CONSTRAINT qr_points_room_label_format
    CHECK (btrim(room_label) <> '' AND char_length(room_label) <= 20),
  ADD CONSTRAINT qr_points_room_hotel_only CHECK (room_label IS NULL OR type = 'hotel');

-- Регион места для иерархии RBAC (PLACE → REGION, организаций пока нет): читает в режиме SYSTEM, как
-- app_active_role_assignments() (0005), — вызывается и вне транзакции региона (guard, назначение роли).
CREATE FUNCTION app_place_region(p_place_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  result uuid;
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  SELECT p.region_id INTO result FROM public.places p WHERE p.id = p_place_id;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN result;
END
$$;

REVOKE EXECUTE ON FUNCTION app_place_region(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_place_region(uuid) TO app;

-- tenant: модуль «Про заклад» места (C03, roles-and-data §2.6 HostModule; D-55 — часы приёма и SLA по услуге).
-- Разделы (правила, контакты, сніданок, checkout…) и услуги-заявки (прибирання, рушники…) — массивы jsonb, форму
-- проверяет api (DTO). Часы приёма — местное время региона; оба NULL — круглосуточно. Wi-Fi пароль туристу
-- показывается только при входе с QR этого места.
CREATE TABLE host_modules (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL CONSTRAINT host_modules_place_key UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  wifi_ssid text CONSTRAINT host_modules_wifi_ssid_check CHECK (char_length(wifi_ssid) BETWEEN 1 AND 64),
  wifi_password text CONSTRAINT host_modules_wifi_password_check
    CHECK (char_length(wifi_password) BETWEEN 1 AND 128),
  reception_phone text CONSTRAINT host_modules_reception_phone_format
    CHECK (reception_phone ~ '^\+[1-9][0-9]{6,14}$'),
  hours_from time,
  hours_to time,
  sections jsonb NOT NULL DEFAULT '[]' CONSTRAINT host_modules_sections_array CHECK (jsonb_typeof(sections) = 'array'),
  services jsonb NOT NULL DEFAULT '[]' CONSTRAINT host_modules_services_array CHECK (jsonb_typeof(services) = 'array'),
  updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT host_modules_region_id_key UNIQUE (region_id, id),
  CONSTRAINT host_modules_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT host_modules_hours_pair CHECK ((hours_from IS NULL) = (hours_to IS NULL)),
  CONSTRAINT host_modules_hours_not_empty CHECK (hours_from IS NULL OR hours_from <> hours_to)
);

CREATE TRIGGER host_modules_set_updated_at BEFORE UPDATE ON host_modules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX host_modules_updated_by_idx ON host_modules (updated_by) WHERE updated_by IS NOT NULL;

SELECT app_enable_tenant_rls('host_modules');
REVOKE ALL ON host_modules FROM app;
GRANT SELECT, INSERT, UPDATE ON host_modules TO app;

-- entry_contexts: цель составного FK service_requests → entry_contexts (до CREATE TABLE service_requests).
ALTER TABLE entry_contexts ADD CONSTRAINT entry_contexts_region_id_key UNIQUE (region_id, id);

-- tenant: заявка гостя отеля (S-03, states-and-rules §2). Статусы канонические; переходы проверяет api (409),
-- каждый — строка service_request_events. Комната — из QR номера (room_source = qr) или введена гостем на общем
-- QR (guest, пометка «введено гостем»), D-49. Вне часов приёма — принимается с outside_hours и process_from
-- (D-55 вариант Б); SLA считается от process_from (или создания). Срок хранения (D-49) — функция ниже:
-- после него заявка закрывается (если открыта) и обезличивается (anonymized_at).
CREATE TABLE service_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  -- NULL — автор обезличен по сроку хранения.
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  entry_context_id uuid,
  service_code text NOT NULL CONSTRAINT service_requests_service_code_format CHECK (is_catalog_code(service_code)),
  -- Название услуги на момент заявки (настройки отеля могут измениться).
  service_title_i18n jsonb NOT NULL CONSTRAINT service_requests_service_title_check
    CHECK (is_localized_text(service_title_i18n)),
  room_label text CONSTRAINT service_requests_room_label_check
    CHECK (btrim(room_label) <> '' AND char_length(room_label) <= 20),
  room_source text CONSTRAINT service_requests_room_source_check CHECK (room_source IN ('qr', 'guest')),
  comment text CONSTRAINT service_requests_comment_check CHECK (char_length(comment) <= 500),
  status text NOT NULL DEFAULT 'new' CONSTRAINT service_requests_status_check
    CHECK (status IN ('new', 'accepted', 'in_progress', 'done', 'rejected', 'cancelled_by_guest')),
  status_reason text CONSTRAINT service_requests_status_reason_check CHECK (char_length(status_reason) <= 500),
  outside_hours boolean NOT NULL DEFAULT false,
  process_from timestamptz,
  sla_minutes integer CONSTRAINT service_requests_sla_check CHECK (sla_minutes BETWEEN 1 AND 10080),
  sla_due_at timestamptz,
  assigned_to uuid REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  started_at timestamptz,
  closed_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_requests_region_id_key UNIQUE (region_id, id),
  CONSTRAINT service_requests_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT service_requests_entry_context_fk FOREIGN KEY (region_id, entry_context_id)
    REFERENCES entry_contexts (region_id, id) ON DELETE SET NULL (entry_context_id),
  CONSTRAINT service_requests_room_consistent CHECK ((room_label IS NULL) = (room_source IS NULL)),
  CONSTRAINT service_requests_reject_reason CHECK (status <> 'rejected' OR status_reason IS NOT NULL)
);

CREATE TRIGGER service_requests_set_updated_at BEFORE UPDATE ON service_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Список персонала отеля по статусу; «Мої заявки» гостя; одна активная заявка гостя на услугу (гонка двух POST).
CREATE INDEX service_requests_place_status_idx ON service_requests (region_id, place_id, status, created_at DESC);
CREATE INDEX service_requests_user_idx ON service_requests (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX service_requests_active_key ON service_requests (user_id, place_id, service_code)
  WHERE status IN ('new', 'accepted', 'in_progress') AND user_id IS NOT NULL;
CREATE INDEX service_requests_retention_idx ON service_requests (created_at) WHERE anonymized_at IS NULL;
CREATE INDEX service_requests_entry_context_idx ON service_requests (region_id, entry_context_id)
  WHERE entry_context_id IS NOT NULL;
CREATE INDEX service_requests_assigned_idx ON service_requests (assigned_to) WHERE assigned_to IS NOT NULL;

SELECT app_enable_tenant_rls('service_requests');
REVOKE ALL ON service_requests FROM app;
GRANT SELECT, INSERT, UPDATE ON service_requests TO app;

-- tenant: история статусов заявки (кто/когда/почему) — append-only (у app — SELECT, INSERT).
CREATE TABLE service_request_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  service_request_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL CONSTRAINT service_request_events_actor_check
    CHECK (actor_type IN ('guest', 'staff', 'system')),
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  reason text CONSTRAINT service_request_events_reason_check CHECK (char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_request_events_request_fk FOREIGN KEY (region_id, service_request_id)
    REFERENCES service_requests (region_id, id) ON DELETE CASCADE
);

CREATE INDEX service_request_events_request_idx ON service_request_events (region_id, service_request_id, created_at);
CREATE INDEX service_request_events_actor_idx ON service_request_events (actor_user_id)
  WHERE actor_user_id IS NOT NULL;

SELECT app_enable_tenant_rls('service_request_events');
REVOKE ALL ON service_request_events FROM app;
GRANT SELECT, INSERT ON service_request_events TO app;

-- tenant: уведомление (outbox) — пишется в транзакции бизнес-изменения, отправляется ботом после коммита
-- (ADR-0020). Получатель — пользователь с MessagingConsent (service) и привязкой Telegram; текст готовый.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  channel text NOT NULL DEFAULT 'telegram_bot' CONSTRAINT notifications_channel_check
    CHECK (channel IN ('telegram_bot')),
  template text NOT NULL CONSTRAINT notifications_template_format CHECK (template ~ '^[a-z][a-z0-9_.]{0,63}$'),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  body text NOT NULL CONSTRAINT notifications_body_check CHECK (char_length(body) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'pending' CONSTRAINT notifications_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text CONSTRAINT notifications_last_error_check CHECK (char_length(last_error) <= 300),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX notifications_pending_idx ON notifications (region_id, created_at) WHERE status = 'pending';
CREATE INDEX notifications_entity_idx ON notifications (region_id, entity_type, entity_id);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_user_id);

SELECT app_enable_tenant_rls('notifications');
REVOKE ALL ON notifications FROM app;
GRANT SELECT, INSERT, UPDATE ON notifications TO app;

-- Срок хранения заявок (D-49, рекомендация: параметр, по умолчанию 90 дней; отсчёт — от создания заявки). Вызывает
-- worker раз в час (задача service-requests.anonymize-expired). За один вызов — до p_batch заявок:
-- 1) незакрытые заявки старше срока закрываются: rejected с причиной expired и системным событием истории;
-- 2) закрытые заявки старше срока обезличиваются полностью: комната, комментарий, автор, контекст входа, причины
--    (свободный текст) в заявке и истории, автор-гость в истории; уведомления гостю удаляются, тексты уведомлений
--    персоналу заменяются на «—». Остаются тип, статус и время — для SLA-статистики.
-- SECURITY DEFINER: у app нет UPDATE истории и DELETE уведомлений (append-only для приложения); search_path
-- зафиксирован, имена — со схемой. RLS: на время работы app.actor = 'system'.
CREATE FUNCTION service_requests_anonymize_expired(p_retention_days integer, p_batch integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  cutoff timestamptz;
  ids uuid[];
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1 OR p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'service_requests_anonymize_expired: срок (дней) и пачка — >= 1' USING ERRCODE = '22023';
  END IF;
  cutoff := now() - make_interval(days => p_retention_days);
  PERFORM set_config('app.actor', 'system', true);

  WITH stale AS (
    SELECT sr.id, sr.status FROM public.service_requests sr
    WHERE sr.status IN ('new', 'accepted', 'in_progress') AND sr.created_at < cutoff
    ORDER BY sr.created_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  ), closed AS (
    UPDATE public.service_requests sr
    SET status = 'rejected', status_reason = 'expired', closed_at = now()
    FROM stale WHERE sr.id = stale.id
    RETURNING sr.id, sr.region_id, stale.status AS from_status
  )
  INSERT INTO public.service_request_events (region_id, service_request_id, from_status, to_status, actor_type, reason)
  SELECT closed.region_id, closed.id, closed.from_status, 'rejected', 'system', 'expired' FROM closed;

  SELECT array_agg(t.id) INTO ids FROM (
    SELECT sr.id FROM public.service_requests sr
    WHERE sr.anonymized_at IS NULL AND sr.created_at < cutoff
      AND sr.status IN ('done', 'rejected', 'cancelled_by_guest')
    ORDER BY sr.created_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  ) t;

  IF ids IS NOT NULL THEN
    -- Уведомления: по (region_id, entity_type, entity_id) — индекс notifications_entity_idx.
    DELETE FROM public.notifications n
    USING public.service_requests sr
    WHERE sr.id = ANY (ids) AND n.region_id = sr.region_id AND n.entity_type = 'service_request'
      AND n.entity_id = sr.id AND n.recipient_user_id = sr.user_id;
    UPDATE public.notifications n SET body = '—', last_error = NULL
    FROM public.service_requests sr
    WHERE sr.id = ANY (ids) AND n.region_id = sr.region_id AND n.entity_type = 'service_request'
      AND n.entity_id = sr.id;
    UPDATE public.service_request_events e
    SET actor_user_id = CASE WHEN e.actor_type = 'guest' THEN NULL ELSE e.actor_user_id END,
      reason = CASE WHEN e.actor_type = 'system' THEN e.reason ELSE NULL END
    FROM public.service_requests sr
    WHERE sr.id = ANY (ids) AND e.region_id = sr.region_id AND e.service_request_id = sr.id;
    UPDATE public.service_requests
    SET room_label = NULL, room_source = NULL, comment = NULL, user_id = NULL, entry_context_id = NULL,
      -- rejected требует причину (CHECK): свободный текст заменяется прочерком.
      status_reason = CASE WHEN status = 'rejected' THEN '—' ELSE NULL END,
      anonymized_at = now()
    WHERE id = ANY (ids);
  END IF;

  PERFORM set_config('app.actor', prev_actor, true);
  RETURN coalesce(cardinality(ids), 0);
END
$$;

REVOKE EXECUTE ON FUNCTION service_requests_anonymize_expired(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION service_requests_anonymize_expired(integer, integer) TO app;

-- tenant: готовый сценарий региона (C09, S-04; D-53 — демо-контент агента). Платное участие — is_sponsored с
-- меткой (C-02, ТЗ §8.2). version растёт при каждой правке пунктов (UserPlan хранит версию основы).
CREATE TABLE scenarios (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  code text NOT NULL CONSTRAINT scenarios_code_format CHECK (is_catalog_code(code)),
  title_i18n jsonb NOT NULL CONSTRAINT scenarios_title_check CHECK (is_localized_text(title_i18n)),
  description_i18n jsonb CONSTRAINT scenarios_description_check
    CHECK (description_i18n IS NULL OR is_localized_text(description_i18n)),
  days smallint NOT NULL DEFAULT 1 CONSTRAINT scenarios_days_check CHECK (days BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CONSTRAINT scenarios_status_check
    CHECK (status IN ('draft', 'published', 'archived')),
  version integer NOT NULL DEFAULT 1 CONSTRAINT scenarios_version_check CHECK (version >= 1),
  is_sponsored boolean NOT NULL DEFAULT false,
  ad_label text CONSTRAINT scenarios_ad_label_check CHECK (ad_label IN ('advertising', 'partner')),
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scenarios_region_code_key UNIQUE (region_id, code),
  CONSTRAINT scenarios_region_id_key UNIQUE (region_id, id),
  -- Платное участие без маркировки не записывается (C-02).
  CONSTRAINT scenarios_sponsored_label CHECK (NOT is_sponsored OR ad_label IS NOT NULL)
);

CREATE TRIGGER scenarios_set_updated_at BEFORE UPDATE ON scenarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX scenarios_region_status_idx ON scenarios (region_id, status, sort_order);
CREATE INDEX scenarios_created_by_idx ON scenarios (created_by) WHERE created_by IS NOT NULL;

SELECT app_enable_tenant_rls('scenarios');
GRANT SELECT, INSERT, UPDATE, DELETE ON scenarios TO app;

-- tenant: пункт сценария — место дня с альтернативами для «Замінити» (список place_id без FK: туристу показываются
-- только опубликованные).
CREATE TABLE scenario_items (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  scenario_id uuid NOT NULL,
  day_no smallint NOT NULL CONSTRAINT scenario_items_day_check CHECK (day_no BETWEEN 1 AND 5),
  position smallint NOT NULL CONSTRAINT scenario_items_position_check CHECK (position BETWEEN 0 AND 100),
  place_id uuid NOT NULL,
  time_hint time,
  duration_min integer CONSTRAINT scenario_items_duration_check CHECK (duration_min BETWEEN 5 AND 1440),
  note_i18n jsonb CONSTRAINT scenario_items_note_check CHECK (note_i18n IS NULL OR is_localized_text(note_i18n)),
  alternatives uuid[] NOT NULL DEFAULT '{}' CONSTRAINT scenario_items_alternatives_check
    CHECK (cardinality(alternatives) <= 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scenario_items_scenario_fk FOREIGN KEY (region_id, scenario_id)
    REFERENCES scenarios (region_id, id) ON DELETE CASCADE,
  CONSTRAINT scenario_items_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT scenario_items_position_key UNIQUE (scenario_id, day_no, position)
);

CREATE INDEX scenario_items_scenario_idx ON scenario_items (region_id, scenario_id, day_no, position);
CREATE INDEX scenario_items_place_idx ON scenario_items (region_id, place_id);

SELECT app_enable_tenant_rls('scenario_items');
GRANT SELECT, INSERT, UPDATE, DELETE ON scenario_items TO app;

-- tenant: план пользователя «Мій план» (C09) — копия пунктов сценария с заменами (items jsonb, форма — api),
-- ссылка на основу и её версию. Несколько сохранённых планов на пользователя.
CREATE TABLE user_plans (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_id uuid,
  scenario_version integer,
  title_i18n jsonb NOT NULL CONSTRAINT user_plans_title_check CHECK (is_localized_text(title_i18n)),
  start_date date,
  items jsonb NOT NULL DEFAULT '[]' CONSTRAINT user_plans_items_array CHECK (jsonb_typeof(items) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_plans_scenario_fk FOREIGN KEY (region_id, scenario_id)
    REFERENCES scenarios (region_id, id) ON DELETE SET NULL (scenario_id)
);

CREATE TRIGGER user_plans_set_updated_at BEFORE UPDATE ON user_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX user_plans_user_idx ON user_plans (region_id, user_id, updated_at DESC);
CREATE INDEX user_plans_scenario_idx ON user_plans (region_id, scenario_id) WHERE scenario_id IS NOT NULL;

SELECT app_enable_tenant_rls('user_plans');
REVOKE ALL ON user_plans FROM app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_plans TO app;

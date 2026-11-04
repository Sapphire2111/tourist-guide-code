-- 0028: подтверждённые отзывы (блок 10; ТЗ §9, §16.2; states-and-rules §6; D-08, D-35, D-37, D-82). Облегчённая
-- версия тестового режима: право на отзыв (ReviewEligibility) даёт только бронь, ставшая completed (блок 7; транзакции
-- блока 9 и verified location D-36/D-61 — позже); отзыв с историей версий; ответ партнёра; жалоба; апелляция; кэш
-- рейтинга места с версией формулы (D-37 В). Бонуса за отзыв нет (D-35 А).
-- Новые таблицы — tenant (ADR-005): region_id NOT NULL, RLS, составные FK (region_id, …).

SELECT set_config('app.actor', 'system', true);

-- tenant: право на отзыв (roles-and-data §2.10). Создаёт триггер bookings (ниже) при переходе брони в completed с
-- user_id — и из api (партнёр, исправление no_show), и из воркера (bookings_auto_complete). Одна eligibility на бронь
-- (ТЗ §9.2). Статусы D-82: active → consumed (написан отзыв) | expired (окно — параметр api REVIEW_PARAMS, считается
-- от source_ended_at; статус проставляет api при обращении) | revoked (бронь вышла из completed до отзыва).
CREATE TABLE review_eligibilities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  organization_id uuid,
  level text NOT NULL DEFAULT 'verified_booking'
    CONSTRAINT review_eligibilities_level_check CHECK (level IN ('verified_booking')),
  source_type text NOT NULL DEFAULT 'booking'
    CONSTRAINT review_eligibilities_source_type_check CHECK (source_type IN ('booking')),
  booking_id uuid NOT NULL,
  -- Окончание события-основания (ends_at брони): от него api считает окно на отзыв.
  source_ended_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT review_eligibilities_status_check CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  closed_at timestamptz,
  revoke_reason text CONSTRAINT review_eligibilities_revoke_reason_check CHECK (char_length(revoke_reason) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_eligibilities_region_id_key UNIQUE (region_id, id),
  CONSTRAINT review_eligibilities_booking_key UNIQUE (booking_id),
  CONSTRAINT review_eligibilities_booking_fk FOREIGN KEY (region_id, booking_id)
    REFERENCES bookings (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_eligibilities_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_eligibilities_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_eligibilities_consumed_consistent CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CONSTRAINT review_eligibilities_revoked_reason CHECK (status <> 'revoked' OR revoke_reason IS NOT NULL)
);

CREATE TRIGGER review_eligibilities_set_updated_at BEFORE UPDATE ON review_eligibilities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX review_eligibilities_user_idx ON review_eligibilities (user_id, issued_at DESC);
CREATE INDEX review_eligibilities_place_idx ON review_eligibilities (region_id, place_id);
CREATE INDEX review_eligibilities_organization_idx ON review_eligibilities (region_id, organization_id)
  WHERE organization_id IS NOT NULL;

SELECT app_enable_tenant_rls('review_eligibilities');
REVOKE ALL ON review_eligibilities FROM app;
GRANT SELECT, INSERT, UPDATE ON review_eligibilities TO app;

-- tenant: отзыв (roles-and-data §2.10 Review). Один на eligibility (BR-24). rating/text — последней версии (история —
-- review_revisions). Статусы states-and-rules §6.2 без submitted (автопроверка синхронна) и withdrawn (позже):
-- published — виден и в рейтинге; pending_moderation — сработал автофильтр (ссылки, телефоны, e-mail, мат), ждёт
-- модератора; hidden — скрыт модератором (жалоба удовлетворена); rejected — модератор отклонил отфильтрованный.
-- last_decision_by/at — модератор последнего решения: апелляцию решает другой (D-08).
CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  organization_id uuid,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  eligibility_id uuid NOT NULL,
  verification_level text NOT NULL CONSTRAINT reviews_verification_level_check
    CHECK (verification_level IN ('verified_booking')),
  rating smallint NOT NULL CONSTRAINT reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
  text text NOT NULL CONSTRAINT reviews_text_check CHECK (char_length(btrim(text)) BETWEEN 1 AND 2000),
  current_version integer NOT NULL DEFAULT 1 CONSTRAINT reviews_current_version_check CHECK (current_version >= 1),
  auto_flags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CONSTRAINT reviews_status_check
    CHECK (status IN ('published', 'pending_moderation', 'hidden', 'rejected')),
  published_at timestamptz,
  hidden_reason text CONSTRAINT reviews_hidden_reason_check CHECK (char_length(hidden_reason) BETWEEN 1 AND 500),
  last_decision_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  last_decision_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviews_region_id_key UNIQUE (region_id, id),
  CONSTRAINT reviews_eligibility_key UNIQUE (eligibility_id),
  CONSTRAINT reviews_eligibility_fk FOREIGN KEY (region_id, eligibility_id)
    REFERENCES review_eligibilities (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT reviews_place_fk FOREIGN KEY (region_id, place_id) REFERENCES places (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT reviews_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT reviews_published_at CHECK (status <> 'published' OR published_at IS NOT NULL),
  CONSTRAINT reviews_decision_consistent CHECK ((last_decision_by IS NULL) = (last_decision_at IS NULL))
);

CREATE TRIGGER reviews_set_updated_at BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX reviews_place_idx ON reviews (region_id, place_id, status, published_at DESC);
CREATE INDEX reviews_organization_idx ON reviews (region_id, organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX reviews_author_idx ON reviews (author_user_id);
CREATE INDEX reviews_last_decision_by_idx ON reviews (last_decision_by) WHERE last_decision_by IS NOT NULL;
-- Очередь модерации: отфильтрованные.
CREATE INDEX reviews_pending_idx ON reviews (region_id, created_at) WHERE status = 'pending_moderation';

SELECT app_enable_tenant_rls('reviews');
REVOKE ALL ON reviews FROM app;
GRANT SELECT, INSERT, UPDATE ON reviews TO app;

-- tenant: версии отзыва (ReviewRevision; ТЗ §9.2 «история версий»). Только дописывается.
CREATE TABLE review_revisions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL,
  version_no integer NOT NULL CONSTRAINT review_revisions_version_check CHECK (version_no >= 1),
  rating smallint NOT NULL CONSTRAINT review_revisions_rating_check CHECK (rating BETWEEN 1 AND 5),
  text text NOT NULL CONSTRAINT review_revisions_text_check CHECK (char_length(btrim(text)) BETWEEN 1 AND 2000),
  auto_flags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_revisions_version_key UNIQUE (review_id, version_no),
  CONSTRAINT review_revisions_review_fk FOREIGN KEY (region_id, review_id)
    REFERENCES reviews (region_id, id) ON DELETE CASCADE
);

CREATE INDEX review_revisions_review_idx ON review_revisions (region_id, review_id, version_no);

SELECT app_enable_tenant_rls('review_revisions');
REVOKE ALL ON review_revisions FROM app;
GRANT SELECT, INSERT ON review_revisions TO app;

-- tenant: ответ партнёра (ReviewResponse; states-and-rules §6.3): один на отзыв, публикуется сразу (D-68), правка —
-- того же ответа (version + 1). Автор — ORG_OWNER/ORG_MANAGER с правом review.respond.
CREATE TABLE review_responses (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  text text NOT NULL CONSTRAINT review_responses_text_check CHECK (char_length(btrim(text)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'published' CONSTRAINT review_responses_status_check CHECK (status IN ('published', 'hidden')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_responses_review_key UNIQUE (review_id),
  CONSTRAINT review_responses_review_fk FOREIGN KEY (region_id, review_id)
    REFERENCES reviews (region_id, id) ON DELETE CASCADE
);

CREATE TRIGGER review_responses_set_updated_at BEFORE UPDATE ON review_responses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX review_responses_author_idx ON review_responses (author_user_id);

SELECT app_enable_tenant_rls('review_responses');
REVOKE ALL ON review_responses FROM app;
GRANT SELECT, INSERT, UPDATE ON review_responses TO app;

-- tenant: жалоба на отзыв (Complaint; states-and-rules §6.4). Подача ничего не скрывает (постмодерация D-08); одна
-- открытая жалоба на отзыв от одного заявителя. Решение модератора по отзыву закрывает его открытые жалобы: оставить —
-- dismissed, скрыть — upheld (in_review в облегчённой версии нет).
CREATE TABLE review_complaints (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL,
  complainant_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  complainant_kind text NOT NULL CONSTRAINT review_complaints_kind_check CHECK (complainant_kind IN ('partner', 'user')),
  reason_code text NOT NULL CONSTRAINT review_complaints_reason_check
    CHECK (reason_code IN ('insult', 'personal_data', 'spam', 'blackmail', 'fraud', 'other')),
  text text CONSTRAINT review_complaints_text_check CHECK (char_length(btrim(text)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'open' CONSTRAINT review_complaints_status_check
    CHECK (status IN ('open', 'upheld', 'dismissed')),
  decided_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_complaints_review_fk FOREIGN KEY (region_id, review_id)
    REFERENCES reviews (region_id, id) ON DELETE CASCADE,
  CONSTRAINT review_complaints_decided_consistent CHECK ((status = 'open') = (decided_at IS NULL))
);

CREATE UNIQUE INDEX review_complaints_open_key ON review_complaints (review_id, complainant_user_id)
  WHERE status = 'open';
CREATE INDEX review_complaints_review_idx ON review_complaints (region_id, review_id, created_at);
CREATE INDEX review_complaints_open_idx ON review_complaints (region_id, created_at) WHERE status = 'open';
CREATE INDEX review_complaints_complainant_idx ON review_complaints (complainant_user_id);
CREATE INDEX review_complaints_decided_by_idx ON review_complaints (decided_by) WHERE decided_by IS NOT NULL;

SELECT app_enable_tenant_rls('review_complaints');
REVOKE ALL ON review_complaints FROM app;
GRANT SELECT, INSERT ON review_complaints TO app;
GRANT UPDATE (status, decided_by, decided_at) ON review_complaints TO app;

-- tenant: апелляция (Appeal; states-and-rules §6.4): автора — на hidden/rejected, партнёра (ORG_OWNER) — на решение
-- «оставить» по его жалобе. Одна на отзыв (решение по апелляции финальное). Решает модератор, не принимавший
-- обжалуемое решение (appealed_decision_by; D-08) — проверка в api и CHECK.
CREATE TABLE review_appeals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL,
  appellant_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  appellant_kind text NOT NULL CONSTRAINT review_appeals_kind_check CHECK (appellant_kind IN ('author', 'partner')),
  text text NOT NULL CONSTRAINT review_appeals_text_check CHECK (char_length(btrim(text)) BETWEEN 1 AND 1000),
  appealed_decision_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  appealed_review_status text NOT NULL CONSTRAINT review_appeals_review_status_check
    CHECK (appealed_review_status IN ('published', 'hidden', 'rejected')),
  status text NOT NULL DEFAULT 'open' CONSTRAINT review_appeals_status_check CHECK (status IN ('open', 'granted', 'denied')),
  decision_note text CONSTRAINT review_appeals_note_check CHECK (char_length(btrim(decision_note)) BETWEEN 1 AND 500),
  decided_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_appeals_review_key UNIQUE (review_id),
  CONSTRAINT review_appeals_review_fk FOREIGN KEY (region_id, review_id)
    REFERENCES reviews (region_id, id) ON DELETE CASCADE,
  CONSTRAINT review_appeals_decided_consistent CHECK ((status = 'open') = (decided_at IS NULL AND decided_by IS NULL)),
  CONSTRAINT review_appeals_other_moderator CHECK (decided_by IS NULL OR decided_by <> appealed_decision_by)
);

CREATE TRIGGER review_appeals_set_updated_at BEFORE UPDATE ON review_appeals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX review_appeals_open_idx ON review_appeals (region_id, created_at) WHERE status = 'open';
CREATE INDEX review_appeals_appellant_idx ON review_appeals (appellant_user_id);
CREATE INDEX review_appeals_appealed_by_idx ON review_appeals (appealed_decision_by);
CREATE INDEX review_appeals_decided_by_idx ON review_appeals (decided_by) WHERE decided_by IS NOT NULL;

SELECT app_enable_tenant_rls('review_appeals');
REVOKE ALL ON review_appeals FROM app;
GRANT SELECT, INSERT, UPDATE ON review_appeals TO app;

-- tenant: кэш рейтинга места (D-37 В): только published-отзывы с eligibility. score NULL — меньше порога отзывов
-- («Мало відгуків»). formula_version — версия формулы api: другая версия или устаревший расчёт — пересчёт.
CREATE TABLE place_review_ratings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  formula_version integer NOT NULL CONSTRAINT place_review_ratings_formula_check CHECK (formula_version >= 1),
  review_count integer NOT NULL CONSTRAINT place_review_ratings_count_check CHECK (review_count >= 0),
  average numeric(4, 3) CONSTRAINT place_review_ratings_average_check CHECK (average BETWEEN 1 AND 5),
  score numeric(4, 3) CONSTRAINT place_review_ratings_score_check CHECK (score BETWEEN 1 AND 5),
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_review_ratings_place_key UNIQUE (region_id, place_id),
  CONSTRAINT place_review_ratings_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT place_review_ratings_average_consistent CHECK ((review_count = 0) = (average IS NULL))
);

SELECT app_enable_tenant_rls('place_review_ratings');
REVOKE ALL ON place_review_ratings FROM app;
GRANT SELECT, INSERT, UPDATE ON place_review_ratings TO app;

-- Право на отзыв из брони (states-and-rules §3.4 «confirmed/no_show → completed»: ReviewEligibility(verified_booking)
-- при user_id; ручная бронь без пользователя права не даёт). Бронь вышла из completed, а отзыв не написан, —
-- eligibility revoked (D-82 (а); уже написанный отзыв остаётся, модератор проверяет его по жалобе). Событие
-- review_eligible — в analytics_events (как функции воркера 0022). SECURITY DEFINER: тот же путь из api (контекст
-- региона) и из воркера (SYSTEM); функция не читает ничего, кроме строки брони.
CREATE FUNCTION bookings_review_eligibility() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  new_id uuid;
BEGIN
  IF NEW.status = 'completed' AND NEW.user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    PERFORM set_config('app.actor', 'system', true);
    INSERT INTO public.review_eligibilities (region_id, user_id, place_id, organization_id, booking_id, source_ended_at)
    VALUES (NEW.region_id, NEW.user_id, NEW.place_id, NEW.organization_id, NEW.id, NEW.ends_at)
    ON CONFLICT (booking_id) DO NOTHING
    RETURNING id INTO new_id;
    IF new_id IS NOT NULL THEN
      INSERT INTO public.analytics_events (id, event_name, schema_version, occurred_at, pseudonymous_user_id,
        region_id, source, place_id, properties)
      SELECT public.uuidv7(), 'review_eligible', 1, now(), u.analytics_id, NEW.region_id, 'system', NEW.place_id,
        jsonb_build_object('placeId', NEW.place_id)
      FROM public.users u WHERE u.id = NEW.user_id;
    END IF;
    PERFORM set_config('app.actor', prev_actor, true);
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status IS DISTINCT FROM 'completed' THEN
    PERFORM set_config('app.actor', 'system', true);
    UPDATE public.review_eligibilities
    SET status = 'revoked', revoke_reason = 'booking_' || NEW.status, closed_at = now()
    WHERE booking_id = NEW.id AND status = 'active';
    PERFORM set_config('app.actor', prev_actor, true);
  END IF;
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION bookings_review_eligibility() FROM PUBLIC;

CREATE TRIGGER bookings_review_eligibility AFTER INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_review_eligibility();

-- Брони, завершённые до 0028, — право на отзыв (окно api по source_ended_at само отсечёт старые).
INSERT INTO review_eligibilities (region_id, user_id, place_id, organization_id, booking_id, source_ended_at)
SELECT b.region_id, b.user_id, b.place_id, b.organization_id, b.id, b.ends_at
FROM bookings b
WHERE b.status = 'completed' AND b.user_id IS NOT NULL
ON CONFLICT (booking_id) DO NOTHING;

-- Регион отзыва по id (режим SYSTEM, как app_moderation_case_region 0017): решение модератора, ответ партнёра,
-- жалоба и апелляция открывают транзакцию региона отзыва.
CREATE FUNCTION app_review_region(p_review_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  result uuid;
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  SELECT r.region_id INTO result FROM public.reviews r WHERE r.id = p_review_id;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN result;
END
$$;

REVOKE EXECUTE ON FUNCTION app_review_region(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_review_region(uuid) TO app;

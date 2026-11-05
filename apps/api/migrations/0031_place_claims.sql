-- 0031: «Це мій заклад» — заявка на право управлять существующим местом (место импорта Google или админки без
-- организации). Партнёр не создаёт дубль карточки Google: подаёт заявку на место из каталога, модератор вручную
-- проверяет (звонит на номер Google, D-47 А) и одобряет — место привязывается к организации заявителя
-- (places.organization_id), заявитель — ORG_OWNER. Место остаётся published и source = google: импорт не меняет поля
-- места с организацией (places-import/writer.ts). Ошибочное одобрение модератор отменяет (revoked).
-- tenant (ADR-005): region_id NOT NULL, RLS, составные FK (region_id, …).

SELECT set_config('app.actor', 'system', true);

-- Базовый шаблон партнёра для мест каталога, чья категория не входит в шаблоны «Готель / садиба», «Заклад
-- харчування», «Чан / сауна» (прокат, підйомники, магазини, сервіси, зарядки…): после одобрения заявки у места есть
-- редактор кабинета (опис, телефон, сайт, Telegram, графік, фото; поля личности — как обычно). category_codes = '*' —
-- «любая категория»: в онбординге (новое место) шаблон не показывается — у него нет категорий справочника.
INSERT INTO partner_templates (code, name_i18n, description_i18n, category_codes, required_fields, modules, sort_order)
VALUES
  ('base', '{"uk": "Інший заклад", "en": "Other venue"}',
    '{"uk": "Заклад із каталогу будь-якої категорії послуг", "en": "A catalog venue of any service category"}',
    ARRAY['*'], ARRAY['name', 'category', 'address', 'location'], ARRAY['offers'], 1000)
ON CONFLICT (code) DO NOTHING;

-- tenant: заявка на место. Организация: существующая (organization_id, где заявитель ORG_OWNER) или новая по
-- названию (new_organization_name) — создаётся при одобрении; после одобрения organization_id — итоговая организация.
-- Статусы: pending → approved | rejected (решение модератора; отказ — с обязательным комментарием) | withdrawn
-- (заявитель отозвал до решения); approved → revoked (модератор отменил ошибочное одобрение, с причиной). Одна заявка
-- на рассмотрении на (место, заявитель); конкурирующие заявки разных людей допустимы — одобрение одной отклоняет
-- остальные. Телефон и комментарий заявителя стираются через 90 дней после решения (place_claims_purge_expired_pii).
-- user_id — RESTRICT: пользователь физически не удаляется, удаление аккаунта — анонимизация (D-48).
CREATE TABLE place_claims (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid,
  new_organization_name text CONSTRAINT place_claims_org_name_check
    CHECK (char_length(btrim(new_organization_name)) BETWEEN 1 AND 200),
  claimant_role text NOT NULL CONSTRAINT place_claims_role_check CHECK (claimant_role IN ('owner', 'manager')),
  -- Телефон для обратного звонка модератора (E.164); источник — requestContact Telegram или ручной ввод. NULL — стёрт
  -- по сроку хранения (pii_purged_at).
  phone text CONSTRAINT place_claims_phone_check CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  phone_source text NOT NULL CONSTRAINT place_claims_phone_source_check
    CHECK (phone_source IN ('telegram_contact', 'manual')),
  comment text CONSTRAINT place_claims_comment_check CHECK (char_length(btrim(comment)) BETWEEN 1 AND 1000),
  pii_purged_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CONSTRAINT place_claims_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'revoked')),
  decision_comment text CONSTRAINT place_claims_decision_comment_check
    CHECK (char_length(btrim(decision_comment)) BETWEEN 1 AND 2000),
  decided_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  withdrawn_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  revoke_reason text CONSTRAINT place_claims_revoke_reason_check
    CHECK (char_length(btrim(revoke_reason)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_claims_region_id_key UNIQUE (region_id, id),
  CONSTRAINT place_claims_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT place_claims_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE RESTRICT,
  -- До одобрения — ровно один способ указать организацию; одобренная (и отменённая) — всегда с организацией.
  CONSTRAINT place_claims_org_choice CHECK (
    (status IN ('approved', 'revoked') AND organization_id IS NOT NULL)
    OR (status NOT IN ('approved', 'revoked') AND (organization_id IS NULL) <> (new_organization_name IS NULL))),
  CONSTRAINT place_claims_decided_consistent CHECK (
    (status IN ('approved', 'rejected', 'revoked')) = (decided_at IS NOT NULL)),
  CONSTRAINT place_claims_reject_comment CHECK (status <> 'rejected' OR decision_comment IS NOT NULL),
  CONSTRAINT place_claims_withdrawn_consistent CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CONSTRAINT place_claims_revoked_consistent CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)),
  CONSTRAINT place_claims_phone_or_purged CHECK (phone IS NOT NULL OR pii_purged_at IS NOT NULL)
);

CREATE TRIGGER place_claims_set_updated_at BEFORE UPDATE ON place_claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Одна заявка на рассмотрении на (место, заявитель) — гонка двух «Надіслати».
CREATE UNIQUE INDEX place_claims_pending_key ON place_claims (place_id, user_id) WHERE status = 'pending';
CREATE INDEX place_claims_queue_idx ON place_claims (region_id, status, created_at);
CREATE INDEX place_claims_place_idx ON place_claims (region_id, place_id, created_at DESC);
CREATE INDEX place_claims_user_idx ON place_claims (user_id, created_at DESC);
CREATE INDEX place_claims_organization_idx ON place_claims (region_id, organization_id)
  WHERE organization_id IS NOT NULL;
CREATE INDEX place_claims_decided_by_idx ON place_claims (decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX place_claims_revoked_by_idx ON place_claims (revoked_by) WHERE revoked_by IS NOT NULL;
-- Очистка ПДн по сроку: решённые заявки с ещё не стёртым телефоном.
CREATE INDEX place_claims_pii_idx ON place_claims (updated_at) WHERE pii_purged_at IS NULL AND status <> 'pending';

SELECT app_enable_tenant_rls('place_claims');
REVOKE ALL ON place_claims FROM app;
GRANT SELECT, INSERT ON place_claims TO app;
-- Приложение меняет только решение и его следы; телефон и комментарий стирает функция очистки (ниже).
GRANT UPDATE (status, organization_id, decision_comment, decided_by, decided_at, withdrawn_at, revoked_by,
  revoked_at, revoke_reason) ON place_claims TO app;

-- Регион заявки по id (режим SYSTEM, как app_moderation_case_region 0017): решение модератора открывает транзакцию
-- региона заявки.
CREATE FUNCTION app_place_claim_region(p_claim_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  result uuid;
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  SELECT c.region_id INTO result FROM public.place_claims c WHERE c.id = p_claim_id;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN result;
END
$$;

REVOKE EXECUTE ON FUNCTION app_place_claim_region(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_place_claim_region(uuid) TO app;

-- Очистка ПДн заявок по сроку (как service_requests_anonymize_expired 0015; вызывает воркер раз в сутки): у решённых
-- (одобрена, отклонена, отозвана, отменена) заявок, последнее изменение которых старше срока, стираются телефон и
-- комментарий заявителя. Заявка на рассмотрении не трогается. SECURITY DEFINER: у app нет UPDATE этих колонок.
CREATE FUNCTION place_claims_purge_expired_pii(p_retention_days integer, p_batch integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  n integer;
BEGIN
  -- Нижняя граница срока — 30 дней: ошибочный вызов не должен стереть телефон свежей заявки.
  IF p_retention_days IS NULL OR p_retention_days < 30 OR p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'place_claims_purge_expired_pii: срок (дней) — >= 30, пачка — >= 1' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  WITH stale AS (
    SELECT c.id FROM public.place_claims c
    WHERE c.pii_purged_at IS NULL AND c.status <> 'pending'
      AND c.updated_at < now() - make_interval(days => p_retention_days)
    ORDER BY c.updated_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.place_claims c SET phone = NULL, comment = NULL, pii_purged_at = now()
  FROM stale WHERE c.id = stale.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN n;
END
$$;

REVOKE EXECUTE ON FUNCTION place_claims_purge_expired_pii(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION place_claims_purge_expired_pii(integer, integer) TO app;

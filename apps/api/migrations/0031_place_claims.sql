-- 0031: «Це мій заклад» — заявка на право управлять существующим местом (место импорта Google или админки без
-- организации). Партнёр не создаёт дубль карточки Google: подаёт заявку на место из каталога, модератор вручную
-- проверяет (звонит на номер Google, D-47 А) и одобряет — место привязывается к организации заявителя
-- (places.organization_id), заявитель — ORG_OWNER. Место остаётся published и source = google: импорт не меняет поля
-- места с организацией (places-import/writer.ts).
-- tenant (ADR-005): region_id NOT NULL, RLS, составные FK (region_id, …).

SELECT set_config('app.actor', 'system', true);

-- tenant: заявка на место. Организация: существующая (organization_id, где заявитель ORG_OWNER) или новая по
-- названию (new_organization_name) — создаётся при одобрении; после одобрения organization_id — итоговая организация.
-- Статусы: pending → approved | rejected (решение модератора; отказ — с обязательным комментарием) | withdrawn
-- (отозвал заявитель). Одна заявка на рассмотрении на (место, заявитель); конкурирующие заявки разных людей
-- допустимы — одобрение одной отклоняет остальные.
CREATE TABLE place_claims (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid,
  new_organization_name text CONSTRAINT place_claims_org_name_check
    CHECK (char_length(btrim(new_organization_name)) BETWEEN 1 AND 200),
  claimant_role text NOT NULL CONSTRAINT place_claims_role_check CHECK (claimant_role IN ('owner', 'manager')),
  -- Телефон для обратного звонка модератора (E.164); источник — requestContact Telegram или ручной ввод.
  phone text NOT NULL CONSTRAINT place_claims_phone_check CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  phone_source text NOT NULL CONSTRAINT place_claims_phone_source_check
    CHECK (phone_source IN ('telegram_contact', 'manual')),
  comment text CONSTRAINT place_claims_comment_check CHECK (char_length(btrim(comment)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'pending' CONSTRAINT place_claims_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  decision_comment text CONSTRAINT place_claims_decision_comment_check
    CHECK (char_length(btrim(decision_comment)) BETWEEN 1 AND 2000),
  decided_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_claims_region_id_key UNIQUE (region_id, id),
  CONSTRAINT place_claims_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT place_claims_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE RESTRICT,
  -- Пока не одобрена — ровно один способ указать организацию; одобренная — всегда с организацией.
  CONSTRAINT place_claims_org_choice CHECK (
    (status = 'approved' AND organization_id IS NOT NULL)
    OR (status <> 'approved' AND (organization_id IS NULL) <> (new_organization_name IS NULL))),
  CONSTRAINT place_claims_decided_consistent CHECK (
    (status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT place_claims_reject_comment CHECK (status <> 'rejected' OR decision_comment IS NOT NULL)
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

SELECT app_enable_tenant_rls('place_claims');
REVOKE ALL ON place_claims FROM app;
GRANT SELECT, INSERT, UPDATE ON place_claims TO app;

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

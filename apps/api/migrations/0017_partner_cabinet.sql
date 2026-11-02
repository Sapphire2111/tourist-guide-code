-- 0017: кабинет партнёра (блок 6; ТЗ §5.1–§5.3, §16.1, §16.2; D-03, D-47, D-52, C-15, C-20; ADR-0021).
-- README apps/api, «Кабинет партнёра».
-- Шаблоны партнёров (partner_templates — данные, D-03 А), организации (organizations) и связь места с организацией и
-- шаблоном, статусы модерации места, заявки на модерацию (moderation_cases), приглашения сотрудников (staff_invites)
-- и акции (offers). Упрощения тестового режима (§1.6): без PlaceRevision — правка опубликованного места идёт сразу в
-- живую версию, модерацию проходит первичная публикация; без PIN/2FA сотрудника (D-52); право на заведение
-- подтверждает модератор вручную (D-47 А: способ проверки и комментарий в заявке, без загрузки документов).
-- Новые таблицы, кроме шаблонов, — tenant (ADR-005): region_id NOT NULL, RLS, составные FK (region_id, …). Ограничения
-- UNIQUE (region_id, id) — до FK, которые на них ссылаются (иначе 42830).

-- global: шаблон партнёра (D-03 А): категории (коды справочника региона), обязательные поля карточки при отправке на
-- модерацию и допустимые модули. Справочные данные платформы: три шаблона — ниже, в этой же миграции.
CREATE TABLE partner_templates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  code text NOT NULL CONSTRAINT partner_templates_code_format CHECK (is_catalog_code(code)),
  name_i18n jsonb NOT NULL CONSTRAINT partner_templates_name_check CHECK (is_localized_text(name_i18n)),
  description_i18n jsonb CONSTRAINT partner_templates_description_check
    CHECK (description_i18n IS NULL OR is_localized_text(description_i18n)),
  category_codes text[] NOT NULL DEFAULT '{}' CONSTRAINT partner_templates_categories_check
    CHECK (cardinality(category_codes) BETWEEN 1 AND 20),
  required_fields text[] NOT NULL DEFAULT '{}' CONSTRAINT partner_templates_required_fields_check
    CHECK (required_fields <@ ARRAY['name', 'category', 'description', 'address', 'location', 'phone', 'schedule',
      'photo']::text[]),
  modules text[] NOT NULL DEFAULT '{}' CONSTRAINT partner_templates_modules_check
    CHECK (modules <@ ARRAY['host_requests', 'offers']::text[]),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_templates_code_key UNIQUE (code)
);

CREATE TRIGGER partner_templates_set_updated_at BEFORE UPDATE ON partner_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Шаблоны правит платформа (миграцией; админка шаблонов — позже): у app только чтение.
REVOKE ALL ON partner_templates FROM app;
GRANT SELECT ON partner_templates TO app;

INSERT INTO partner_templates (code, name_i18n, description_i18n, category_codes, required_fields, modules, sort_order)
VALUES
  ('hotel', '{"uk": "Готель / садиба", "en": "Hotel / guest house"}',
    '{"uk": "Проживання: готель, садиба, міні-готель", "en": "Accommodation: hotel, guest house"}',
    ARRAY['hotels', 'sadyby'], ARRAY['name', 'category', 'description', 'address', 'location', 'phone', 'photo'],
    ARRAY['host_requests', 'offers'], 10),
  ('food', '{"uk": "Заклад харчування", "en": "Food & drinks"}',
    '{"uk": "Кафе, ресторан, колиба", "en": "Cafe, restaurant, kolyba"}',
    ARRAY['cafes', 'restaurants', 'kolyby'],
    ARRAY['name', 'category', 'description', 'address', 'location', 'phone', 'schedule', 'photo'],
    ARRAY['offers'], 20),
  ('chan', '{"uk": "Чан / сауна", "en": "Hot tub / sauna"}',
    '{"uk": "Чани, сауни, SPA", "en": "Hot tubs, saunas, SPA"}',
    ARRAY['chany', 'spa'],
    ARRAY['name', 'category', 'description', 'address', 'location', 'phone', 'schedule', 'photo'],
    ARRAY['offers'], 30)
ON CONFLICT (code) DO NOTHING;

-- tenant: организация партнёра (roles-and-data §2.3, Organization). Создаётся онбордингом (POST /partner/onboarding)
-- вместе с первым местом; владелец — назначение ORG_OWNER на ORGANIZATION. Юр. реквизиты — блок 9.
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  name text NOT NULL CONSTRAINT organizations_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CONSTRAINT organizations_status_check CHECK (status IN ('active', 'blocked')),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_region_id_key UNIQUE (region_id, id)
);

CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX organizations_created_by_idx ON organizations (created_by) WHERE created_by IS NOT NULL;

SELECT app_enable_tenant_rls('organizations');
REVOKE ALL ON organizations FROM app;
GRANT SELECT, INSERT, UPDATE ON organizations TO app;

-- Место партнёра: организация и шаблон (у мест админки и импорта — NULL). Статусы модерации (S-05,
-- states-and-rules §1.1): pending_moderation, changes_requested, rejected; туристу видно только published.
ALTER TABLE places
  ADD COLUMN organization_id uuid,
  ADD COLUMN partner_template_id uuid REFERENCES partner_templates(id) ON DELETE RESTRICT,
  ADD CONSTRAINT places_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT places_template_org CHECK (partner_template_id IS NULL OR organization_id IS NOT NULL),
  DROP CONSTRAINT places_status_check,
  ADD CONSTRAINT places_status_check CHECK (status IN ('draft', 'pending_moderation', 'changes_requested',
    'rejected', 'published', 'suspended', 'archived')),
  -- Статусы модерации — до первой публикации (как draft): first_published_at ещё нет.
  DROP CONSTRAINT places_published_once,
  ADD CONSTRAINT places_published_once CHECK (
    status IN ('draft', 'pending_moderation', 'changes_requested', 'rejected') OR first_published_at IS NOT NULL);

CREATE INDEX places_organization_idx ON places (region_id, organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX places_partner_template_idx ON places (partner_template_id) WHERE partner_template_id IS NOT NULL;

-- Родитель места в иерархии RBAC: организация (место партнёра) или регион (место админки). Читает в режиме SYSTEM,
-- как app_place_region() (0015): вызывается и вне транзакции региона (guard, назначение роли).
CREATE FUNCTION app_place_parent(p_place_id uuid)
RETURNS TABLE (organization_id uuid, region_id uuid)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  RETURN QUERY SELECT p.organization_id, p.region_id FROM public.places p WHERE p.id = p_place_id;
  PERFORM set_config('app.actor', prev_actor, true);
END
$$;

REVOKE EXECUTE ON FUNCTION app_place_parent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_place_parent(uuid) TO app;

-- Регион организации (ORGANIZATION → REGION) — так же, в режиме SYSTEM.
CREATE FUNCTION app_organization_region(p_organization_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  result uuid;
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  SELECT o.region_id INTO result FROM public.organizations o WHERE o.id = p_organization_id;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN result;
END
$$;

REVOKE EXECUTE ON FUNCTION app_organization_region(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_organization_region(uuid) TO app;

-- tenant: заявка на модерацию места (S-05, states-and-rules §1.3). Одна открытая заявка на место; повторная подача
-- после changes_requested — новая заявка (история видна модератору). Решение: approve — со способом проверки права
-- на заведение (D-47 А); reject и changes_requested — с обязательным комментарием (ТЗ §5.1). Снимок карточки на
-- момент подачи — place_snapshot (что именно смотрел модератор; версии PlaceRevision — позже).
CREATE TABLE moderation_cases (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CONSTRAINT moderation_cases_status_check CHECK (status IN ('open', 'decided')),
  decision text CONSTRAINT moderation_cases_decision_check
    CHECK (decision IN ('approve', 'reject', 'changes_requested')),
  comment text CONSTRAINT moderation_cases_comment_check CHECK (char_length(comment) BETWEEN 1 AND 2000),
  verification_method text CONSTRAINT moderation_cases_verification_check
    CHECK (verification_method IN ('phone_call', 'document', 'site_visit', 'other')),
  partner_note text CONSTRAINT moderation_cases_partner_note_check CHECK (char_length(partner_note) BETWEEN 1 AND 2000),
  place_snapshot jsonb NOT NULL DEFAULT '{}' CONSTRAINT moderation_cases_snapshot_object
    CHECK (jsonb_typeof(place_snapshot) = 'object'),
  submitted_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_cases_region_id_key UNIQUE (region_id, id),
  CONSTRAINT moderation_cases_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT moderation_cases_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT moderation_cases_decided_consistent CHECK (
    (status = 'decided') = (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT moderation_cases_comment_required CHECK (decision IS NULL OR decision = 'approve' OR comment IS NOT NULL),
  CONSTRAINT moderation_cases_verification_required CHECK (decision IS DISTINCT FROM 'approve'
    OR verification_method IS NOT NULL)
);

CREATE TRIGGER moderation_cases_set_updated_at BEFORE UPDATE ON moderation_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Одна открытая заявка на место (гонка двух «Надіслати»); очередь региона по статусу и возрасту.
CREATE UNIQUE INDEX moderation_cases_open_key ON moderation_cases (place_id) WHERE status = 'open';
CREATE INDEX moderation_cases_queue_idx ON moderation_cases (region_id, status, submitted_at);
CREATE INDEX moderation_cases_place_idx ON moderation_cases (region_id, place_id, submitted_at DESC);
CREATE INDEX moderation_cases_organization_idx ON moderation_cases (region_id, organization_id);
CREATE INDEX moderation_cases_submitted_by_idx ON moderation_cases (submitted_by);
CREATE INDEX moderation_cases_decided_by_idx ON moderation_cases (decided_by) WHERE decided_by IS NOT NULL;

SELECT app_enable_tenant_rls('moderation_cases');
REVOKE ALL ON moderation_cases FROM app;
GRANT SELECT, INSERT, UPDATE ON moderation_cases TO app;

-- Регион заявки на модерацию по id (режим SYSTEM): решение модератора открывает транзакцию региона заявки.
CREATE FUNCTION app_moderation_case_region(p_case_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  result uuid;
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  SELECT c.region_id INTO result FROM public.moderation_cases c WHERE c.id = p_case_id;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN result;
END
$$;

REVOKE EXECUTE ON FUNCTION app_moderation_case_region(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_moderation_case_region(uuid) TO app;

-- tenant: приглашение сотрудника (S-06, roles-and-data StaffInvite). Хранится только sha256 токена; токен — в ссылке
-- (ТЗ §3.3: без ПДн). Одноразовое: принятие ставит accepted_* и назначение роли; срок — expires_at (72 ч, api);
-- отзыв — revoked_*. Статус вычисляется: active / accepted / expired / revoked.
CREATE TABLE staff_invites (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  role text NOT NULL CONSTRAINT staff_invites_role_check CHECK (role IN ('ORG_MANAGER', 'ORG_STAFF')),
  token_hash bytea NOT NULL CONSTRAINT staff_invites_token_hash_check CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  role_assignment_id uuid REFERENCES role_assignments(id) ON DELETE RESTRICT,
  revoked_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_invites_token_hash_key UNIQUE (token_hash),
  CONSTRAINT staff_invites_organization_fk FOREIGN KEY (region_id, organization_id)
    REFERENCES organizations (region_id, id) ON DELETE CASCADE,
  CONSTRAINT staff_invites_accepted_consistent CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
  CONSTRAINT staff_invites_revoked_consistent CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT staff_invites_single_outcome CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT staff_invites_expiry_after_create CHECK (expires_at > created_at)
);

CREATE TRIGGER staff_invites_set_updated_at BEFORE UPDATE ON staff_invites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX staff_invites_organization_idx ON staff_invites (region_id, organization_id, created_at DESC);
CREATE INDEX staff_invites_created_by_idx ON staff_invites (created_by);
CREATE INDEX staff_invites_accepted_by_idx ON staff_invites (accepted_by) WHERE accepted_by IS NOT NULL;
CREATE INDEX staff_invites_revoked_by_idx ON staff_invites (revoked_by) WHERE revoked_by IS NOT NULL;
CREATE INDEX staff_invites_assignment_idx ON staff_invites (role_assignment_id) WHERE role_assignment_id IS NOT NULL;

SELECT app_enable_tenant_rls('staff_invites');
REVOKE ALL ON staff_invites FROM app;
GRANT SELECT, INSERT, UPDATE ON staff_invites TO app;

-- Регион приглашения по хэшу токена (режим SYSTEM): приглашённый ещё не имеет назначений в регионе.
CREATE FUNCTION app_staff_invite_region(p_token_hash bytea)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  result uuid;
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  SELECT i.region_id INTO result FROM public.staff_invites i WHERE i.token_hash = p_token_hash;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN result;
END
$$;

REVOKE EXECUTE ON FUNCTION app_staff_invite_region(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_staff_invite_region(bytea) TO app;

-- tenant: акция заведения (P07, roles-and-data Offer): заголовок и текст, период (оба края необязательны), статус
-- active / archived (архив вместо удаления). Показ туристу — позже (карточка места).
CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  title_i18n jsonb NOT NULL CONSTRAINT offers_title_check CHECK (is_localized_text(title_i18n)),
  description_i18n jsonb CONSTRAINT offers_description_check
    CHECK (description_i18n IS NULL OR is_localized_text(description_i18n)),
  starts_at timestamptz,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'active' CONSTRAINT offers_status_check CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offers_place_fk FOREIGN KEY (region_id, place_id) REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT offers_period_check CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE TRIGGER offers_set_updated_at BEFORE UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX offers_place_idx ON offers (region_id, place_id, status, created_at DESC);
CREATE INDEX offers_created_by_idx ON offers (created_by) WHERE created_by IS NOT NULL;

SELECT app_enable_tenant_rls('offers');
REVOKE ALL ON offers FROM app;
GRANT SELECT, INSERT, UPDATE ON offers TO app;

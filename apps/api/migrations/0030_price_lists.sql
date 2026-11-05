-- 0030: прайс заведения («Меню / послуги з цінами»): разделы («Страви», «Чани», «Номери») → позиции с ценой.
-- Правит партнёр (ORG_OWNER, ORG_MANAGER — право price_list.manage) в кабинете; турист видит в карточке места только
-- опубликованного партнёрского места (organization_id задан) и только позиции active в разделах active. Без заказа
-- и оплаты. Архив вместо удаления (история — AuditLog); версия строки — оптимистичная блокировка (409).
-- Цена — копейки (bigint, как resources.price_minor 0022), валюта UAH; «від» — price_from; единица («за годину»,
-- «за особу») — короткий текст. Фото позиции — позже (без поля).
-- Новые таблицы — tenant (ADR-005): region_id NOT NULL, RLS, составные FK (region_id, …). Ограничения UNIQUE
-- (region_id, id) — до FK, которые на них ссылаются (иначе 42830).

-- tenant: раздел прайса места. hidden — скрыт от туриста вместе с позициями; archived — убран из кабинета.
CREATE TABLE price_list_sections (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  title_i18n jsonb NOT NULL CONSTRAINT price_list_sections_title_check
    CHECK (is_localized_text(title_i18n) AND char_length(title_i18n ->> 'uk') <= 80),
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT price_list_sections_status_check CHECK (status IN ('active', 'hidden', 'archived')),
  version integer NOT NULL DEFAULT 1 CONSTRAINT price_list_sections_version_check CHECK (version >= 1),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_list_sections_region_id_key UNIQUE (region_id, id),
  CONSTRAINT price_list_sections_place_id_key UNIQUE (region_id, place_id, id),
  CONSTRAINT price_list_sections_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE
);

CREATE TRIGGER price_list_sections_set_updated_at BEFORE UPDATE ON price_list_sections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX price_list_sections_place_idx ON price_list_sections (region_id, place_id, status, sort_order);
CREATE INDEX price_list_sections_created_by_idx ON price_list_sections (created_by) WHERE created_by IS NOT NULL;

SELECT app_enable_tenant_rls('price_list_sections');
REVOKE ALL ON price_list_sections FROM app;
GRANT SELECT, INSERT, UPDATE ON price_list_sections TO app;

-- tenant: позиция прайса. place_id дублирует место раздела (лимит позиций на место, выборка карточки одним индексом);
-- составной FK на раздел того же места — позиция не уйдёт в раздел чужого места.
CREATE TABLE price_list_items (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  section_id uuid NOT NULL,
  name_i18n jsonb NOT NULL CONSTRAINT price_list_items_name_check
    CHECK (is_localized_text(name_i18n) AND char_length(name_i18n ->> 'uk') <= 120),
  description_i18n jsonb CONSTRAINT price_list_items_description_check
    CHECK (description_i18n IS NULL OR (is_localized_text(description_i18n)
      AND char_length(description_i18n ->> 'uk') <= 500)),
  -- Копейки: до 10 000 000 грн (защита от опечатки лишними нулями).
  price_minor bigint NOT NULL
    CONSTRAINT price_list_items_price_check CHECK (price_minor BETWEEN 0 AND 1000000000),
  currency text NOT NULL DEFAULT 'UAH' CONSTRAINT price_list_items_currency_check CHECK (currency = 'UAH'),
  -- «від 300 грн»: цена — нижняя граница.
  price_from boolean NOT NULL DEFAULT false,
  unit_i18n jsonb CONSTRAINT price_list_items_unit_check
    CHECK (unit_i18n IS NULL OR (is_localized_text(unit_i18n) AND char_length(unit_i18n ->> 'uk') <= 40)),
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT price_list_items_status_check CHECK (status IN ('active', 'hidden', 'archived')),
  version integer NOT NULL DEFAULT 1 CONSTRAINT price_list_items_version_check CHECK (version >= 1),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_list_items_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT price_list_items_section_fk FOREIGN KEY (region_id, place_id, section_id)
    REFERENCES price_list_sections (region_id, place_id, id) ON DELETE CASCADE
);

CREATE TRIGGER price_list_items_set_updated_at BEFORE UPDATE ON price_list_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX price_list_items_place_idx ON price_list_items (region_id, place_id, status);
CREATE INDEX price_list_items_section_idx ON price_list_items (region_id, place_id, section_id, sort_order);
CREATE INDEX price_list_items_created_by_idx ON price_list_items (created_by) WHERE created_by IS NOT NULL;

SELECT app_enable_tenant_rls('price_list_items');
REVOKE ALL ON price_list_items FROM app;
GRANT SELECT, INSERT, UPDATE ON price_list_items TO app;

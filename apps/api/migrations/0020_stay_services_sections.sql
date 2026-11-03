-- 0020: разделы главной «Де жити» (stay), «Гірські лижі» (ski), «Сервіси» (services); «Трансфер» → «Авто»;
-- категория, поставленная импортом мест; дополнительные категории места (место в нескольких разделах).
-- «Де жити» отдельно от «Про заклад» (about — карточка заведения по QR, C-13): корневая категория stay раньше висела
-- на about и плитки на главной не имела. «Сервіси» — ремонт техники, связь, автомойки, почта, прачечные,
-- парикмахерские: корень создаёт seed или импорт мест.
ALTER TABLE categories DROP CONSTRAINT categories_home_section_check;
ALTER TABLE categories ADD CONSTRAINT categories_home_section_check
  CHECK (home_section IN ('about', 'stay', 'eat', 'shop', 'relax', 'fun', 'ski', 'nearby', 'transfer', 'services', 'help'));

-- import_category_id — категория, которую последний раз поставил импорт Google. Совпадает с category_id — админка
-- категорию не меняла, и повторный импорт может переразметить место (новые правила); не совпадает — правка админки
-- главнее. NULL — у мест админки/seed и у мест импорта, которых касался пользователь до 0020 (см. заполнение ниже).
ALTER TABLE places
  ADD COLUMN import_category_id uuid,
  ADD CONSTRAINT places_import_category_fk FOREIGN KEY (region_id, import_category_id)
    REFERENCES categories (region_id, id) ON DELETE SET NULL (import_category_id);

-- tenant (ADR-005): дополнительные категории места — место видно и в этих разделах (поиск по категории и разделу
-- учитывает основную ИЛИ дополнительную); карточка показывает основную. Категория — подкатегория или корень.
-- source: import — поставил импорт Google (повторный импорт пересобирает только их), manual — админка (не трогается).
CREATE TABLE place_extra_categories (
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  category_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'manual' CONSTRAINT place_extra_categories_source_check
    CHECK (source IN ('manual', 'import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (place_id, category_id),
  CONSTRAINT place_extra_categories_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT place_extra_categories_category_fk FOREIGN KEY (region_id, category_id)
    REFERENCES categories (region_id, id) ON DELETE CASCADE
);

CREATE INDEX place_extra_categories_category_idx ON place_extra_categories (region_id, category_id);
CREATE INDEX place_extra_categories_place_region_idx ON place_extra_categories (region_id, place_id);

SELECT app_enable_tenant_rls('place_extra_categories');
GRANT SELECT, INSERT, UPDATE, DELETE ON place_extra_categories TO app;

SELECT set_config('app.actor', 'system', true);
UPDATE categories SET home_section = 'stay' WHERE code = 'stay' AND parent_id IS NULL AND home_section = 'about';
-- Название раздела — «Де жити» (просьба владельца 03.11.2026), если админка его не меняла.
UPDATE categories SET name_i18n = jsonb_set(name_i18n, '{uk}', '"Де жити"')
  WHERE code = 'stay' AND parent_id IS NULL AND name_i18n ->> 'uk' = 'Де зупинитися';
-- «Трансфер» → «Авто» (код transfer прежний), если админка название не меняла; СТО й шиномонтаж и автомийки —
-- в «Авто» (раньше «Халепа?» и «Сервіси»; в «Халепі» СТО остаётся дополнительной категорией через импорт).
UPDATE categories SET name_i18n = name_i18n || '{"uk": "Авто", "en": "Car"}'::jsonb
  WHERE code = 'transfer' AND parent_id IS NULL AND name_i18n ->> 'uk' = 'Трансфер';
UPDATE categories c SET parent_id = t.id,
    name_i18n = CASE WHEN c.code = 'car-service' AND c.name_i18n ->> 'uk' = 'СТО'
      THEN c.name_i18n || '{"uk": "СТО й шиномонтаж", "en": "Car service and tyres"}'::jsonb ELSE c.name_i18n END
  FROM categories t
  WHERE t.region_id = c.region_id AND t.code = 'transfer' AND t.parent_id IS NULL
    AND c.code IN ('car-service', 'car-wash') AND c.parent_id IS DISTINCT FROM t.id;
-- Места импорта, которых не касался ни один пользователь (в журнале аудита нет действий пользователя над местом):
-- категория — от импорта.
UPDATE places p SET import_category_id = p.category_id
  WHERE p.source = 'google'
    AND NOT EXISTS (
      SELECT 1 FROM audit_logs a
      WHERE a.entity_type = 'place' AND a.entity_id = p.id::text AND a.actor_type = 'user'
    );

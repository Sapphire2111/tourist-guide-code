-- 0012: каталог региона для админки (блок 3, шаг 2 плана §1.6; ТЗ §4.2–4.4, §7.1–7.2, §13, §14.2; D-01, D-02, D-32,
-- D-53; ADR-0017). README apps/api, «Каталог».
-- Населённые пункты (localities), категории (categories, один уровень вложенности) и теги (tags), места (places) с
-- тегами, недельным графиком и исключениями, фото (place_media → media_assets) и историей бейджа «Ми рекомендуємо»
-- (place_badge_events, D-32: бейдж — поле места, история — отдельная таблица с причиной).
-- Упрощения шага 2 (§1.6): правка места сразу в живую версию (без PlaceRevision), без организаций и шаблонов
-- партнёров (D-03), категории и теги — региональные (глобальный справочник с региональными дополнениями — позже,
-- нужен третий класс изоляции, ADR-0005 «Открытое»).
--
-- Все таблицы — tenant (ADR-005): region_id NOT NULL, RLS (app_enable_tenant_rls), ссылки между таблицами — составными
-- FK (region_id, …) → (region_id, id): БД сама не даёт связать место с категорией или фото другого региона.
-- Права app — явно (ADR-0006: ALTER DEFAULT PRIVILEGES из 0003 действует, только если миграции выполняет та же роль).

-- Цель составного FK place_media → media_assets: фото и место — в одном регионе.
ALTER TABLE media_assets ADD CONSTRAINT media_assets_region_id_key UNIQUE (region_id, id);

-- Код справочника: латиница в нижнем регистре, цифры, «-» и «_» (как regions.code), уникален в регионе.
CREATE FUNCTION is_catalog_code(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT v ~ '^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$' $$;

-- tenant (ADR-005): населённый пункт, зона или ориентир региона (ТЗ §7.2 «населені пункти, зони, координати»).
CREATE TABLE localities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  code text NOT NULL CONSTRAINT localities_code_format CHECK (is_catalog_code(code)),
  kind text NOT NULL DEFAULT 'settlement'
    CONSTRAINT localities_kind_check CHECK (kind IN ('settlement', 'zone', 'landmark')),
  name_i18n jsonb NOT NULL CONSTRAINT localities_name_i18n_check CHECK (is_localized_text(name_i18n)),
  -- Центр населённого пункта (WGS 84, долгота/широта); необязателен.
  location geometry(Point, 4326),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT localities_region_code_key UNIQUE (region_id, code),
  CONSTRAINT localities_region_id_key UNIQUE (region_id, id)
);

CREATE TRIGGER localities_set_updated_at BEFORE UPDATE ON localities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

SELECT app_enable_tenant_rls('localities');
GRANT SELECT, INSERT, UPDATE, DELETE ON localities TO app;

-- tenant (ADR-005): категория региона (D-02 вариант А — дерево по кнопкам главной ТЗ §4.2). Один уровень вложенности:
-- корневой раздел и его подкатегории (триггер ниже). home_section — кнопка главной C02, только у корневых.
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  parent_id uuid,
  code text NOT NULL CONSTRAINT categories_code_format CHECK (is_catalog_code(code)),
  name_i18n jsonb NOT NULL CONSTRAINT categories_name_i18n_check CHECK (is_localized_text(name_i18n)),
  -- Имя иконки из набора фронтенда (packages/ui), не URL.
  icon text CONSTRAINT categories_icon_format CHECK (icon ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- Кнопка главной C02 (ТЗ §4.2): about «Про заклад», eat «Де поїсти», shop «Де купити», relax «Де відпочити»,
  -- fun «Розваги», nearby «Що поруч», transfer «Трансфер», help «Халепа?».
  home_section text CONSTRAINT categories_home_section_check
    CHECK (home_section IN ('about', 'eat', 'shop', 'relax', 'fun', 'nearby', 'transfer', 'help')),
  sort_order integer NOT NULL DEFAULT 0,
  -- Выключенная категория не показывается туристу (блок 4); места в ней остаются.
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_region_code_key UNIQUE (region_id, code),
  CONSTRAINT categories_region_id_key UNIQUE (region_id, id),
  CONSTRAINT categories_parent_fk FOREIGN KEY (region_id, parent_id)
    REFERENCES categories (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT categories_not_self_parent CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT categories_home_section_root_only CHECK (parent_id IS NULL OR home_section IS NULL)
);

-- Один уровень: родитель — корневой, у подкатегории не бывает детей. Под RLS триггер видит строки своего региона —
-- этого достаточно: родитель того же региона (составной FK).
CREATE FUNCTION categories_check_depth() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.categories c WHERE c.id = NEW.parent_id AND c.parent_id IS NOT NULL) THEN
      RAISE EXCEPTION 'categories: родитель % сам подкатегория (допустим один уровень)', NEW.parent_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_depth';
    END IF;
    IF EXISTS (SELECT 1 FROM public.categories c WHERE c.parent_id = NEW.id) THEN
      RAISE EXCEPTION 'categories: у % есть подкатегории, она не может стать подкатегорией', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_depth';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER categories_check_depth BEFORE INSERT OR UPDATE OF parent_id ON categories
  FOR EACH ROW EXECUTE FUNCTION categories_check_depth();
CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX categories_parent_idx ON categories (region_id, parent_id, sort_order);

SELECT app_enable_tenant_rls('categories');
GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO app;

-- tenant (ADR-005): тег региона (кухня, «з дітьми», парковка… ТЗ §4.3–4.4), сгруппированный для фильтров.
CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  code text NOT NULL CONSTRAINT tags_code_format CHECK (is_catalog_code(code)),
  name_i18n jsonb NOT NULL CONSTRAINT tags_name_i18n_check CHECK (is_localized_text(name_i18n)),
  tag_group text NOT NULL DEFAULT 'other' CONSTRAINT tags_group_check
    CHECK (tag_group IN ('cuisine', 'audience', 'amenity', 'season', 'weather', 'other')),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_region_code_key UNIQUE (region_id, code),
  CONSTRAINT tags_region_id_key UNIQUE (region_id, id)
);

CREATE TRIGGER tags_set_updated_at BEFORE UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

SELECT app_enable_tenant_rls('tags');
GRANT SELECT, INSERT, UPDATE, DELETE ON tags TO app;

-- tenant (ADR-005): место каталога — заведение или публичная локация (roles-and-data §2.3, Place). Туристу (блок 4)
-- видно только published. Статусы шага 2: draft → published ⇄ suspended, любое → archived, archived → published;
-- без модерации и PlaceRevision (§1.6). Контакты — деловые контакты заведения (не ПДн туриста).
CREATE TABLE places (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  locality_id uuid,
  name_i18n jsonb NOT NULL CONSTRAINT places_name_i18n_check CHECK (is_localized_text(name_i18n)),
  description_i18n jsonb CONSTRAINT places_description_i18n_check
    CHECK (description_i18n IS NULL OR is_localized_text(description_i18n)),
  address_i18n jsonb CONSTRAINT places_address_i18n_check
    CHECK (address_i18n IS NULL OR is_localized_text(address_i18n)),
  -- Точка входа (WGS 84, долгота/широта); расстояния — через ::geography (ADR-006, «Гео»).
  location geometry(Point, 4326),
  -- Телефон E.164, сайт https, Telegram — имя без @ (как qr_points.venue_*, 0011).
  phone text CONSTRAINT places_phone_format CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  website text CONSTRAINT places_website_format CHECK (website ~ '^https://' AND char_length(website) <= 300),
  telegram text CONSTRAINT places_telegram_format CHECK (telegram ~ '^[A-Za-z0-9_]{5,32}$'),
  status text NOT NULL DEFAULT 'draft'
    CONSTRAINT places_status_check CHECK (status IN ('draft', 'published', 'suspended', 'archived')),
  -- «Ми рекомендуємо» (ТЗ §14.2, D-32): только поле; кто, когда и почему выдал/снял — place_badge_events.
  -- Не связано с платным продвижением (Promotion, ТЗ §1.3).
  recommended boolean NOT NULL DEFAULT false,
  -- «Дата останньої перевірки інформації» (ТЗ §4.4, D-53).
  verified_at timestamptz,
  -- Первая публикация (NULL — ни разу не публиковалось: такое место можно удалить, иначе — только архив).
  first_published_at timestamptz,
  -- Кто создал; NULL — SYSTEM (seed).
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT places_region_id_key UNIQUE (region_id, id),
  CONSTRAINT places_category_fk FOREIGN KEY (region_id, category_id)
    REFERENCES categories (region_id, id) ON DELETE RESTRICT,
  CONSTRAINT places_locality_fk FOREIGN KEY (region_id, locality_id)
    REFERENCES localities (region_id, id) ON DELETE RESTRICT,
  -- Обязательные поля опубликованного места (страховка; понятную ошибку 422 даёт api до записи).
  CONSTRAINT places_published_complete CHECK (
    status <> 'published' OR (description_i18n IS NOT NULL AND address_i18n IS NOT NULL AND location IS NOT NULL)
  ),
  CONSTRAINT places_published_once CHECK (status = 'draft' OR first_published_at IS NOT NULL)
);

CREATE TRIGGER places_set_updated_at BEFORE UPDATE ON places
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Выдача туристу (блок 4): опубликованные места региона по категории; список админки — по статусу.
CREATE INDEX places_region_status_category_idx ON places (region_id, status, category_id);
-- Список админки по региону (курсор по id) и FK на categories/localities.
CREATE INDEX places_region_id_idx ON places (region_id, id);
CREATE INDEX places_category_idx ON places (region_id, category_id);
CREATE INDEX places_locality_idx ON places (region_id, locality_id) WHERE locality_id IS NOT NULL;
-- «Що поруч» (ST_DWithin по geography, метры) и карта (bbox по geometry) — ADR-006.
CREATE INDEX places_location_geog_idx ON places USING gist ((location::geography));
CREATE INDEX places_location_idx ON places USING gist (location);
CREATE INDEX places_created_by_idx ON places (created_by) WHERE created_by IS NOT NULL;

SELECT app_enable_tenant_rls('places');
GRANT SELECT, INSERT, UPDATE, DELETE ON places TO app;

-- tenant (ADR-005): теги места (многие-ко-многим).
CREATE TABLE place_tags (
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (place_id, tag_id),
  CONSTRAINT place_tags_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT place_tags_tag_fk FOREIGN KEY (region_id, tag_id) REFERENCES tags (region_id, id) ON DELETE CASCADE
);

CREATE INDEX place_tags_tag_idx ON place_tags (region_id, tag_id);
CREATE INDEX place_tags_place_region_idx ON place_tags (region_id, place_id);

SELECT app_enable_tenant_rls('place_tags');
GRANT SELECT, INSERT, UPDATE, DELETE ON place_tags TO app;

-- tenant (ADR-005): недельный график места (roles-and-data §2.3, Schedule) — интервалы местного времени в таймзоне
-- региона (regions.timezone). Несколько интервалов в день (обед). closes_at <= opens_at — интервал через полночь
-- (закрывается на следующий день). Нет ни одной строки — график неизвестен («Відкрито зараз» не показывается).
CREATE TABLE place_schedules (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  -- ISO 8601: 1 — понедельник … 7 — воскресенье.
  day_of_week smallint NOT NULL CONSTRAINT place_schedules_day_check CHECK (day_of_week BETWEEN 1 AND 7),
  opens_at time NOT NULL,
  closes_at time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_schedules_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT place_schedules_interval_key UNIQUE (place_id, day_of_week, opens_at),
  CONSTRAINT place_schedules_not_empty CHECK (opens_at <> closes_at)
);

CREATE INDEX place_schedules_place_region_idx ON place_schedules (region_id, place_id);

SELECT app_enable_tenant_rls('place_schedules');
GRANT SELECT, INSERT, UPDATE, DELETE ON place_schedules TO app;

-- tenant (ADR-005): исключения графика на дату (праздник, сезонное закрытие, сокращённый день). closed — закрыто весь
-- день; иначе — интервалы этой даты вместо недельного графика.
CREATE TABLE place_schedule_exceptions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  date date NOT NULL,
  closed boolean NOT NULL,
  opens_at time,
  closes_at time,
  note_i18n jsonb CONSTRAINT place_schedule_exceptions_note_check
    CHECK (note_i18n IS NULL OR is_localized_text(note_i18n)),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_schedule_exceptions_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT place_schedule_exceptions_interval_key UNIQUE NULLS NOT DISTINCT (place_id, date, opens_at),
  CONSTRAINT place_schedule_exceptions_consistent CHECK (
    (closed AND opens_at IS NULL AND closes_at IS NULL)
    OR (NOT closed AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at <> closes_at)
  )
);

CREATE INDEX place_schedule_exceptions_place_idx ON place_schedule_exceptions (region_id, place_id, date);

SELECT app_enable_tenant_rls('place_schedule_exceptions');
GRANT SELECT, INSERT, UPDATE, DELETE ON place_schedule_exceptions TO app;

-- tenant (ADR-005): фото места — привязка загруженного media_assets (T1-20) с порядком и обложкой. Альтернативный текст
-- хранится в media_assets.alt_i18n (одно место правды); без alt text место не публикуется (ТЗ §13 «Контент»).
-- Файл привязан к одному месту; отвязка удаляет строку, сам файл остаётся (очистка — позже).
CREATE TABLE place_media (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  media_asset_id uuid NOT NULL CONSTRAINT place_media_asset_key UNIQUE,
  sort_order integer NOT NULL DEFAULT 0,
  is_cover boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_media_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  CONSTRAINT place_media_asset_fk FOREIGN KEY (region_id, media_asset_id)
    REFERENCES media_assets (region_id, id) ON DELETE CASCADE
);

CREATE TRIGGER place_media_set_updated_at BEFORE UPDATE ON place_media
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Галерея места по порядку; одна обложка на место.
CREATE INDEX place_media_place_idx ON place_media (region_id, place_id, sort_order);
CREATE UNIQUE INDEX place_media_one_cover_key ON place_media (place_id) WHERE is_cover;

SELECT app_enable_tenant_rls('place_media');
GRANT SELECT, INSERT, UPDATE, DELETE ON place_media TO app;

-- tenant (ADR-005): история «Ми рекомендуємо» (ТЗ §14.2 «Зберігати історію, хто і чому надав/зняв бейдж», D-32).
-- Только дописывается: app — SELECT и INSERT. Место с историей не удаляется (RESTRICT) — только архив.
CREATE TABLE place_badge_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  action text NOT NULL CONSTRAINT place_badge_events_action_check CHECK (action IN ('grant', 'revoke')),
  reason text NOT NULL CONSTRAINT place_badge_events_reason_check
    CHECK (btrim(reason) <> '' AND char_length(reason) <= 1000),
  -- Кто выдал/снял; NULL — SYSTEM (seed, правило снятия — позже).
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_badge_events_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE RESTRICT
);

CREATE INDEX place_badge_events_place_idx ON place_badge_events (region_id, place_id, created_at);
CREATE INDEX place_badge_events_actor_idx ON place_badge_events (actor_user_id) WHERE actor_user_id IS NOT NULL;

SELECT app_enable_tenant_rls('place_badge_events');
-- REVOKE — права могли прийти по ALTER DEFAULT PRIVILEGES (0003).
REVOKE ALL ON place_badge_events FROM app;
GRANT SELECT, INSERT ON place_badge_events TO app;

-- 0011: QR-контекст входа (блок 2; ТЗ §3, §16.1–16.2; D-29, C-12; ADR-0016). README apps/api, «QR-контекст».
-- QR-точка (qr_points), журнал сканов (qr_scan_events), итоговый контекст входа (entry_contexts) и все касания
-- атрибуции (attribution_touches, D-29 — только хранение; правило first/last-touch — блок 11).
-- Не зависит от 0010 (вход/профиль идёт параллельно): только regions и users.
--
-- QR не содержит ПДн (ТЗ §3.3): в ссылке t.me/<bot>/<app>?startapp=<code> — только непрозрачный случайный код
-- qr_points.code. Формат кода проверяют и CHECK, и api (apps/api/src/modules/qr-context/start-param.ts).
-- IP и user agent сканов здесь не хранятся (C-12, логи без ПДн): защита от перебора — rate limit api по IP.

-- tenant (ADR-005): QR-точка принадлежит региону. Код уникален во всей платформе — по нему api находит точку
-- до того, как регион известен (поиск от имени SYSTEM, README «QR-контекст»).
-- Таблиц мест и организаций ещё нет (блок 3): place_id — uuid без FK (как owner_id в media_assets, 0009), а данные
-- экрана «Про заклад» для QR отеля — минимальные поля venue_* прямо в точке. Когда появится Place, api будет брать
-- карточку из него, а venue_* останутся запасным вариантом (удаление — отдельной миграцией, expand/contract).
CREATE TABLE qr_points (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  -- Непрозрачный код для start_param: латиница, цифры, _ и -, 10–64 символа, не только цифры (не похож на
  -- телефон/номер документа). Генерирует api (12 случайных символов base62) или задаёт seed.
  code text NOT NULL CONSTRAINT qr_points_code_key UNIQUE
    CONSTRAINT qr_points_code_format CHECK (code ~ '^[A-Za-z0-9_-]{10,64}$' AND code !~ '^[0-9]+$'),
  -- hotel — QR отеля/заклада (экран «Про заклад»); place — QR места каталога; region — QR региона (стенд, вокзал);
  -- campaign — QR рекламной кампании.
  type text NOT NULL CONSTRAINT qr_points_type_check CHECK (type IN ('hotel', 'place', 'region', 'campaign')),
  place_id uuid,
  -- Метка кампании (utm-подобный код, без ПДн) и канал размещения (наклейка, листовка, стенд…).
  campaign text CONSTRAINT qr_points_campaign_format CHECK (campaign ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  source text CONSTRAINT qr_points_source_format CHECK (source ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  active boolean NOT NULL DEFAULT true,
  -- Подпись для админки («Ресепшн, 1 поверх»); туристу не показывается.
  label text NOT NULL CONSTRAINT qr_points_label_check CHECK (btrim(label) <> '' AND char_length(label) <= 200),
  -- «Про заклад» (до Place блока 3): название, описание, адрес — мультиязычные, uk обязателен; контакты —
  -- деловые контакты заклада (не ПДн туриста): телефон, сайт, Telegram.
  venue_name_i18n jsonb CONSTRAINT qr_points_venue_name_check
    CHECK (venue_name_i18n IS NULL OR is_localized_text(venue_name_i18n)),
  venue_description_i18n jsonb CONSTRAINT qr_points_venue_description_check
    CHECK (venue_description_i18n IS NULL OR is_localized_text(venue_description_i18n)),
  venue_address_i18n jsonb CONSTRAINT qr_points_venue_address_check
    CHECK (venue_address_i18n IS NULL OR is_localized_text(venue_address_i18n)),
  venue_phone text CONSTRAINT qr_points_venue_phone_format CHECK (venue_phone ~ '^\+[1-9][0-9]{6,14}$'),
  venue_website text CONSTRAINT qr_points_venue_website_format
    CHECK (venue_website ~ '^https://' AND char_length(venue_website) <= 300),
  venue_telegram text CONSTRAINT qr_points_venue_telegram_format CHECK (venue_telegram ~ '^[A-Za-z0-9_]{5,32}$'),
  -- Кто деактивировал и когда — пока не храним: история изменений — AuditLog админки (блок 3).
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Цель составных FK журналов: точка и строка журнала — в одном регионе (ADR-006).
  CONSTRAINT qr_points_region_id_key UNIQUE (region_id, id),
  -- Карточка «Про заклад» — только у QR отеля и только с названием.
  CONSTRAINT qr_points_venue_hotel_only CHECK (
    type = 'hotel' OR (venue_name_i18n IS NULL AND venue_description_i18n IS NULL AND venue_address_i18n IS NULL
      AND venue_phone IS NULL AND venue_website IS NULL AND venue_telegram IS NULL)
  ),
  CONSTRAINT qr_points_campaign_required CHECK (type <> 'campaign' OR campaign IS NOT NULL)
);

CREATE TRIGGER qr_points_set_updated_at BEFORE UPDATE ON qr_points
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Список точек региона в админке (фильтр TenantGuardPlugin); поиск по коду — уникальный индекс qr_points_code_key.
CREATE INDEX qr_points_region_idx ON qr_points (region_id, created_at);
CREATE INDEX qr_points_place_idx ON qr_points (place_id) WHERE place_id IS NOT NULL;

SELECT app_enable_tenant_rls('qr_points');
GRANT SELECT, INSERT, UPDATE, DELETE ON qr_points TO app;

-- tenant-optional (ADR-006, журнал): регион показанного контекста; NULL — в платформе нет ни одного активного
-- региона (нейтральный контекст без региона). Журнал QR-событий — не пользовательская «Історія» гостя (C-12).
-- Каждое открытие GET /context/{start_param} — одна строка, в том числе неизвестный и мусорный параметр.
CREATE TABLE qr_scan_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid REFERENCES regions(id) ON DELETE RESTRICT,
  qr_point_id uuid,
  -- Параметр как пришёл — только если он прошёл проверку формата кода (тот же CHECK, что у qr_points.code,
  -- то есть не длиннее 64 символов); мусор и ПДн-подобные значения не сохраняются (NULL, result = invalid).
  raw_start_param text CONSTRAINT qr_scan_events_raw_format
    CHECK (raw_start_param ~ '^[A-Za-z0-9_-]{10,64}$' AND raw_start_param !~ '^[0-9]+$'),
  -- ok — активная точка; inactive — точка деактивирована (или её регион не активен); not_found — код по формату
  -- верный, но точки нет; invalid — параметр не прошёл проверку формата.
  result text NOT NULL CONSTRAINT qr_scan_events_result_check
    CHECK (result IN ('ok', 'inactive', 'not_found', 'invalid')),
  -- Пользователь, если запрос пришёл с сессией; anonymous_id — устройство (как analytics_events.anonymous_id).
  -- Псевдонимные ПДн: обнуляются по запросу на удаление (privacy request, D-48), срок хранения — D-73.
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  anonymous_id uuid,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qr_scan_events_point_fk FOREIGN KEY (region_id, qr_point_id)
    REFERENCES qr_points (region_id, id) ON DELETE SET NULL (qr_point_id),
  -- Точка есть только у ok/inactive (у них она может стать NULL после удаления точки — ON DELETE SET NULL).
  CONSTRAINT qr_scan_events_point_consistent CHECK (result IN ('ok', 'inactive') OR qr_point_id IS NULL),
  CONSTRAINT qr_scan_events_actor CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);

CREATE INDEX qr_scan_events_region_idx ON qr_scan_events (region_id, scanned_at);
CREATE INDEX qr_scan_events_point_idx ON qr_scan_events (qr_point_id, scanned_at) WHERE qr_point_id IS NOT NULL;
CREATE INDEX qr_scan_events_user_idx ON qr_scan_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX qr_scan_events_anonymous_idx ON qr_scan_events (anonymous_id) WHERE anonymous_id IS NOT NULL;

SELECT app_enable_tenant_rls('qr_scan_events');
-- Журнал только дописывается: app — без DELETE/TRUNCATE и без UPDATE строки; разрешена только замена
-- псевдонимных ПДн по запросу на удаление (D-48): CHECK *_actor требует user_id или anonymous_id — анонимизация
-- подставляет новый случайный anonymous_id вместо user_id. REVOKE — права могли прийти по ALTER DEFAULT PRIVILEGES (0003).
REVOKE ALL ON qr_scan_events FROM app;
GRANT SELECT, INSERT ON qr_scan_events TO app;
GRANT UPDATE (user_id, anonymous_id) ON qr_scan_events TO app;

-- tenant (ADR-005): итоговый контекст входа — регион, базовая точка и её тип. На него ссылаются события аналитики
-- (analytics_events.entry_context_id, без FK — журнал) и будущие экраны (C02 «Про заклад», C05 «Що поруч»).
-- Создаётся при каждом открытии, где известен регион; без региона (в платформе нет активного) — не создаётся.
CREATE TABLE entry_contexts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  qr_point_id uuid,
  place_id uuid,
  -- Тип точки при ok; default — нейтральный контекст региона (точка неактивна, неизвестна, параметр мусорный).
  entry_type text NOT NULL CONSTRAINT entry_contexts_entry_type_check
    CHECK (entry_type IN ('hotel', 'place', 'region', 'campaign', 'default')),
  -- Источник входа — значение каталога ANALYTICS_SOURCES (@tg/shared).
  source text NOT NULL CONSTRAINT entry_contexts_source_format CHECK (source ~ '^[a-z][a-z_]{0,31}$'),
  qr_scan_event_id uuid REFERENCES qr_scan_events(id) ON DELETE SET NULL,
  -- Псевдонимные ПДн — как в qr_scan_events.
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  anonymous_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entry_contexts_point_fk FOREIGN KEY (region_id, qr_point_id)
    REFERENCES qr_points (region_id, id) ON DELETE SET NULL (qr_point_id),
  -- У нейтрального контекста точки нет (у остальных она может стать NULL после удаления точки).
  CONSTRAINT entry_contexts_default_without_point CHECK (entry_type <> 'default' OR qr_point_id IS NULL),
  CONSTRAINT entry_contexts_actor CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);

CREATE INDEX entry_contexts_region_idx ON entry_contexts (region_id, created_at);
CREATE INDEX entry_contexts_user_idx ON entry_contexts (user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX entry_contexts_anonymous_idx ON entry_contexts (anonymous_id) WHERE anonymous_id IS NOT NULL;
CREATE INDEX entry_contexts_point_idx ON entry_contexts (qr_point_id) WHERE qr_point_id IS NOT NULL;
CREATE INDEX entry_contexts_scan_idx ON entry_contexts (qr_scan_event_id) WHERE qr_scan_event_id IS NOT NULL;

SELECT app_enable_tenant_rls('entry_contexts');
-- Журнал входов: как qr_scan_events — только дописывается, меняются лишь псевдонимные ПДн (D-48).
REVOKE ALL ON entry_contexts FROM app;
GRANT SELECT, INSERT ON entry_contexts TO app;
GRANT UPDATE (user_id, anonymous_id) ON entry_contexts TO app;

-- tenant-optional (ADR-006, журнал): каждое касание атрибуции (D-29 — хранить все; ТЗ §6.1 «ambassador_id,
-- campaign_id, source, дата»). Правило закрепления (first-touch / last-touch 30 дней) применяется позже (блок 11)
-- поверх этого журнала, поэтому строки не перезаписываются и не схлопываются. ambassador_id появится с
-- амбассадорами (блок 11) отдельной миграцией. Регион — как у qr_scan_events.
CREATE TABLE attribution_touches (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid REFERENCES regions(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  anonymous_id uuid,
  -- Значение каталога ANALYTICS_SOURCES (@tg/shared): qr, ambassador_link, deep_link…
  source text NOT NULL CONSTRAINT attribution_touches_source_format CHECK (source ~ '^[a-z][a-z_]{0,31}$'),
  qr_point_id uuid,
  campaign text CONSTRAINT attribution_touches_campaign_format CHECK (campaign ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  qr_scan_event_id uuid REFERENCES qr_scan_events(id) ON DELETE SET NULL,
  entry_context_id uuid REFERENCES entry_contexts(id) ON DELETE SET NULL,
  touched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attribution_touches_point_fk FOREIGN KEY (region_id, qr_point_id)
    REFERENCES qr_points (region_id, id) ON DELETE SET NULL (qr_point_id),
  CONSTRAINT attribution_touches_actor CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);

CREATE INDEX attribution_touches_region_idx ON attribution_touches (region_id, touched_at);
CREATE INDEX attribution_touches_user_idx ON attribution_touches (user_id, touched_at) WHERE user_id IS NOT NULL;
CREATE INDEX attribution_touches_anonymous_idx ON attribution_touches (anonymous_id, touched_at)
  WHERE anonymous_id IS NOT NULL;
CREATE INDEX attribution_touches_point_idx ON attribution_touches (qr_point_id) WHERE qr_point_id IS NOT NULL;
CREATE INDEX attribution_touches_scan_idx ON attribution_touches (qr_scan_event_id) WHERE qr_scan_event_id IS NOT NULL;
CREATE INDEX attribution_touches_entry_idx ON attribution_touches (entry_context_id)
  WHERE entry_context_id IS NOT NULL;

SELECT app_enable_tenant_rls('attribution_touches');
-- Журнал только дописывается: app — без DELETE/TRUNCATE и без UPDATE строки; разрешена только замена
-- псевдонимных ПДн по запросу на удаление (D-48): CHECK *_actor требует user_id или anonymous_id — анонимизация
-- подставляет новый случайный anonymous_id вместо user_id. REVOKE — права могли прийти по ALTER DEFAULT PRIVILEGES (0003).
REVOKE ALL ON attribution_touches FROM app;
GRANT SELECT, INSERT ON attribution_touches TO app;
GRANT UPDATE (user_id, anonymous_id) ON attribution_touches TO app;

-- 0018: богатая картка місця (решение владельца 02.11.2026): данные Google Place Details (тип, описание, удобства,
-- ценовой уровень, настоящие рейтинг и отзывы, ссылки на фото с авторами), Вікіпедія для пам'яток и короткий
-- ИИ-текст. Пишет офлайн CLI places:enrich (README apps/api, «Обогащение мест»); турист только читает.
-- Фото Google к себе не копируются: в google хранится имя фото (places/…/photos/…), файл отдаёт Google по адресу,
-- который api получает через прокси GET /places/{id}/google-photos/{n} (кэш адресов — google_photo_uris).

-- tenant: обогащение места региона (1:1 с places). google и wiki — нормализованный JSON (форма — schema.ts,
-- PlaceEnrichmentGoogle / PlaceEnrichmentWiki), NULL — не собирались или данных нет. ai_summary_uk — 2–3 предложения
-- «что это и чем интересно», сгенерированы моделью ai_model только из google и wiki; в карточке — с пометкой
-- «згенеровано ШІ». ai_input_hash — хэш входных фактов: изменились факты — текст генерируется заново.
CREATE TABLE place_enrichments (
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  google jsonb CONSTRAINT place_enrichments_google_check CHECK (google IS NULL OR jsonb_typeof(google) = 'object'),
  google_fetched_at timestamptz,
  wiki jsonb CONSTRAINT place_enrichments_wiki_check CHECK (wiki IS NULL OR jsonb_typeof(wiki) = 'object'),
  wiki_fetched_at timestamptz,
  ai_summary_uk text CONSTRAINT place_enrichments_ai_summary_check
    CHECK (ai_summary_uk IS NULL OR char_length(btrim(ai_summary_uk)) BETWEEN 1 AND 700),
  ai_model text CONSTRAINT place_enrichments_ai_model_check CHECK (ai_model IS NULL OR char_length(ai_model) <= 100),
  ai_generated_at timestamptz,
  ai_input_hash text CONSTRAINT place_enrichments_ai_input_hash_check
    CHECK (ai_input_hash IS NULL OR ai_input_hash ~ '^[0-9a-f]{16,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_enrichments_pkey PRIMARY KEY (region_id, place_id),
  CONSTRAINT place_enrichments_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE,
  -- Текст ИИ — только вместе с моделью и датой (пометка в карточке).
  CONSTRAINT place_enrichments_ai_consistent CHECK (
    ai_summary_uk IS NULL OR (ai_model IS NOT NULL AND ai_generated_at IS NOT NULL)
  )
);

CREATE TRIGGER place_enrichments_set_updated_at BEFORE UPDATE ON place_enrichments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

SELECT app_enable_tenant_rls('place_enrichments');
REVOKE ALL ON place_enrichments FROM app;
GRANT SELECT, INSERT, UPDATE, DELETE ON place_enrichments TO app;

-- global: кэш адресов файлов фото Google (photoUri из Place Photos …/media?skipHttpRedirect=true) по имени фото и
-- ширине — повторные просмотры не стоят запросов к Google. Не данные региона: имя фото Google глобально; ключ API
-- в адресе не содержится. Устаревшие строки (fetched_at старше TTL api) перезапрашиваются.
CREATE TABLE google_photo_uris (
  photo_name text NOT NULL CONSTRAINT google_photo_uris_name_format
    CHECK (photo_name ~ '^places/[A-Za-z0-9_-]{1,255}/photos/[A-Za-z0-9_-]{1,1024}$'),
  max_width integer NOT NULL CONSTRAINT google_photo_uris_width_check CHECK (max_width BETWEEN 100 AND 4800),
  photo_uri text NOT NULL CONSTRAINT google_photo_uris_uri_check
    CHECK (photo_uri ~ '^https://' AND char_length(photo_uri) <= 2048),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_photo_uris_pkey PRIMARY KEY (photo_name, max_width)
);

REVOKE ALL ON google_photo_uris FROM app;
GRANT SELECT, INSERT, UPDATE, DELETE ON google_photo_uris TO app;

-- global: суточный счётчик платных запросов к Google из api (страховка бюджета GOOGLE_PHOTO_DAILY_LIMIT). В БД, а не в
-- памяти: Render засыпает и перезапускает процесс — счётчик в памяти обнулялся бы. Увеличивается атомарно
-- (INSERT … ON CONFLICT DO UPDATE … WHERE count < предел RETURNING count): нет строки в ответе — предел исчерпан.
CREATE TABLE google_api_usage (
  day date NOT NULL,
  kind text NOT NULL CONSTRAINT google_api_usage_kind_check CHECK (kind ~ '^[a-z_]{1,40}$'),
  count integer NOT NULL DEFAULT 0 CONSTRAINT google_api_usage_count_check CHECK (count >= 0),
  CONSTRAINT google_api_usage_pkey PRIMARY KEY (day, kind)
);

REVOKE ALL ON google_api_usage FROM app;
GRANT SELECT, INSERT, UPDATE, DELETE ON google_api_usage TO app;

-- tenant: обложка места у нас (решение владельца 03.11.2026, тестовый режим): одно фото ~400 px WebP — карточка и
-- списки без запросов к Google при каждом просмотре. Источник — Google Place Photos (одно фото на место, в месячном
-- пределе) или Wikimedia Commons (пам'ятки, бесплатно). authors — подпись автора (обязательна), license — у Commons.
-- Пишет CLI places:enrich --covers; api отдаёт GET /places/{id}/cover (ETag).
CREATE TABLE place_cover_photos (
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  place_id uuid NOT NULL,
  bytes bytea NOT NULL CONSTRAINT place_cover_photos_bytes_check CHECK (octet_length(bytes) BETWEEN 1 AND 1048576),
  mime text NOT NULL CONSTRAINT place_cover_photos_mime_check CHECK (mime IN ('image/webp', 'image/jpeg')),
  width integer NOT NULL CONSTRAINT place_cover_photos_width_check CHECK (width BETWEEN 1 AND 4000),
  height integer NOT NULL CONSTRAINT place_cover_photos_height_check CHECK (height BETWEEN 1 AND 4000),
  author_attributions jsonb NOT NULL DEFAULT '[]'
    CONSTRAINT place_cover_photos_authors_check CHECK (jsonb_typeof(author_attributions) = 'array'),
  license text CONSTRAINT place_cover_photos_license_check CHECK (license IS NULL OR char_length(license) <= 100),
  source_url text CONSTRAINT place_cover_photos_source_url_check
    CHECK (source_url IS NULL OR (source_url ~ '^https://' AND char_length(source_url) <= 2048)),
  source text NOT NULL CONSTRAINT place_cover_photos_source_check CHECK (source IN ('google', 'wikimedia')),
  photo_name text NOT NULL CONSTRAINT place_cover_photos_photo_name_check CHECK (char_length(photo_name) BETWEEN 1 AND 2048),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_cover_photos_pkey PRIMARY KEY (region_id, place_id),
  CONSTRAINT place_cover_photos_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE
);

SELECT app_enable_tenant_rls('place_cover_photos');
REVOKE ALL ON place_cover_photos FROM app;
GRANT SELECT, INSERT, UPDATE, DELETE ON place_cover_photos TO app;

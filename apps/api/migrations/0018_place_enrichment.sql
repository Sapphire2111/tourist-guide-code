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

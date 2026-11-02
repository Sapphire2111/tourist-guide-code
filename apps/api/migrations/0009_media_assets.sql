-- 0009: файлы и изображения (T1-20; ADR-0013). README apps/api, «Файлы и изображения».
-- Сами файлы — в объектном хранилище (драйвер s3 или local, пакет @tg/media); здесь — учёт: владелец, вид, статус
-- проверки и обработки, ключи объектов. Правила (типы, лимит, ширины вариантов) — packages/media/src/constants.ts,
-- значения продублированы в CHECK.
--
-- Жизненный цикл: pending (выдана подписанная ссылка на загрузку) → uploaded (размер и сигнатура проверены) →
-- processing (ресайз) → ready; private_document — сразу ready после проверки. Не тот тип или размер, нераспознаваемое
-- изображение → rejected (объект удаляется). Оригинал фото удаляется после ready: наружу — только варианты без EXIF.

-- tenant (ADR-005): файл принадлежит региону владельца; регион-админ видит только свой регион.
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  -- Владелец: тип сущности и id. Таблиц places/organizations ещё нет (блок 3) — owner_id без FK; region — сам регион.
  owner_type text NOT NULL CONSTRAINT media_assets_owner_type_check
    CHECK (owner_type IN ('place', 'organization', 'region')),
  owner_id uuid NOT NULL,
  kind text NOT NULL CONSTRAINT media_assets_kind_check CHECK (kind IN ('image', 'private_document')),
  status text NOT NULL DEFAULT 'pending' CONSTRAINT media_assets_status_check
    CHECK (status IN ('pending', 'uploaded', 'processing', 'ready', 'rejected')),
  -- Заявленный тип; при подтверждении сверяется с сигнатурой файла. Фото — только jpeg/png/webp, документ — ещё pdf.
  mime text NOT NULL CONSTRAINT media_assets_mime_check
    CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  -- Заявленный размер, байт (лимит 10 МиБ); при подтверждении сверяется с фактическим.
  size_bytes integer NOT NULL CONSTRAINT media_assets_size_check CHECK (size_bytes BETWEEN 1 AND 10485760),
  -- Ключ объекта в хранилище: до подтверждения — куда клиент кладёт файл (private/…/upload), после — проверенная
  -- копия (private/…/original), её не заменит повторный PUT. После ready у фото объекта уже нет.
  original_key text NOT NULL CONSTRAINT media_assets_original_key_length CHECK (char_length(original_key) <= 512),
  -- Альтернативный текст (доступность, ТЗ §13 Контент): мультиязычный, uk обязателен.
  alt_i18n jsonb CONSTRAINT media_assets_alt_i18n_check CHECK (alt_i18n IS NULL OR is_localized_text(alt_i18n)),
  -- Размер исходного изображения после поворота по EXIF, px (заполняется при обработке).
  width integer CONSTRAINT media_assets_width_check CHECK (width > 0),
  height integer CONSTRAINT media_assets_height_check CHECK (height > 0),
  -- Варианты: {"w320": {"key": "public/…/w320.webp", "width": 320, "height": 213, "bytes": 12345}, …}.
  variants jsonb NOT NULL DEFAULT '{}' CONSTRAINT media_assets_variants_object CHECK (jsonb_typeof(variants) = 'object'),
  reject_reason text CONSTRAINT media_assets_reject_reason_check
    CHECK (reject_reason IN ('size_mismatch', 'type_mismatch', 'decode_failed', 'dimensions_too_large',
      'original_missing')),
  -- Кто создал загрузку; NULL — SYSTEM (seed, миграция данных).
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  -- Когда файл подтверждён (uploaded).
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_assets_pdf_only_document CHECK (kind = 'private_document' OR mime <> 'application/pdf'),
  CONSTRAINT media_assets_region_owner CHECK (owner_type <> 'region' OR owner_id = region_id),
  CONSTRAINT media_assets_reject_consistent CHECK ((status = 'rejected') = (reject_reason IS NOT NULL))
);

CREATE TRIGGER media_assets_set_updated_at BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Файлы региона (фильтр TenantGuardPlugin) и FK на regions.
CREATE INDEX media_assets_region_idx ON media_assets (region_id, created_at);
-- Фото сущности (галерея карточки места).
CREATE INDEX media_assets_owner_idx ON media_assets (owner_type, owner_id) WHERE status <> 'rejected';
-- FK на users.
CREATE INDEX media_assets_created_by_idx ON media_assets (created_by) WHERE created_by IS NOT NULL;

SELECT app_enable_tenant_rls('media_assets');

-- ALTER DEFAULT PRIVILEGES (0003) действует, только если миграции выполняет та же роль-владелец, — права явно.
GRANT SELECT, INSERT, UPDATE, DELETE ON media_assets TO app;

-- Функции для worker (ресайз, T1-20): как analytics_record_event (0007) — worker не пишет запросы к таблицам,
-- функция на время запроса выставляет app.actor = 'system' (RLS) и восстанавливает прежнее значение.

-- Взять фото в обработку: uploaded/processing → processing (повтор задачи после сбоя — снова processing).
-- Возвращает текущее состояние строки (в т. ч. если взять нельзя: pending — подтверждение ещё не закоммичено,
-- ready/rejected — уже обработано); нет строки — пустой результат.
CREATE FUNCTION media_asset_claim_processing(p_id uuid)
RETURNS TABLE (status text, kind text, region_id uuid, original_key text, mime text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  RETURN QUERY
    WITH claimed AS (
      UPDATE public.media_assets m SET status = 'processing'
      WHERE m.id = p_id AND m.kind = 'image' AND m.status IN ('uploaded', 'processing')
      RETURNING m.status, m.kind, m.region_id, m.original_key, m.mime
    )
    SELECT c.status, c.kind, c.region_id, c.original_key, c.mime FROM claimed c
    UNION ALL
    SELECT m.status, m.kind, m.region_id, m.original_key, m.mime FROM public.media_assets m
    WHERE m.id = p_id AND NOT EXISTS (SELECT 1 FROM claimed);
  PERFORM set_config('app.actor', prev_actor, true);
END
$$;

-- Обработка завершена: processing → ready с вариантами. false — строка не в processing (повтор, уже готово).
CREATE FUNCTION media_asset_complete_processing(p_id uuid, p_width integer, p_height integer, p_variants jsonb)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  updated integer;
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  UPDATE public.media_assets
  SET status = 'ready', width = p_width, height = p_height, variants = p_variants
  WHERE id = p_id AND status = 'processing';
  GET DIAGNOSTICS updated = ROW_COUNT;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN updated > 0;
END
$$;

-- Отклонить (изображение не декодируется, не тот формат, слишком большое, нет оригинала): не финальный статус →
-- rejected. false — уже ready/rejected.
CREATE FUNCTION media_asset_reject(p_id uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  updated integer;
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  UPDATE public.media_assets SET status = 'rejected', reject_reason = p_reason
  WHERE id = p_id AND status IN ('pending', 'uploaded', 'processing');
  GET DIAGNOSTICS updated = ROW_COUNT;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN updated > 0;
END
$$;

REVOKE EXECUTE ON FUNCTION media_asset_claim_processing(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION media_asset_complete_processing(uuid, integer, integer, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION media_asset_reject(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_asset_claim_processing(uuid) TO app;
GRANT EXECUTE ON FUNCTION media_asset_complete_processing(uuid, integer, integer, jsonb) TO app;
GRANT EXECUTE ON FUNCTION media_asset_reject(uuid, text) TO app;

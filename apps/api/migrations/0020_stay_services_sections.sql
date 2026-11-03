-- 0020: разделы главной «Де жити» (stay) и «Сервіси» (services); категория, поставленная импортом мест.
-- «Де жити» отдельно от «Про заклад» (about — карточка заведения по QR, C-13): корневая категория stay раньше висела
-- на about и плитки на главной не имела. «Сервіси» — ремонт техники, связь, автомойки, почта, прачечные,
-- парикмахерские: корень создаёт seed или импорт мест.
ALTER TABLE categories DROP CONSTRAINT categories_home_section_check;
ALTER TABLE categories ADD CONSTRAINT categories_home_section_check
  CHECK (home_section IN ('about', 'stay', 'eat', 'shop', 'relax', 'fun', 'nearby', 'transfer', 'services', 'help'));

-- import_category_id — категория, которую последний раз поставил импорт Google. Совпадает с category_id — админка
-- категорию не меняла, и повторный импорт может переразметить место (новые правила); не совпадает — правка админки
-- главнее. NULL — у мест админки/seed и у мест импорта, которых касался пользователь до 0020 (см. заполнение ниже).
ALTER TABLE places
  ADD COLUMN import_category_id uuid,
  ADD CONSTRAINT places_import_category_fk FOREIGN KEY (region_id, import_category_id)
    REFERENCES categories (region_id, id) ON DELETE SET NULL (import_category_id);

SELECT set_config('app.actor', 'system', true);
UPDATE categories SET home_section = 'stay' WHERE code = 'stay' AND parent_id IS NULL AND home_section = 'about';
-- Название раздела — «Де жити» (просьба владельца 03.11.2026), если админка его не меняла.
UPDATE categories SET name_i18n = jsonb_set(name_i18n, '{uk}', '"Де жити"')
  WHERE code = 'stay' AND parent_id IS NULL AND name_i18n ->> 'uk' = 'Де зупинитися';
-- Места импорта, которых не касался ни один пользователь (в журнале аудита нет действий пользователя над местом):
-- категория — от импорта.
UPDATE places p SET import_category_id = p.category_id
  WHERE p.source = 'google'
    AND NOT EXISTS (
      SELECT 1 FROM audit_logs a
      WHERE a.entity_type = 'place' AND a.entity_id = p.id::text AND a.actor_type = 'user'
    );

-- Разделы главной C02: «Де зупинитися» (stay) отдельно от «Про заклад» (about — карточка заведения по QR, C-13);
-- корневая категория stay раньше висела на about и плитки на главной не имела.
ALTER TABLE categories DROP CONSTRAINT categories_home_section_check;
ALTER TABLE categories ADD CONSTRAINT categories_home_section_check
  CHECK (home_section IN ('about', 'stay', 'eat', 'shop', 'relax', 'fun', 'nearby', 'transfer', 'help'));

SELECT set_config('app.actor', 'system', true);
UPDATE categories SET home_section = 'stay' WHERE code = 'stay' AND parent_id IS NULL AND home_section = 'about';
-- Название раздела — «Де жити» (просьба владельца 03.11.2026), если админка его не меняла.
UPDATE categories SET name_i18n = jsonb_set(name_i18n, '{uk}', '"Де жити"')
  WHERE code = 'stay' AND parent_id IS NULL AND name_i18n ->> 'uk' = 'Де зупинитися';

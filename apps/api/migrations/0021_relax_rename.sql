SELECT set_config('app.actor', 'system', true);
-- Раздел «Де відпочити» → «Релакс» (просьба владельца 03.11.2026), если админка его не меняла.
UPDATE categories SET name_i18n = name_i18n || '{"uk": "Релакс", "en": "Relax"}'::jsonb
  WHERE code = 'relax' AND parent_id IS NULL AND name_i18n ->> 'uk' = 'Де відпочити';

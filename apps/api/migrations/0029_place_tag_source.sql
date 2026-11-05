-- 0029: источник тега места (решение владельца 05.11.2026: фильтр удобств «Де жити»). manual — админка и сид (как
-- раньше, по умолчанию), import — структурированные удобства Google (places:import-google, places:amenities),
-- reviews — удобство подтверждено отзывами/описанием Google (places:amenities, ИИ-извлечение с цитатой в аудите;
-- в карточке — с пометкой «за відгуками Google»). Правка тегов в админке пересоздаёт связи с manual.
ALTER TABLE place_tags
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CONSTRAINT place_tags_source_check
    CHECK (source IN ('manual', 'import', 'reviews'));

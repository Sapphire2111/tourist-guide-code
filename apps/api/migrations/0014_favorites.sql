-- 0014: избранное туриста (блок 4, C05/C06; ADR-0019). README apps/api, «Публичный каталог туриста».
-- Поиск и «Що поруч» новых индексов не требуют: places_location_geog_idx (gist по location::geography) и
-- places_region_status_category_idx из 0012. Поиск по тексту — ILIKE (pg_trgm — при росте каталога, ADR-0019).

-- tenant (ADR-005): место в избранном пользователя. Регион — регион места: составной FK не даёт сослаться на место
-- другого региона; RLS ограничивает чтение регионом контекста, api — ещё и пользователем сессии.
-- Пользователь: CASCADE — запись не нужна без человека (физически пользователи удаляются только анонимизацией, D-48);
-- место: CASCADE — удаляется только ни разу не публиковавшийся черновик.
CREATE TABLE favorites (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT favorites_user_place_key UNIQUE (user_id, place_id),
  CONSTRAINT favorites_place_fk FOREIGN KEY (region_id, place_id)
    REFERENCES places (region_id, id) ON DELETE CASCADE
);

-- Список пользователя в регионе, новые сверху; FK на место.
CREATE INDEX favorites_user_region_idx ON favorites (region_id, user_id, created_at DESC);
CREATE INDEX favorites_place_idx ON favorites (region_id, place_id);

SELECT app_enable_tenant_rls('favorites');
-- Изменений нет: только добавить и убрать (ALTER DEFAULT PRIVILEGES из 0003 мог выдать лишнее).
REVOKE ALL ON favorites FROM app;
GRANT SELECT, INSERT, DELETE ON favorites TO app;

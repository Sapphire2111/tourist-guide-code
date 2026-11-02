-- 0019: параметры поездки в «Мій план» (C09; просьба владельца 02.11.2026: сколько взрослых и детей, с машиной или
-- без, сколько дней) и базовая точка плана (где живёт турист — от неё считается «пішки / потрібен транспорт»).
-- Варианты на выбор api подбирает из каталога региона по этим параметрам (plan-options.ts), в БД не хранятся;
-- выбранные пункты — в items, как и раньше (у пункта появляется необязательный slot: morning/afternoon/evening/rain).
-- days NULL — у старых планов: число дней берётся из пунктов (максимальный день). Права — table-level GRANT 0015.
ALTER TABLE user_plans
  ADD COLUMN adults smallint NOT NULL DEFAULT 2 CONSTRAINT user_plans_adults_check CHECK (adults BETWEEN 1 AND 20),
  ADD COLUMN children smallint NOT NULL DEFAULT 0
    CONSTRAINT user_plans_children_check CHECK (children BETWEEN 0 AND 20),
  ADD COLUMN with_car boolean NOT NULL DEFAULT true,
  ADD COLUMN days smallint CONSTRAINT user_plans_days_check CHECK (days BETWEEN 1 AND 14),
  ADD COLUMN base_place_id uuid,
  ADD CONSTRAINT user_plans_base_place_fk FOREIGN KEY (region_id, base_place_id)
    REFERENCES places (region_id, id) ON DELETE SET NULL (base_place_id);

CREATE INDEX user_plans_base_place_idx ON user_plans (region_id, base_place_id) WHERE base_place_id IS NOT NULL;

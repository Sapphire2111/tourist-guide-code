-- 0027: интересы туриста в «Мій план» (живой план через Claude, флаг planner.ai; решение владельца 04.11.2026):
-- водоспади, культура, гастро… — теги сценариев (ScenarioTag в OpenAPI), до 6. «Інший варіант» берёт их из плана.
-- Пустой массив — без интересов (как у всех прежних планов). Права — table-level GRANT 0015.
ALTER TABLE user_plans
  ADD COLUMN interests text[] NOT NULL DEFAULT '{}' CONSTRAINT user_plans_interests_check
    CHECK (cardinality(interests) <= 6);

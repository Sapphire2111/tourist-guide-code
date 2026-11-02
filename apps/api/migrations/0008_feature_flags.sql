-- 0008: фича-флаги (T1-22; ADR-0011). README apps/api, «Фича-флаги».
-- Каталог флагов и значения по умолчанию для окружения (local/staging/prod) — в коде
-- (apps/api/src/modules/feature-flags/catalog.ts): здесь только переопределения, сделанные админом платформы, и
-- отметки о закрытии ⚖-решений финансового гейта (D-81). Нет строки — действует значение по умолчанию окружения.
-- Каждое изменение — запись в audit_logs (feature_flag.set / feature_flag.gate_mark) в той же транзакции.

-- global: настройка платформы, а не данные региона (ADR-006 — у global-таблиц нет region_id). Переопределение
-- действует на всё окружение (target_region_id NULL) или на один регион (target_region_id — цель, не
-- tenant-колонка). Меняет только PLATFORM-право feature_flag.manage; читают все (эффективные значения — публичный
-- эндпоинт для UI), поэтому RLS нет. Ключ — код из каталога; ключ не из каталога приложение игнорирует.
CREATE TABLE feature_flags (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  key text NOT NULL CONSTRAINT feature_flags_key_format CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    AND char_length(key) <= 100),
  target_region_id uuid REFERENCES regions(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL,
  -- Кто изменил последним; NULL — SYSTEM. История изменений — в audit_logs.
  updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER feature_flags_set_updated_at BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Одно переопределение на (флаг, регион); NULLS NOT DISTINCT — одно на окружение (target_region_id NULL).
CREATE UNIQUE INDEX feature_flags_key_target_key ON feature_flags (key, target_region_id) NULLS NOT DISTINCT;
-- FK на regions.
CREATE INDEX feature_flags_target_region_idx ON feature_flags (target_region_id)
  WHERE target_region_id IS NOT NULL;

-- global: отметка «⚖-решение закрыто» перед включением finance.live в prod (D-81, рекомендация (а): письменное
-- заключение юриста и бухгалтера + решение PO в decisions.md). Одна отметка на решение, неизменяема: снять отметку
-- нельзя (ошибочная отметка — новая миграция данных с записью в аудит). document_ref — ссылка на заключение/решение.
CREATE TABLE feature_flag_gate_marks (
  decision text PRIMARY KEY CONSTRAINT feature_flag_gate_marks_decision_format CHECK (decision ~ '^D-[0-9]{2,3}$'),
  document_ref text NOT NULL CONSTRAINT feature_flag_gate_marks_document_ref_length
    CHECK (char_length(btrim(document_ref)) BETWEEN 1 AND 1000),
  marked_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  marked_at timestamptz NOT NULL DEFAULT now()
);

-- ALTER DEFAULT PRIVILEGES (0003) действует, только если миграции выполняет та же роль-владелец, — права явно,
-- как в 0004/0005. DELETE flags — сброс переопределения к значению по умолчанию; отметки — только добавление.
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_flags TO app;
REVOKE UPDATE, DELETE, TRUNCATE ON feature_flag_gate_marks FROM app;
GRANT SELECT, INSERT ON feature_flag_gate_marks TO app;

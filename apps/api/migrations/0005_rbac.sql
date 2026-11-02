-- 0005: каркас RBAC — назначения ролей (T1-12; roles-and-data §1.2, §2.13; ADR-005). README apps/api, «RBAC».
-- Роли и permission-коды — в коде (apps/api/src/modules/rbac): здесь только назначения «пользователь — роль —
-- область». Иерархия областей PLATFORM ⊃ REGION ⊃ ORGANIZATION ⊃ PLACE ⊃ RESOURCE вычисляется в приложении;
-- таблиц organizations/places ещё нет (блок 3), поэтому scope_id без FK, кроме REGION (через region_id).

-- tenant-optional (roles-and-data §2.13 «RoleAssignment (кроме PLATFORM)»): назначение на PLATFORM — region_id
-- NULL, его видят только SYSTEM/PLATFORM; остальные — region_id области (денормализован, roles-and-data §1.2):
-- регион-админ видит назначения только своего региона.
-- Назначение не удаляется и не меняется: только отзыв (revoked_*), один раз — триггер ниже. Продление или смена
-- роли — отзыв и новое назначение, каждое — запись в audit_logs (role.assign / role.revoke).
-- status suspended (roles-and-data §1.2) — при появлении сценария приостановки (блок 3).
CREATE TABLE role_assignments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  -- RESTRICT: пользователи физически не удаляются (анонимизация).
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Код роли из реестра в коде; text + формат, а не перечень: бизнес-роли (блоки 3 и 6) — без миграции.
  role text NOT NULL CONSTRAINT role_assignments_role_format CHECK (role ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  scope_type text NOT NULL CONSTRAINT role_assignments_scope_type_check
    CHECK (scope_type IN ('PLATFORM', 'REGION', 'ORGANIZATION', 'PLACE', 'RESOURCE')),
  -- PLATFORM — NULL; REGION — id региона; ORGANIZATION/PLACE/RESOURCE — id объекта (FK — с таблицами блока 3).
  scope_id uuid,
  region_id uuid REFERENCES regions(id) ON DELETE RESTRICT,
  -- Кто назначил/отозвал; NULL — SYSTEM (seed, миграция данных).
  granted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  -- Срок действия (необязателен): после него назначение не даёт прав.
  valid_until timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  revoke_reason text CONSTRAINT role_assignments_revoke_reason_length CHECK (char_length(revoke_reason) <= 1000),
  -- coalesce: CHECK пропускает NULL, а сравнение с NULL-колонкой даёт NULL.
  CONSTRAINT role_assignments_scope_consistent CHECK (coalesce(
    CASE scope_type
      WHEN 'PLATFORM' THEN scope_id IS NULL AND region_id IS NULL
      WHEN 'REGION' THEN region_id = scope_id
      ELSE scope_id IS NOT NULL AND region_id IS NOT NULL
    END, false)),
  CONSTRAINT role_assignments_valid_until_after_grant CHECK (valid_until IS NULL OR valid_until > granted_at),
  CONSTRAINT role_assignments_revoke_consistent
    CHECK (revoked_at IS NOT NULL OR (revoked_by IS NULL AND revoke_reason IS NULL))
);

-- Уникальность действующей пары (user, role, scope) (roles-and-data §2.2, RoleAssignment); NULLS NOT DISTINCT —
-- для PLATFORM (scope_id NULL). Ведущая колонка user_id — заодно загрузка назначений пользователя.
CREATE UNIQUE INDEX role_assignments_active_key ON role_assignments (user_id, role, scope_type, scope_id)
  NULLS NOT DISTINCT WHERE revoked_at IS NULL;
-- Кто имеет роли на объекте (список сотрудников организации/заведения — блок 3).
CREATE INDEX role_assignments_scope_idx ON role_assignments (scope_type, scope_id) WHERE revoked_at IS NULL;
-- Назначения региона (фильтр TenantGuardPlugin) и FK на regions.
CREATE INDEX role_assignments_region_idx ON role_assignments (region_id);

-- Меняется только отзыв, один раз: остальные колонки неизменяемы, отозванное назначение не меняется.
CREATE FUNCTION role_assignments_check_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'role_assignments: назначение % уже отозвано', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS NULL
    OR (NEW.id, NEW.user_id, NEW.role, NEW.scope_type, NEW.scope_id, NEW.region_id, NEW.granted_by,
        NEW.granted_at, NEW.valid_until)
      IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.role, OLD.scope_type, OLD.scope_id, OLD.region_id,
        OLD.granted_by, OLD.granted_at, OLD.valid_until) THEN
    RAISE EXCEPTION 'role_assignments: изменить можно только отзыв (revoked_at, revoked_by, revoke_reason)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER role_assignments_check_update BEFORE UPDATE ON role_assignments
  FOR EACH ROW EXECUTE FUNCTION role_assignments_check_update();

SELECT app_enable_tenant_rls('role_assignments');

-- ALTER DEFAULT PRIVILEGES (0003) действует, только если миграции выполняет та же роль-владелец, — права явно, как
-- для audit_log_pii (0004); история назначений не удаляется.
REVOKE DELETE, TRUNCATE ON role_assignments FROM app;
GRANT SELECT, INSERT, UPDATE ON role_assignments TO app;

-- Действующие назначения пользователя во всех регионах — для проверки прав и выбора tenant-контекста запроса
-- (RBAC, apps/api/src/modules/rbac). Вызывается из любого контекста, в том числе внутри транзакции региона: на
-- время чтения выставляет app.actor = 'system' (RLS) и восстанавливает прежнее значение, как
-- audit_purge_expired_pii() (0004). Отдаёт только назначения указанного пользователя.
CREATE FUNCTION app_active_role_assignments(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  role text,
  scope_type text,
  scope_id uuid,
  region_id uuid,
  granted_at timestamptz,
  valid_until timestamptz
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
BEGIN
  PERFORM set_config('app.actor', 'system', true);
  RETURN QUERY
    SELECT ra.id, ra.role, ra.scope_type, ra.scope_id, ra.region_id, ra.granted_at, ra.valid_until
    FROM public.role_assignments ra
    WHERE ra.user_id = p_user_id
      AND ra.revoked_at IS NULL
      AND (ra.valid_until IS NULL OR ra.valid_until > now())
    ORDER BY ra.id;
  PERFORM set_config('app.actor', prev_actor, true);
END
$$;

REVOKE EXECUTE ON FUNCTION app_active_role_assignments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_active_role_assignments(uuid) TO app;

-- Назначение, по которому действовал актор (roles-and-data §1.2, шаг 9: «кто — user + назначение»; 0002, T1-12).
-- Только для актора-пользователя. Добавление колонки — DDL: триггер append-only (0004) его не касается.
ALTER TABLE audit_logs
  ADD COLUMN role_assignment_id uuid REFERENCES role_assignments(id) ON DELETE RESTRICT,
  ADD CONSTRAINT audit_logs_role_assignment_user CHECK (role_assignment_id IS NULL OR actor_type = 'user');

CREATE INDEX audit_logs_role_assignment_idx ON audit_logs (role_assignment_id) WHERE role_assignment_id IS NOT NULL;

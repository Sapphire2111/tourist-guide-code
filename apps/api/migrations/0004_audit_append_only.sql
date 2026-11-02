-- 0004: журнал действий только на добавление и ПДн-часть аудита с удаляемым сроком хранения (T1-13; ТЗ §12.1,
-- roles-and-data §2.12, D-73). README apps/api, «Аудит».
--
-- Неизменяемость audit_logs — в два слоя:
--   права   — у группы app на audit_logs только SELECT, INSERT (UPDATE/DELETE отозваны, TRUNCATE не выдавался);
--   триггер — UPDATE/DELETE/TRUNCATE отклоняются и для владельца схемы (ручная правка, ошибочная миграция).
-- Суперпользователь может отключить триггер — это доступ уровня DBA, вне модели угроз приложения.
--
-- ПДн аудита (IP, user agent, session id) — в audit_log_pii: строка удаляется по expires_at (по умолчанию 90 дней,
-- задаёт приложение — AUDIT_PII_RETENTION_DAYS в apps/api/src/modules/audit), запись действия при этом остаётся.
-- Срок 90 дней — рекомендация D-73 в тестовом режиме проекта; юридическая проверка срока отложена.

REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app;

-- Запрет изменения журнала. Statement-level: срабатывает и на UPDATE/DELETE без подходящих строк.
CREATE FUNCTION audit_logs_reject_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs: журнал только на добавление, % запрещён', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_change();

-- Лента админа (GET /admin/audit-logs): фильтр региона + порядок и курсор по id.
CREATE INDEX audit_logs_region_id_idx ON audit_logs (region_id, id);

-- tenant-optional (ADR-006): region_id — копия audit_logs.region_id (совпадение проверяет триггер ниже), чтобы
-- изоляция работала по общей схеме: TenantGuardPlugin по колонке region_id и RLS app_enable_tenant_rls().
-- ПДн-часть записи аудита (1:1). Строки не меняются (у app нет UPDATE), удаляются по сроку
-- audit_purge_expired_pii(); удаление записи действия невозможно, поэтому FK — RESTRICT.
CREATE TABLE audit_log_pii (
  audit_log_id uuid PRIMARY KEY REFERENCES audit_logs(id) ON DELETE RESTRICT,
  region_id uuid REFERENCES regions(id) ON DELETE RESTRICT,
  ip inet,
  user_agent text CONSTRAINT audit_log_pii_user_agent_length CHECK (char_length(user_agent) <= 1024),
  session_id text CONSTRAINT audit_log_pii_session_id_length CHECK (char_length(session_id) <= 255),
  -- Момент, после которого строка удаляется.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_pii_not_empty CHECK (ip IS NOT NULL OR user_agent IS NOT NULL OR session_id IS NOT NULL)
);

-- Очистка по сроку и индекс на FK региона.
CREATE INDEX audit_log_pii_expires_at_idx ON audit_log_pii (expires_at);
CREATE INDEX audit_log_pii_region_idx ON audit_log_pii (region_id);

-- region_id ПДн-строки = region_id записи действия. Запрос к audit_logs идёт под ролью вызывающего (RLS):
-- запись действия чужого региона не видна — так же ошибка.
CREATE FUNCTION audit_log_pii_check_region() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_region uuid;
BEGIN
  SELECT region_id INTO parent_region FROM public.audit_logs WHERE id = NEW.audit_log_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_log_pii: запись аудита % не найдена', NEW.audit_log_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.region_id IS DISTINCT FROM parent_region THEN
    RAISE EXCEPTION 'audit_log_pii: region_id не совпадает с записью аудита %', NEW.audit_log_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_log_pii_check_region BEFORE INSERT ON audit_log_pii
  FOR EACH ROW EXECUTE FUNCTION audit_log_pii_check_region();

SELECT app_enable_tenant_rls('audit_log_pii');

-- Права выданы ALTER DEFAULT PRIVILEGES (0003); UPDATE ПДн-строке не нужен.
REVOKE UPDATE, TRUNCATE ON audit_log_pii FROM app;
GRANT SELECT, INSERT, DELETE ON audit_log_pii TO app;

-- Удаление истёкших ПДн аудита (кросс-tenant, вызывает задача воркера audit.purge-expired-pii). За вызов — не
-- больше max_rows строк (короткие транзакции; задача повторяет вызов, пока удаляется полная пачка); возвращает
-- число удалённых. На время DELETE выставляет app.actor = 'system' (RLS) и восстанавливает прежнее значение:
-- функция удаляет только истёкшие строки, поэтому вызов из любого контекста безопасен. Не SET-атрибут функции:
-- SET пользовательской переменной в CREATE FUNCTION под не-суперпользователем (Neon) запрещён.
CREATE FUNCTION audit_purge_expired_pii(max_rows integer DEFAULT 10000) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  prev_actor text := coalesce(current_setting('app.actor', true), '');
  deleted integer;
BEGIN
  IF max_rows IS NULL OR max_rows < 1 THEN
    RAISE EXCEPTION 'audit_purge_expired_pii: max_rows должен быть > 0' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('app.actor', 'system', true);
  DELETE FROM public.audit_log_pii
  WHERE audit_log_id IN (
    SELECT audit_log_id FROM public.audit_log_pii WHERE expires_at <= now() ORDER BY expires_at LIMIT max_rows
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('app.actor', prev_actor, true);
  RETURN deleted;
END
$$;

REVOKE EXECUTE ON FUNCTION audit_purge_expired_pii(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_purge_expired_pii(integer) TO app;

-- 감사 보호 ------------------------------------------------------------------
-- 감사 객체는 alm_audit_owner가 소유해 업무 테이블 소유자(파이프라인)도 지우거나 바꾸지 못하게 한다.
ALTER TABLE audit_log OWNER TO alm_audit_owner;
ALTER FUNCTION audit_row() OWNER TO alm_audit_owner;
-- 감사 트리거를 끄거나 지우는 DDL은 거부한다(이벤트 트리거는 rds_superuser가 만들고 소유).
CREATE FUNCTION guard_audit_ddl() RETURNS event_trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  r record;
BEGIN
  IF TG_EVENT = 'sql_drop' THEN
    FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
      IF (r.object_type = 'trigger' AND r.object_identity LIKE 'tr\_%\_audit on %')
         OR (r.object_type IN ('table', 'function') AND r.object_identity IN ('public.audit_log', 'public.audit_row()')) THEN
        RAISE EXCEPTION 'audit: dropping % is not allowed', r.object_identity;
      END IF;
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'tr\_%\_audit' AND tgenabled <> 'O') THEN
    RAISE EXCEPTION 'audit: audit triggers must stay enabled';
  END IF;
END $$;
CREATE EVENT TRIGGER et_guard_audit_ddl ON ddl_command_end EXECUTE FUNCTION guard_audit_ddl();
CREATE EVENT TRIGGER et_guard_audit_drop ON sql_drop EXECUTE FUNCTION guard_audit_ddl();

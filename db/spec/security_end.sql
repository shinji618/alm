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
         OR (r.object_type IN ('table', 'function') AND r.object_identity IN ('public.audit_log', 'public.security_event', 'public.audit_row()')) THEN
        RAISE EXCEPTION 'audit: dropping % is not allowed', r.object_identity;
      END IF;
    END LOOP;
  ELSIF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'tr\_%\_audit' AND tgenabled <> 'O') THEN
    RAISE EXCEPTION 'audit: audit triggers must stay enabled';
  END IF;
END $$;
CREATE EVENT TRIGGER et_guard_audit_ddl ON ddl_command_end EXECUTE FUNCTION guard_audit_ddl();
CREATE EVENT TRIGGER et_guard_audit_drop ON sql_drop EXECUTE FUNCTION guard_audit_ddl();

-- 감사 기록 월 파티션(09 8.3) -------------------------------------------------------
-- audit_log·security_event는 occurred_at 월 단위 범위 파티션이다(이름 <표>_pYYYYMM, [월초, 다음 월초) UTC).
-- 둘 다 alm_audit_owner가 소유한다: 파이프라인(소유자) 계정은 감사 기록을 지우거나 파티션을 떼어 낼 수 없다.
-- 파티션 관리·보관은 alm_audit_owner 멤버 로그인(alm_archive_login)만 아래 두 함수로 한다.
ALTER TABLE security_event OWNER TO alm_audit_owner;
ALTER TABLE audit_log_default OWNER TO alm_audit_owner;
ALTER TABLE security_event_default OWNER TO alm_audit_owner;
-- 기본 파티션은 앞의 GRANT … ON ALL TABLES로 앱 권한을 받았다. 파티션을 직접 읽으면 RLS가 걸리지 않으므로 회수(부모 테이블로만 접근)
REVOKE ALL ON audit_log_default, security_event_default FROM alm_app, alm_readonly;
GRANT REFERENCES (id) ON tenant TO alm_audit_owner;
GRANT USAGE, CREATE ON SCHEMA public TO alm_audit_owner;   -- 월 파티션 생성(PG15+는 public CREATE 기본 회수)

-- 이번 달 앞 p_back개월 ~ 뒤 p_ahead개월 파티션을 만든다(멱등). 기본 파티션에 그 범위 행이 있으면 새 파티션으로 옮긴다
-- (야간 정지 환경에서 관리 작업이 밀려 기본 파티션에 쌓인 경우). 반환: 새로 만든 파티션과 옮긴 행 수
CREATE FUNCTION log_partition_maintain(p_ahead int DEFAULT 3, p_back int DEFAULT 0)
RETURNS TABLE (tbl text, part text, moved bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t  text;
  i  int;
  m  date;
  lo timestamptz;
  hi timestamptz;
BEGIN
  IF p_ahead NOT BETWEEN 0 AND 24 OR p_back NOT BETWEEN 0 AND 120 THEN
    RAISE EXCEPTION 'log_partition_maintain: p_ahead 0..24, p_back 0..120';
  END IF;
  FOREACH t IN ARRAY ARRAY['audit_log', 'security_event'] LOOP
    FOR i IN -p_back..p_ahead LOOP
      m  := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
      part := format('%s_p%s', t, to_char(m, 'YYYYMM'));
      IF to_regclass(part) IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = to_regclass(part) AND inhparent = to_regclass(t)) THEN
          RAISE EXCEPTION 'log_partition_maintain: % exists but is not a partition of %', part, t;
        END IF;
        CONTINUE;
      END IF;
      lo := m::timestamp AT TIME ZONE 'UTC';
      hi := (m + interval '1 month')::timestamp AT TIME ZONE 'UTC';
      EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', part, t);
      EXECUTE format('WITH d AS (DELETE FROM %I WHERE occurred_at >= $1 AND occurred_at < $2 RETURNING *) INSERT INTO %I SELECT * FROM d',
                     t || '_default', part) USING lo, hi;
      GET DIAGNOSTICS moved = ROW_COUNT;
      EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', t, part, lo, hi);
      tbl := t;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END $$;

-- S3 보관이 끝난 파티션을 떼어 내 지운다. 13개월 온라인 기간(이번 달 포함 14개월)보다 오래된 월만, DB 건수가 보관한 건수와 같을 때만
CREATE FUNCTION log_partition_drop(p_table text, p_month date, p_rows bigint)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  part text;
  n    bigint;
BEGIN
  IF p_table NOT IN ('audit_log', 'security_event') THEN
    RAISE EXCEPTION 'log_partition_drop: % is not an archived log table', p_table;
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date
     OR p_month > (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '14 months')::date THEN
    RAISE EXCEPTION 'log_partition_drop: % is inside the 13-month online window', p_month;
  END IF;
  part := format('%s_p%s', p_table, to_char(p_month, 'YYYYMM'));
  IF NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = to_regclass(part) AND inhparent = to_regclass(p_table)) THEN
    RAISE EXCEPTION 'log_partition_drop: % is not a partition of %', part, p_table;
  END IF;
  EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', part);
  EXECUTE format('SELECT count(*) FROM %I', part) INTO n;
  IF n <> p_rows THEN
    RAISE EXCEPTION 'log_partition_drop: % has % rows, archive has %', part, n, p_rows;
  END IF;
  EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', p_table, part);
  EXECUTE format('DROP TABLE %I', part);
  RETURN n;
END $$;
ALTER FUNCTION log_partition_maintain(int, int) OWNER TO alm_audit_owner;
ALTER FUNCTION log_partition_drop(text, date, bigint) OWNER TO alm_audit_owner;
REVOKE ALL ON FUNCTION log_partition_maintain(int, int), log_partition_drop(text, date, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_partition_maintain(int, int), log_partition_drop(text, date, bigint) TO alm_audit_owner;
SELECT count(*) AS partitions_created FROM log_partition_maintain();

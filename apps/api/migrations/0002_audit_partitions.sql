-- 0002 감사 기록 월 파티션 (WBS 3.4 2차-3, 09 권한·보안 설계서 8.3)
-- audit_log·security_event를 occurred_at 월 단위 범위 파티션으로 바꾸고(기본키 (id, occurred_at)), 둘 다 alm_audit_owner가 소유한다.
-- 월 파티션은 log_partition_maintain()이, 13개월이 지난 파티션의 S3 보관 뒤 삭제는 log_partition_drop()이 한다(audit-archive 작업).
-- PostgreSQL은 기존 표를 제자리에서 파티션 표로 바꿀 수 없어 새 표를 만들고 행을 옮긴다. db/ddl.sql(새 DB)과 결과가 같아야 한다.
-- 러너(withAuditOwner)가 이 트랜잭션 동안 alm_audit_owner로 SET ROLE 할 수 있는 권한을 준다.
BEGIN;

-- 1) 소유자(마스터) 단계: 권한, security_event 소유권, 감사 보호 이벤트 함수(security_event 삭제 차단 추가)
GRANT USAGE, CREATE ON SCHEMA public TO alm_audit_owner;
GRANT REFERENCES (id) ON tenant TO alm_audit_owner;
ALTER TABLE security_event OWNER TO alm_audit_owner;
CREATE OR REPLACE FUNCTION guard_audit_ddl() RETURNS event_trigger
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

-- 2) 감사 소유 역할로: 기존 표를 옆으로 옮기고 이름이 겹치는 기본키·인덱스를 지운다(이벤트 트리거는 audit_log·security_event 이름만 막는다)
SET LOCAL ROLE alm_audit_owner;
ALTER TABLE audit_log RENAME TO audit_log_old;
ALTER TABLE audit_log_old DROP CONSTRAINT audit_log_pkey;
DROP INDEX ix_audit_log_tenant_id_table_name_row_id, ix_audit_log_tenant_id_occurred_at;
ALTER TABLE security_event RENAME TO security_event_old;
ALTER TABLE security_event_old DROP CONSTRAINT security_event_pkey;
DROP INDEX ix_security_event_tenant_id_occurred_at, ix_security_event_tenant_id_event_type_occurred_at;

-- 3) 새 파티션 표(db/ddl.sql과 같은 정의)
-- 감사 로그: 업무 테이블의 생성·변경·삭제 전후값(DB 트리거가 기록). 10년 보관, 월 파티션
CREATE TABLE audit_log (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  table_name varchar(63) NOT NULL,
  row_id uuid NOT NULL,
  action audit_action NOT NULL,
  before jsonb,
  after jsonb,
  actor_id uuid,
  actor_type varchar(10) NOT NULL,
  correlation_id uuid,
  ip_address inet,
  db_user varchar(63) NOT NULL,
  tx_id bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
COMMENT ON COLUMN audit_log.id IS '기본키';
COMMENT ON COLUMN audit_log.tenant_id IS '테넌트';
COMMENT ON COLUMN audit_log.table_name IS '테이블';
COMMENT ON COLUMN audit_log.row_id IS '행 id';
COMMENT ON COLUMN audit_log.action IS '동작';
COMMENT ON COLUMN audit_log.before IS '변경 전';
COMMENT ON COLUMN audit_log.after IS '변경 후';
COMMENT ON COLUMN audit_log.actor_id IS '사용자 id(FK 없음, 사용자 삭제 대비)';
COMMENT ON COLUMN audit_log.actor_type IS 'USER / SYSTEM / SAP / PDA';
COMMENT ON COLUMN audit_log.correlation_id IS '요청 추적 ID';
COMMENT ON COLUMN audit_log.ip_address IS '접속 IP';
COMMENT ON COLUMN audit_log.db_user IS '실제 DB 로그인 계정(session_user). 앱 계정이 아닌 직접 수정 식별';
COMMENT ON COLUMN audit_log.tx_id IS 'DB 트랜잭션 ID(같은 트랜잭션 변경 묶음)';
COMMENT ON COLUMN audit_log.occurred_at IS '발생 일시';
COMMENT ON COLUMN audit_log.created_at IS '생성 일시';
COMMENT ON TABLE audit_log IS '감사 로그 — 업무 테이블의 생성·변경·삭제 전후값(DB 트리거가 기록). 10년 보관, 월 파티션';
CREATE INDEX ix_audit_log_tenant_id_table_name_row_id ON audit_log (tenant_id, table_name, row_id);
CREATE INDEX ix_audit_log_tenant_id_occurred_at ON audit_log (tenant_id, occurred_at);

-- 보안 이벤트: 로그인·권한 거부·내보내기·비밀 교체 등. 10년 보관, 월 파티션. 테넌트를 알 수 없는 로그인 실패는 CloudWatch에만
CREATE TABLE security_event (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  event_type security_event_type NOT NULL,
  actor_id uuid,
  actor_type varchar(10) NOT NULL,
  channel varchar(5) NOT NULL,
  client_id varchar(100),
  ip_address inet,
  user_agent varchar(300),
  target varchar(200),
  detail jsonb,
  correlation_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE security_event_default PARTITION OF security_event DEFAULT;
COMMENT ON COLUMN security_event.id IS '기본키';
COMMENT ON COLUMN security_event.tenant_id IS '테넌트';
COMMENT ON COLUMN security_event.event_type IS '이벤트';
COMMENT ON COLUMN security_event.actor_id IS '사용자 id(FK 없음)';
COMMENT ON COLUMN security_event.actor_type IS 'USER / SYSTEM / SAP / PDA';
COMMENT ON COLUMN security_event.channel IS 'WEB / PDA / SAP';
COMMENT ON COLUMN security_event.client_id IS 'Cognito 앱 클라이언트 ID';
COMMENT ON COLUMN security_event.ip_address IS '접속 IP';
COMMENT ON COLUMN security_event.user_agent IS '브라우저·앱 정보';
COMMENT ON COLUMN security_event.target IS '대상(API 경로, 사용자 id, 연결 id 등)';
COMMENT ON COLUMN security_event.detail IS '상세(거부 사유, 권한 키, 내보내기 행 수 등)';
COMMENT ON COLUMN security_event.correlation_id IS '요청 추적 ID';
COMMENT ON COLUMN security_event.occurred_at IS '발생 일시';
COMMENT ON COLUMN security_event.created_at IS '생성 일시';
COMMENT ON TABLE security_event IS '보안 이벤트 — 로그인·권한 거부·내보내기·비밀 교체 등. 10년 보관, 월 파티션. 테넌트를 알 수 없는 로그인 실패는 CloudWatch에만';
CREATE INDEX ix_security_event_tenant_id_occurred_at ON security_event (tenant_id, occurred_at);
CREATE INDEX ix_security_event_tenant_id_event_type_occurred_at ON security_event (tenant_id, event_type, occurred_at);

ALTER TABLE audit_log ADD CONSTRAINT fk_audit_log_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE security_event ADD CONSTRAINT fk_security_event_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenant(id);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_audit_log_tenant ON audit_log USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE security_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_security_event_tenant ON security_event USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- 권한: 앱은 부모 표로만(감사는 조회, 보안 이벤트는 조회·추가). 파티션에는 권한을 주지 않는다(직접 읽으면 RLS가 걸리지 않음)
GRANT SELECT ON audit_log TO alm_app, alm_readonly;
GRANT SELECT, INSERT ON security_event TO alm_app;
GRANT SELECT ON security_event TO alm_readonly;

-- 4) 파티션 관리·삭제 함수(감사 소유 역할이 만들므로 소유자도 alm_audit_owner)
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
REVOKE ALL ON FUNCTION log_partition_maintain(int, int), log_partition_drop(text, date, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_partition_maintain(int, int), log_partition_drop(text, date, bigint) TO alm_audit_owner;

-- 5) 기존 행이 있는 달부터 3개월 뒤까지 파티션을 만들고 행을 옮긴다
DO $$
DECLARE
  first_month date := date_trunc('month', least((SELECT min(occurred_at) FROM audit_log_old), (SELECT min(occurred_at) FROM security_event_old),
                                               now()) AT TIME ZONE 'UTC')::date;
  back int := (extract(year FROM age(date_trunc('month', now() AT TIME ZONE 'UTC')::date, first_month)) * 12
             + extract(month FROM age(date_trunc('month', now() AT TIME ZONE 'UTC')::date, first_month)))::int;
BEGIN
  PERFORM log_partition_maintain(3, least(back, 120));
END $$;
INSERT INTO audit_log (id, tenant_id, table_name, row_id, action, before, after, actor_id, actor_type, correlation_id, ip_address, db_user, tx_id, occurred_at, created_at)
  SELECT id, tenant_id, table_name, row_id, action, before, after, actor_id, actor_type, correlation_id, ip_address, db_user, tx_id, occurred_at, created_at FROM audit_log_old;
INSERT INTO security_event (id, tenant_id, event_type, actor_id, actor_type, channel, client_id, ip_address, user_agent, target, detail, correlation_id, occurred_at, created_at)
  SELECT id, tenant_id, event_type, actor_id, actor_type, channel, client_id, ip_address, user_agent, target, detail, correlation_id, occurred_at, created_at FROM security_event_old;
DROP TABLE audit_log_old, security_event_old;
RESET ROLE;

COMMIT;

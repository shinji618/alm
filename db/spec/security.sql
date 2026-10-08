-- Security (WBS 2.8) ------------------------------------------------------
-- DB 역할
--   (소유자)        : 마이그레이션 계정. 업무 테이블 소유. 배포 파이프라인만 사용
--   alm_audit_owner : audit_log·audit_row()·보호 함수 소유. 로그인 없음, 파이프라인 계정은 멤버 아님(최초 1회 DBA가 부트스트랩)
--   alm_app         : NestJS 서버. 소유자 아님, BYPASSRLS 없음 → 모든 테이블에 RLS 적용
--   alm_readonly    : 운영 조회·리포트(읽기 전용, RLS 적용)
-- 로그인 사용자(예: alm_app_login, IAM DB 인증)는 인프라(CDK)가 만들고 위 역할을 부여한다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alm_app') THEN
    CREATE ROLE alm_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alm_readonly') THEN
    CREATE ROLE alm_readonly NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alm_audit_owner') THEN
    CREATE ROLE alm_audit_owner NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO alm_app, alm_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO alm_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO alm_readonly;
-- 테넌트·도메인 행은 플랫폼 운영(소유자)만 바꾼다. 앱은 RLS로 자기 테넌트 행만 조회
REVOKE INSERT, UPDATE, DELETE ON tenant, tenant_domain FROM alm_app;
-- 감사 로그는 트리거만 쓴다(앱은 조회만)
REVOKE INSERT ON audit_log FROM alm_app;

-- 감사 트리거 ---------------------------------------------------------------
-- 앱은 트랜잭션마다 SET LOCAL 로 다음 값을 넣는다:
--   app.tenant_id, app.user_id, app.actor_type(USER/SYSTEM/SAP/PDA), app.correlation_id, app.client_ip
-- UPDATE는 바뀐 컬럼만 before/after에 남기고, 바뀐 값이 없으면 기록하지 않는다.
-- 앱 계정(alm_app 멤버)으로 접속했는데 actor_type이 비어 있으면 변경 자체를 거부한다(처리자 누락 방지).
-- 앱이 넣는 처리자 값은 '앱이 주장한 값'이므로 실제 DB 계정(session_user)과 트랜잭션 ID를 함께 남긴다.
-- 형식이 틀린 correlation_id·client_ip는 NULL로 남긴다(업무 트랜잭션을 실패시키지 않음).
CREATE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  skip   text[] := ARRAY['created_at', 'created_by', 'updated_at', 'updated_by', 'version'];
  o      jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n      jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  b      jsonb;
  a      jsonb;
  k      text;
  actor  text := NULLIF(current_setting('app.actor_type', true), '');
  uid    text := NULLIF(current_setting('app.user_id', true), '');
  cid    text := NULLIF(current_setting('app.correlation_id', true), '');
  cip    text := NULLIF(current_setting('app.client_ip', true), '');
  tid    uuid;
  v_uid  uuid;
  v_cid  uuid;
  v_cip  inet;
BEGIN
  -- 슈퍼유저는 모든 역할의 멤버로 판정되므로 pg_has_role 대신 직접 멤버십을 본다
  IF actor IS NULL AND EXISTS (SELECT 1 FROM pg_auth_members m
                                 JOIN pg_roles r ON r.oid = m.roleid
                                 JOIN pg_roles u ON u.oid = m.member
                                WHERE r.rolname = 'alm_app' AND u.rolname = session_user) THEN
    RAISE EXCEPTION 'audit: app.actor_type is not set for application session %', session_user;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    b := '{}'; a := '{}';
    FOR k IN SELECT jsonb_object_keys(n - skip) LOOP
      IF (n -> k) IS DISTINCT FROM (o -> k) THEN
        b := b || jsonb_build_object(k, o -> k);
        a := a || jsonb_build_object(k, n -> k);
      END IF;
    END LOOP;
    IF a = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
  ELSE
    b := o - skip;
    a := n - skip;
  END IF;
  -- 캐스트는 IF로 분기(CASE 안의 캐스트는 상수 접기로 먼저 실행될 수 있음)
  IF pg_input_is_valid(uid, 'uuid') THEN v_uid := uid::uuid; END IF;
  IF pg_input_is_valid(cid, 'uuid') THEN v_cid := cid::uuid; END IF;
  IF pg_input_is_valid(cip, 'inet') THEN v_cip := cip::inet; END IF;
  tid := CASE WHEN TG_TABLE_NAME = 'tenant' THEN (COALESCE(n, o) ->> 'id')::uuid
              ELSE (COALESCE(n, o) ->> 'tenant_id')::uuid END;
  INSERT INTO audit_log (id, tenant_id, table_name, row_id, action, before, after,
                         actor_id, actor_type, correlation_id, ip_address, db_user, tx_id)
  VALUES (gen_random_uuid(), tid, TG_TABLE_NAME, (COALESCE(n, o) ->> 'id')::uuid, TG_OP::audit_action, b, a,
          v_uid, COALESCE(actor, 'SYSTEM'), v_cid, v_cip,
          session_user, txid_current());
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION audit_row() FROM PUBLIC;

-- 인증 전 조회 ----------------------------------------------------------------
-- 테넌트를 아직 모르는 단계만 SECURITY DEFINER 함수로 연다. RLS 우회 역할은 두지 않는다.
-- 웹 로그인 화면: 이메일 도메인 → IdP 이름(활성 테넌트만)
CREATE FUNCTION auth_idp_by_domain(p_domain text)
RETURNS varchar LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.idp_provider_name
    FROM tenant_domain d JOIN tenant t ON t.id = d.tenant_id
   WHERE d.domain = lower(p_domain) AND d.is_active AND t.is_active
$$;
-- 토큰 확인: username → 테넌트(활성만). username = '<idp_provider_name>_<IdP 사용자 ID>'
CREATE FUNCTION auth_tenant_by_username(p_username text)
RETURNS TABLE (tenant_id uuid, idp_subject text, jit_provision boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, substr(p_username, length(t.idp_provider_name) + 2), t.jit_provision
    FROM tenant t
   WHERE t.is_active AND p_username LIKE t.idp_provider_name || '\_%'
$$;
-- SAP: client_id → 연결(활성 연결·활성 테넌트만)
CREATE FUNCTION auth_sap_client(p_client_id text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, company_id uuid, system_id varchar, allowed_cidrs jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.id, c.company_id, c.system_id, c.allowed_cidrs
    FROM sap_connection c JOIN tenant t ON t.id = c.tenant_id
   WHERE c.oauth_client_id = p_client_id AND c.is_active AND t.is_active
$$;
REVOKE ALL ON FUNCTION auth_idp_by_domain(text), auth_tenant_by_username(text), auth_sap_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_idp_by_domain(text), auth_tenant_by_username(text), auth_sap_client(text) TO alm_app;

-- 중앙 ID 서비스 스키마(WBS 3.12, 17 문서 6장). 마이그레이션 계정(마스터)이 소유, 앱은 id_app 역할로 접속한다.
-- 테넌트 데이터(사용자·역할 부여·보안 이벤트·변경 이력)는 RLS로 app.tenant_id 테넌트만 보인다.
-- 플랫폼 데이터(테넌트·도메인·제품·제품 클라이언트)는 RLS 없이 앱 코드가 호출자 권한(admin 범위)으로 막는다.


CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------- 플랫폼 ----------
CREATE TABLE tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9](?:[A-Z0-9-]{0,18}[A-Z0-9])?$'),
  name varchar(100) NOT NULL,
  jit_provision boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE tenant IS '테넌트(고객사). Cognito IdP 이름 T-<code>, 사용자명 T-<code>_<IdP 사용자 ID>';

CREATE TABLE tenant_domain (
  domain varchar(253) PRIMARY KEY CHECK (domain = lower(domain)),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tenant_domain IS '이메일 도메인 → 테넌트(로그인 화면의 테넌트 찾기)';

CREATE TABLE product (
  code varchar(20) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9-]{1,19}$'),
  name varchar(100) NOT NULL,
  catalog jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE product IS '제품 등록(6.2): 역할 목록·배타/암묵 역할·관리자 역할·범위 차원·SoD 규칙(catalog)';

CREATE TABLE product_client (
  client_id varchar(128) PRIMARY KEY,
  product_code varchar(20) NOT NULL REFERENCES product(code) ON DELETE CASCADE,
  kind varchar(10) NOT NULL CHECK (kind IN ('USER', 'MACHINE')),
  name varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_code, name)
);
COMMENT ON TABLE product_client IS 'Cognito 앱 클라이언트 → 제품. USER = 사용자 로그인(웹·앱, 테넌트 IdP 연결 대상), MACHINE = 제품 백엔드(client_credentials)';

CREATE TABLE tenant_product (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  product_code varchar(20) NOT NULL REFERENCES product(code),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_code)
);
COMMENT ON TABLE tenant_product IS '테넌트가 쓰는 제품. 테넌트 IdP는 이 제품들의 USER 클라이언트에 연결된다';

-- ---------- 테넌트 데이터(RLS) ----------
CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  email varchar(254) NOT NULL CHECK (email = lower(email)),
  display_name varchar(100) NOT NULL,
  employee_no varchar(20),
  is_active boolean NOT NULL DEFAULT true,
  idp_subject varchar(255) UNIQUE,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, email)
);
COMMENT ON TABLE app_user IS '중앙 사용자. idp_subject = Cognito 사용자명(T-<테넌트>_<IdP 사용자 ID>), 첫 로그인 때 연결';

CREATE TABLE role_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  product_code varchar(20) NOT NULL REFERENCES product(code),
  role varchar(40) NOT NULL,
  scope_key varchar(200) NOT NULL DEFAULT '',
  valid_from date, valid_until date,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (user_id, product_code, role, scope_key),
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until)
);
CREATE INDEX ON role_assignment (tenant_id, product_code, role);
COMMENT ON TABLE role_assignment IS '제품별 역할 부여(ALM user_role과 같은 구조). 범위는 role_assignment_scope';

CREATE TABLE role_assignment_scope (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  assignment_id uuid NOT NULL REFERENCES role_assignment(id) ON DELETE CASCADE,
  dimension varchar(30) NOT NULL,
  value varchar(60) NOT NULL,
  UNIQUE (assignment_id, dimension)
);
CREATE INDEX ON role_assignment_scope (tenant_id, dimension, value);
COMMENT ON TABLE role_assignment_scope IS '역할 부여의 범위(차원·값). 값의 유효성은 제품이 확인(6.2)';

CREATE TABLE security_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  event_type varchar(20) NOT NULL CHECK (event_type IN ('LOGIN', 'LOGIN_DENIED')),
  user_id uuid, product_code varchar(20), client_id varchar(128), target varchar(254),
  detail jsonb, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON security_event (tenant_id, occurred_at DESC);

CREATE TABLE change_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  table_name varchar(63) NOT NULL, row_id uuid NOT NULL,
  action varchar(6) NOT NULL, before jsonb, after jsonb,
  actor varchar(200), occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON change_log (tenant_id, occurred_at DESC);
COMMENT ON TABLE change_log IS '사용자·역할 변경 감사(트리거). actor = app.actor(제품:사용자 ID 또는 플랫폼 클라이언트)';

CREATE FUNCTION log_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
        n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
BEGIN
  INSERT INTO change_log (tenant_id, table_name, row_id, action, before, after, actor)
  VALUES ((coalesce(n, o) ->> 'tenant_id')::uuid, TG_TABLE_NAME, (coalesce(n, o) ->> 'id')::uuid, TG_OP, o, n,
          nullif(current_setting('app.actor', true), ''));
  RETURN NULL;
END $$;
CREATE TRIGGER tr_app_user_log AFTER INSERT OR UPDATE OR DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION log_change();
CREATE TRIGGER tr_role_assignment_log AFTER INSERT OR UPDATE OR DELETE ON role_assignment FOR EACH ROW EXECUTE FUNCTION log_change();
CREATE TRIGGER tr_role_assignment_scope_log AFTER INSERT OR UPDATE OR DELETE ON role_assignment_scope FOR EACH ROW EXECUTE FUNCTION log_change();

-- 로그인 첫 단계: 사용자명(T-<테넌트>_...) → 테넌트. RLS 밖에서 필요한 최소 정보만
CREATE FUNCTION tenant_by_username(username text) RETURNS TABLE (tenant_id uuid, tenant_code varchar, jit_provision boolean, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.code, t.jit_provision, t.is_active FROM tenant t
   WHERE username LIKE 'T-%\_%' AND t.code = split_part(substr(username, 3), '_', 1) $$;

-- ---------- 앱 역할·권한·RLS ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_app') THEN CREATE ROLE id_app LOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO id_app;
GRANT SELECT ON tenant, tenant_domain, product, product_client, tenant_product TO id_app;
GRANT INSERT, UPDATE, DELETE ON tenant, tenant_domain, product, product_client, tenant_product TO id_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_user, role_assignment, role_assignment_scope TO id_app;
GRANT SELECT, INSERT ON security_event TO id_app;
GRANT SELECT ON change_log TO id_app;
GRANT EXECUTE ON FUNCTION app_tenant(), tenant_by_username(text) TO id_app;
REVOKE EXECUTE ON FUNCTION log_change() FROM PUBLIC;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['app_user', 'role_assignment', 'role_assignment_scope', 'security_event', 'change_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_%s_tenant ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t, t);
  END LOOP;
END $$;

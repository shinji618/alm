-- 0012 SAP 클라이언트 별칭(2026-10-21, WBS 7.3·13 런북 7-2). db/ddl.sql(새 DB)과 결과가 같아야 한다.
--   SM59 기본 인증의 사용자 필드가 12자라 Cognito clientId(26자)를 넣을 수 없다 → 연결마다 12자 이내 별칭을 두고,
--   /oauth/token은 Basic 사용자가 별칭이면 clientId로 바꿔 Cognito에 요청한다. 비밀은 SM59 비밀번호(보안 저장소)에만 둔다
BEGIN;
ALTER TABLE sap_connection ADD COLUMN client_alias varchar(12);
ALTER TABLE sap_connection ADD CONSTRAINT sap_connection_client_alias_key UNIQUE (client_alias);
COMMENT ON COLUMN sap_connection.client_alias IS '클라이언트 별칭(SM59 기본 인증 사용자 12자 제한). /oauth/token에서 clientId 대신 받는다. 전체에서 유일';
CREATE FUNCTION auth_sap_alias(p_alias text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.oauth_client_id
    FROM sap_connection c JOIN tenant t ON t.id = c.tenant_id
   WHERE upper(c.client_alias) = upper(p_alias) AND c.is_active AND t.is_active
$$;
REVOKE ALL ON FUNCTION auth_sap_alias(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_sap_alias(text) TO alm_app;
COMMIT;

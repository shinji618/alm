-- 0021 중앙 ID 테넌트 ID 매핑(2026-11-06): ALM tenant.id는 ALM이 만든 값이라 중앙 ID의 테넌트 ID와 다르다.
--   Portal은 중앙 ID의 테넌트 ID로 말하므로(피드 요청·알림 수신), ALM이 둘을 서로 바꿔야 한다.
--   값은 중앙 로그인 때 채운다(코드 TEST 같은 테넌트 코드가 일치함을 확인한 뒤).
BEGIN;
ALTER TABLE tenant ADD COLUMN central_tenant_id uuid UNIQUE;
COMMENT ON COLUMN tenant.central_tenant_id IS '중앙 ID 서비스의 테넌트 ID(Portal과 주고받는 ID). 중앙 로그인 때 채운다';

-- 테넌트를 모르는 단계(Portal 피드 요청): 중앙 테넌트 ID → ALM 테넌트 ID(활성만)
CREATE FUNCTION auth_tenant_by_central_id(p_central_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id FROM tenant t WHERE t.central_tenant_id = p_central_id AND t.is_active
$$;
REVOKE ALL ON FUNCTION auth_tenant_by_central_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_tenant_by_central_id(uuid) TO alm_app;
-- ALM 앱 역할은 tenant를 수정할 수 없으므로(관리 화면도 읽기 전용), 로그인 때 매핑만 채우는 좁은 함수를 둔다
CREATE FUNCTION auth_link_central_tenant(p_tenant_id uuid, p_central_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE tenant SET central_tenant_id = p_central_id WHERE id = p_tenant_id AND central_tenant_id IS DISTINCT FROM p_central_id
$$;
REVOKE ALL ON FUNCTION auth_link_central_tenant(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_link_central_tenant(uuid, uuid) TO alm_app;
COMMIT;

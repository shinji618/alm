# 제품 등록 파일 (중앙 ID 서비스, WBS 3.12)

`bash infra/scripts/identity-admin.sh <env> POST /v1/products infra/identity/products/<제품>.<env>.json`

- `catalog`: 역할 목록과 규칙(관리자 역할·배타 역할·암묵 역할·범위 차원·SoD). ALM은 `api/permissions.json`에서 만든다(권한 내용은 제품이 갖는다).
- `userClients`: 사용자 로그인용 앱 클라이언트(웹·앱). 테넌트 SSO(IdP)가 자동으로 연결된다.
- `machineClient`: 제품 백엔드가 중앙 API를 부르는 클라이언트(`<제품>-backend`, client_credentials, read·write).
- 다시 실행해도 된다: 카탈로그는 갱신, 클라이언트는 없을 때만 만든다. 처음 만들 때만 응답에 클라이언트 비밀이 나오므로 바로 비밀 저장소(제품 계정 Secrets Manager)에 옮긴다.

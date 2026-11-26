# vendor — 플랫폼 공통 패키지 묶음 파일

pas-suite 저장소의 `packages/`(통합 WBS 7.1)에서 빌드한 묶음 파일이다. **여기서 고치지 않는다** — 원본은 pas-suite에 있다.

| 파일 | 내용 |
|---|---|
| `shinji618-platform-auth-*.tgz` | 통행증 검사, CSRF 확인 |
| `shinji618-platform-central-id-*.tgz` | 중앙 ID 호출 |
| `shinji618-platform-db-*.tgz` | 테넌트 트랜잭션(RLS), RDS IAM 접속 설정 |
| `shinji618-platform-http-*.tgz` | 요청 추적 값, 로그, 출발지 IP |

- `apps/api/package.json`이 `file:../../vendor/…`로 설치한다. 이미지 빌드는 `apps/api/Dockerfile`이 이 폴더를 먼저 복사한다. 토큰이나 패키지 저장소 설정이 필요 없다.
- 파일의 sha256은 pas-suite `packages/RELEASES.json`의 값과 같아야 한다.
- 버전을 올릴 때: pas-suite에서 `node packages/pack.mjs` → 새 파일을 여기 넣고 옛 파일을 지움 → `apps/api/package.json`의 경로 수정 → `apps/api`에서 `npm install` → 묶음 파일·package.json·package-lock.json을 함께 커밋.

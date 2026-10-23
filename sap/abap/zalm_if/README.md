# ZALM_IF — SAP 쪽 ALM 인터페이스 (WBS 7.3 공통, 7.4 마스터 송신)

08 SAP 인터페이스 명세서 7장의 공통 객체. 이후 7.4~7.9(송신·전기·대사 프로그램)가 이 클래스들을 쓴다.

| 객체 | 종류 | 내용 |
| --- | --- | --- |
| ZALM_IF | 패키지 | |
| ZALM_IF_LOG | 테이블 | 실행·전기 건별 결과(10년 보관). 보조 인덱스 Z01 POSTING_ID, Z02 IF_ID+START_TS, Z03 STATUS+HTTP_STATUS |
| ZALM_CFG | 테이블 | 설정(PARAM + LOW → VAL). BUKRS(여러 행), RETRY_WAIT_SEC, POST_BLOCK, LAST_AA01·LAST_MM01·LAST_MM03 등 |
| ZALM_MAP | 테이블 | 값 매핑(RETIRE_TT: SCRAP·SALE·LOSS → 거래유형 등) |
| ZALM | 메시지 클래스 | 001~099 통신, 100~199 데이터, 200~299 전기 |
| ZCX_ALM | 예외 클래스 | 통신·인증·설정 오류(mv_text, mv_http_status) |
| ZCL_ALM_CFG | 클래스 | ZALM_CFG·ZALM_MAP 읽기·쓰기, 마지막 성공 시각, 델타 시작점(10분 겹침·서머타임) |
| ZCL_ALM_LOG | 클래스 | ZALM_IF_LOG 기록 + SLG1(객체 ZALM, 하위 객체 = IF ID) + 잡 로그 |
| ZCL_ALM_HTTP_CLIENT | 클래스 | SM59 ZALM_API 호출, 토큰(SM59 ZALM_TOKEN), 헤더, 재시도(1·2·4분 3회, 401 토큰 갱신), 분할 송신, 207 해석 |
| ZALM_IF_PING | 프로그램 | 연결 시험(토큰 → GET /sap/ping), 로그 남김 |
| ZALM_IF_CONFIG | 프로그램 | ZALM_CFG·ZALM_MAP 조회·저장·삭제, 기본값 넣기 |
| ZALM_IF_MASTER_SEND | 프로그램 | 7.4 IF-MD-01 조직·코드 마스터 전체 송신(변형 MD01). 수동 실행과 잡 겸용. AA01·AA02·MM01 변형은 7.5에서 추가 |

명세서와 다른 점: 잡 겹침 방지는 잠금 객체 EZALM_RUN 대신 표준 `ENQUEUE_E_TABLE`(테이블 ZALM_IF_LOG, 키 = 잡 이름)을 쓴다(7.6에서 사용).

## 자격 증명 보관(2026-10-21 결정, 13 런북 7-2)

SM59 기본 인증의 사용자 필드가 12자라 Cognito clientId(26자)를 넣을 수 없다. 그래서 ALM의 SAP 연결마다 **12자 이내 별칭**(`sap_connection.client_alias`, 예: `BSG-S4H100`)을 두고, SAP은 SM59 `ZALM_TOKEN`의 기본 인증에 **사용자 = 별칭, 비밀번호 = 클라이언트 비밀**을 넣는다. ALM의 `/oauth/token`이 별칭을 clientId로 바꾼다. 비밀은 SM59(SAP 보안 저장소)에만 있고 ABAP 코드·테이블에는 없다.

## 설치 순서 (DEV)

1. **ALM에 별칭 등록** (배포 후, 관리 계정 CloudShell)

   ```bash
   bash db-seed.sh dev '{"tenant":{"code":"<테넌트 코드>"},"sapConnections":[{"systemId":"S4H-100","companyCode":"1000","clientId":"<지금 쓰는 clientId>","clientAlias":"BSG-S4H100"}]}'
   ```

   `allowedCidrs`를 빼면 기존 허용 IP를 그대로 둔다. 별칭은 대문자·숫자·`_-` 3~12자, 전체에서 유일.

2. **abapGit으로 가져오기**: SE38 `ZABAPGIT_STANDALONE` → New Offline → 이름 `ZALM_IF`, 패키지 `ZALM_IF`(없으면 만들기) → Import ZIP(`zalm_if.zip`) → Pull → 운반 요청 선택 → 활성화까지 확인.
3. **SLG0**: 객체 `ZALM`(ALM interface). 하위 객체 `PING`, `IF-MD-01`, `IF-AA-01`, `IF-AA-02`, `IF-MM-01`, `IF-MM-03`, `IF-AA-03`~`IF-AA-07`, `IF-MM-02`, `IF-RC-01`, `IF-OP-01`. 없으면 SLG1만 건너뛰고 ZALM_IF_LOG에는 남는다.
4. **SM59** (둘 다 유형 G, SSL 활성·ANONYM — STRUST의 Amazon Root CA는 이미 넣어 둠)

   | 이름 | 호스트 | 포트 | 경로 접두어 | 로그온 |
   | --- | --- | --- | --- | --- |
   | `ZALM_API` | `alm-dev.bsgapps.com` | 443 | `/api/v1` | 없음 |
   | `ZALM_TOKEN` | `alm-dev.bsgapps.com` | 443 | `/api/v1/oauth/token` | 기본 인증: 사용자 = 별칭, 비밀번호 = 클라이언트 비밀 |

   기존 시험용 `ZALM_DEV`를 복사해 `ZALM_API`로 만들어도 된다.
5. **SE38 `ZALM_IF_CONFIG`** → 기본값 넣기(BUKRS 1000, RETRY_WAIT_SEC 60, POST_BLOCK, PO_DOC_TYPE NB, RETIRE_TT SCRAP = 200).
6. **SE38 `ZALM_IF_PING`** → ① 토큰 ② `/sap/ping` HTTP 200 ③ 다시 호출(저장된 토큰) 200이면 완료. SE16 `ZALM_IF_LOG`(IF_ID = PING)와 SLG1(객체 ZALM)에서 기록 확인.

SM59 비밀번호 칸이 클라이언트 비밀 길이를 받지 못하면, ZALM_TOKEN 없이 `ZALM_IF_PING`의 시험 모드(P_MANUAL)로 연결만 확인하고 알려 주세요.

## IF-MD-01 마스터 송신 (7.4)

`ZALM_IF_MASTER_SEND`(SE38). COMPANY → PLANT → PROFIT_CENTER → COST_CENTER → ASSET_CLASS → LOCATION 순서로 `POST /sap/master-data`에 5,000건씩 보낸다.

| 화면 항목 | 내용 |
| --- | --- |
| 변형 | MD01 |
| 회사코드 | 비우면 ZALM_CFG `BUKRS`(여러 행). 회사코드마다 **ALM에 SAP 연결(시스템 ID + 회사코드)이 있어야** 한다 |
| 시험 실행 | 체크하면 선택만 하고 건수를 보여 준다(보내지 않음, 잠금·로그 기록 없음) |
| 실행 요청 ID | IF-OP-01 수동 실행 요청의 ID(앞 8자리). 배치 ID 끝에 `-REQ<id>`로 붙는다 |

- 회사코드마다 배치 ID가 다르다(`MD01-<UTC yyyymmddhhmm>-<BUKRS>`). 손익센터·자산클래스는 ALM이 전체 범위로 비활성 처리하므로 모든 대상 회사의 합집합을 첫 회사 연결로 한 번만 보낸다.
- 관리회계영역은 ZALM_CFG `KOKRS`가 있으면 그 값, 없으면 TKA02(회사코드에 지정된 값).
- 저가자산 클래스(D-06 미결)는 ZALM_CFG `LOWVAL_CLASS`(여러 행, 예: `00003100`)에 넣은 클래스만 true. 없으면 모두 false. 내용연수는 클래스 기본 상각영역 01(ANKB-NDJAR).
- 같은 프로그램이 겹쳐 돌지 않도록 `ENQUEUE_E_TABLE`(ZALM_IF_LOG, 키 `IF-MD-01`)로 잠근다. 잡으로 돌리다 실패가 있으면 잡이 오류로 끝난다(SM37).
- 결과: SE16 `ZALM_IF_LOG`(IF_ID `IF-MD-01`, 회사코드별 1행), SLG1 객체 ZALM / 하위 객체 `IF-MD-01`.
- 시험 순서: ① 시험 실행으로 건수 확인 → ② 실제 송신 → ③ ALM 화면(마스터)에서 확인 → ④ 같은 조건으로 한 번 더 보내 오류·SKIPPED가 없는지 확인.

## 문법 검사(개발용)

`abaplint.json`(SAP_BASIS 7.50 문법, Z 네임스페이스만 엄격히). 표준 객체 정의는 `abaplint/deps`를 `/deps`에 받아 둔 곳에서 `npx @abaplint/cli abaplint.json`.

DDIC XML은 `../tools/gen_ddic.py`에서 만든다(테이블·메시지 클래스를 고치면 다시 실행).

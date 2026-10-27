# ZALM_IF — SAP 쪽 ALM 인터페이스 (WBS 7.3 공통, 7.4 마스터 송신, 7.5 자산 송신)

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
| ZALM_IF_POSTING | 프로그램 | 7.6 전기 잡 1단계: claim(ASSET_CREATE·ASSET_CHANGE) → BAPI_FIXEDASSET_CREATE1/CHANGE(동적 호출) → 로그 후 커밋 → 결과 회신 → 회신 실패 재회신. 이관·폐기·실사 결과(IF-AA-05~07)는 이어서 추가 |
| ZALM_IF_RUNREQ | 프로그램 | 7.9 IF-OP-01 실행 요청 확인 → 요청마다 즉시 잡(ZALM_RUN_<변형>) 기동. 15분 잡 1스텝 |
| ZALM_IF_MONITOR | 프로그램 | 7.9 운영 모니터(IF별 현황·지연, 최근 실패, ZALM 잡 상태·예약 확인). 읽기 전용 |
| ZALM_IF_MASTER_SEND | 프로그램 | 7.4 IF-MD-01 조직·코드 마스터 전체 송신(변형 MD01). 수동 실행과 잡 겸용. 변형 AA01(IF-AA-01 자산 마스터 델타, 7.5). 변형 AA02(IF-AA-02 자산 금액, 7.5). AA02는 PO·AuC 출처(origins)도 함께 송신. 변형 RC01(IF-RC-01 대사 스냅샷, 7.8). MM01(PO 송신)은 보류 |

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
   | `ZALM_API` | `alm-dev.pasapps.com` | 443 | `/api/v1` | 없음 |
   | `ZALM_TOKEN` | `alm-dev.pasapps.com` | 443 | `/api/v1/oauth/token` | 기본 인증: 사용자 = 별칭, 비밀번호 = 클라이언트 비밀 |

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

## IF-AA-01 자산 마스터 델타 송신 (7.5)

같은 프로그램 `ZALM_IF_MASTER_SEND`에서 **변형 AA01**. `POST /sap/assets:upsert`에 1,000건씩(화면 분할 크기가 더 커도 1,000으로 제한) 보낸다.

| 화면 항목 | 내용 |
| --- | --- |
| 변형 | AA01 |
| 전체 송신 | 체크하면 마지막 성공 시각과 상관없이 대상 회사코드의 자산 전체를 `isFull = true`로 보낸다 |
| 시험 실행 | 선택만 하고 건수·경고를 보여 준다(보내지 않음, 시각 저장 없음) |

- **대상 선택**: ① 마지막 성공 이후 변경 문서(CDHDR, 객체 ANLA) ② 그 날짜 이후 생성(ANLA-ERDAT) ③ 효력일(ANLZ-ADATU)이 지난 실행과 오늘 사이에 도래한 시간종속 행. 삭제 표시(ANLA-XLOEV) 자산은 제외.
- **마지막 성공 시각**: 회사코드별 ZALM_CFG `LAST_AA01_<BUKRS>`(UTC, 08 명세의 `LAST_AA01`과 달리 회사코드별). 비어 있으면 최초 실행으로 전체 송신. 실행은 저장 시각보다 10분 앞부터 읽는다(겹쳐 보내도 ALM이 같은 값이면 SKIPPED). 성공(HTTP 오류 없음)하면 잡 시작 시각을 저장하고, 실패하면 그대로 둔다. 건별 ERROR(코스트센터·자산클래스가 ALM에 없음)는 ALM이 다음 IF-MD-01 뒤 자동 재처리하므로 시각은 올린다.
- **보내는 필드**: 회사코드·자산번호·하위번호(내부 형식 그대로), 자산클래스, 설명(TXT50), 시리얼, 자산태그(INVNR), 취득일(AKTIV), 비활성일(DEAKT), 마지막 실사일·메모(IVDAT·INVZU), 코스트센터·플랜트·위치(STORT), 변경 시각(UTC). 룸 코드는 STORT를 쓰고 RAUMNR은 비운다(D-09). 프로핏센터는 ALM이 저장하지 않아 보내지 않는다.
- **빼는 자산**: 설명·자산클래스·코스트센터가 빈 자산은 API가 거절하므로 보내지 않고 SLG1 경고와 ZALM_IF_LOG(오류 건수·메시지)에 남긴다(08 T31).
- **결과**: ZALM_IF_LOG(IF_ID `IF-AA-01`, 회사코드별 1행), SLG1 하위 객체 `IF-AA-01`. 마지막 줄에 `반영 a / 변경 없음 b / 오류 c`. MD01도 같은 형식.
- **시험 순서**: ① 시험 실행으로 대상 키·건수 확인(최초라 전체) → ② 실제 송신(최초 = 전체) → ③ ALM 자산 목록·SAP 연계 화면 확인 → ④ 바로 다시 실행해 델타(0건 또는 변경분)가 되는지 → ⑤ AS02로 자산명 한 건 변경 후 실행 → ALM에서 이름과 이력(SAP_SYNCED) 확인(T06).

## IF-AA-02 자산 금액 송신 (7.5)

같은 프로그램에서 **변형 AA02**. `POST /sap/asset-values`에 1,000건씩 보낸다.

| 화면 항목 | 내용 |
| --- | --- |
| 변형 | AA02 |
| 기간 | 0이면 자동(ANLC-PERAF, S/4HANA 호환 뷰처럼 PERAF가 없으면 현재 전기 기간). 마감 실행은 마감한 기간(예: 10)을 지정 |
| 마감 실행 | 체크하면 요청 본문에 `isClosing = true`. ALM이 그 (회계연도, 기간)의 값을 마감값으로 잠가 이후 일일 값(SKIPPED)이 덮지 않는다. 월말 상각 전기·마감 뒤 자산회계가 ALM 화면(IF-OP-01)에서 요청 |
| 시험 실행 | 보내지 않고 앞 10건의 금액 구성(KANSW + ANSWL, KNAFA + NAFAG, 추가 필드)을 로그에 보여 준다 → **AW01N 장부가와 대조** |

- **대상**: 회사코드의 삭제 표시 아닌 자산 전체, 상각영역 01. 매일 전체를 보내고 같은 값이면 ALM이 SKIPPED로 건너뛴다.
- **기간**: 올해 회계연도(`GET_CURRENT_YEAR`)의 ANLC 행. 기간은 화면 값, 0이면 ANLC-PERAF, 없으면 현재 전기 기간(S/4HANA ANLC 호환 뷰에는 PERAF가 없다). ANLC 필드는 모두 이름으로 읽어 릴리스 차이에 깨지지 않는다. ANLC 행이 없는 자산(신규·연초 상각 전)은 금액 0으로 보낸다(T30). 연초 연도 마감(AJAB/AJRW) 전에는 새 해 ANLC 행이 없어 0이 나갈 수 있으므로 연초에는 값을 확인한다.
- **산식(D-06 초안)**: 취득가 = KANSW + ANSWL, 감가상각누계 = KNAFA + NAFAG(음수), 장부가 = 두 값의 합. AW01N과 다르면 ZALM_CFG에 `AA02_DEP_EXTRA`(여러 행, LOW = ANLC 필드명, 예: `KMAFA`, `MAFAG`(계획외), `KSAFA`, `SAFAG`(특별))를 넣어 누계에 더한다. 코드 수정 없이 맞출 수 있다(ZALM_IF_CONFIG로 입력).
- **내용연수·상각키**: ANLB(영역 01, 오늘 유효한 행)의 NDJAR·NDPER·AFASL.
- **취득 출처(origins, P_ORIG 기본 켬)**: 각 자산 레코드에 `origins[]`를 실어 PO와 AuC 정산 출처를 보낸다(PO는 따로 보내지 않고 가액과 함께).
  - DIRECT = 그 자산에 계정지정된 PO(EKKN-ANLN1/ANLN2, 삭제 표시 제외, EKKO-LIFNR·BEDAT, LFA1-NAME1).
  - AUC = AuC 정산으로 취득한 자산. ZALM_CFG `AUC_CLASS`(여러 행, AuC 자산클래스)의 자산이 올라간 자산 문서(ANEK-BELNR)에 같이 올라간 일반 자산을 찾아, 원천 AuC 번호와 그 AuC의 PO를 붙인다. AuC 자산 자체는 보내지 않는다. `AUC_CLASS`가 비면 AUC는 찾지 않고 경고.
  - 시험 실행은 앞 10건의 출처를 로그에 보인다. 원천 필드(EKKN·ANEK)가 릴리스에 따라 다르면 활성화·실행 때 드러난다(SE11 확인).
- **결과**: ZALM_IF_LOG(IF_ID `IF-AA-02`, 회사코드별 1행). 요약 `반영 a / 변경 없음 b / 오류 c`.
- **시험 순서**: ① 시험 실행(구성 확인, AW01N 대조) → ② 실제 송신 → ③ ALM 자산 상세의 금액 확인 → ④ 다시 실행해 전부 변경 없음인지 → ⑤ 연초 전 자산(ANLC 행 없음)이 0으로 들어오는지(T30) → ⑥ 마감 실행 후 다음 날 일일 실행이 마감 값을 덮지 않는지(T32). ⑦ PO 자산·AuC 정산 자산·PO 없는 자산의 출처가 ALM에 맞게 보이는지(T35~T37).

## 7.6 전기 잡 — ZALM_IF_POSTING (IF-AA-03 자산 생성 · IF-AA-04 자산 변경)

ALM에서 승인된 요청(READY)을 가져와 SAP에 전기한다. 이번 단계는 `ASSET_CREATE`·`ASSET_CHANGE`만 가져온다(`types` 필터). 나머지 유형은 READY로 남는다.

| 항목 | 내용 |
| --- | --- |
| 재고번호 | 기본은 SAP에 보내지 않음(자산클래스 화면 레이아웃이 입력 불가면 AY219). 보내려면 ZALM_CFG `SEND_INVNO` = `X`(SE38 ZALM_IF_CONFIG). 안 보내면 중복 확인은 자산명+클래스+사용자+승인일로 한다 |
| 위치·룸 | ALM의 사이트·룸은 SAP 위치(STORT)가 아니라 자산 설명 2행(GENERALDATA-DESCRIPT2)에 `Location: <사이트> \| Room: <룸>` 형식으로 보낸다(생성·변경 전기, v12). SAP 위치 마스터(T499S) 등록이 필요 없다 |
| 입력 불가 필드 | 자산클래스 화면 레이아웃이 입력 불가인 필드(AY219: Location, Serial number 등)는 ZALM_CFG `POST_SKIP`(여러 행, BAPI 필드 이름: `SERIAL_NO`, `LOCATION`, `ROOM`, `INVENT_NO`)에 넣으면 보내지 않는다. 정식 해결은 OAOA 화면 레이아웃에서 선택 입력으로 바꾸는 것 |
| 폐기(IF-AA-06) | ASSET_RETIRE: BAPI_ASSET_RETIREMENT_POST를 인터페이스(FUPARAREF)에 맞춰 호출(구조형 GENERALPOSTINGDATA 또는 단일 파라미터). 거래유형은 ZALM_MAP `RETIRE_TT`(SCRAP·LOSS 등록 필요, SCRAP=200 DEV 확인). 매각(SALE)은 v14부터 지원(D-05: 고객 계정 없이 수익만): RETIRE_TT에 SALE=210(Retirement with revenue, DEV) 등록, RETIREMENTDATA-REV_ON_RET에 매각금액·CURRENCY에 회사 통화(T001-WAERS)를 넣고 구조 필드 목록을 로그에 찍는다. 부분 폐기는 미지원으로 FAILED. 전표번호는 BAPI 문서 참조(AWTYP·AWKEY)→BKPF, 없으면 BKTXT=postingId로 찾아 `sapDocument`로 회신. 이미 같은 BKTXT 전표가 있으면 BAPI를 다시 부르지 않는다. 로그 첫 줄에 BAPI 인터페이스를 찍는다(시험 실행에서도) |
| 실사 결과(IF-AA-07) | COUNT_RESULT: BAPI_FIXEDASSET_CHANGE의 INVENTORY·INVENTORYX(실사일·메모, 필드명은 후보를 차례로 찾고 구조 필드 목록을 로그에 찍음). 전표 없음 → sapDocument 없이 POSTED 회신. 값이 모두 비면 변경 없음으로 POSTED. TESTRUN이 없어 시험 실행은 입력 점검까지만 |
| 실행 | SE38 `ZALM_IF_POSTING`. 회사코드는 비우면 ZALM_CFG `BUKRS`. 15분 간격 잡(7.9 SM36)으로 돌리는 것이 목표 |
| 파라미터 | P_MAX 한 번에 가져올 건수(기본 50, 최대 200), P_TEST BAPI TESTRUN(커밋·로그·회신 없음) |
| P_TEST 주의 | claim은 하므로 그 건은 15분 뒤 다시 대상이 되고 ALM의 시도 횟수(최대 5)가 1 오른다. 시험은 적은 건수로 |
| POST_BLOCK | ZALM_CFG `POST_BLOCK = X`이면 claim하지 않고 건너뜀(월말 마감) |
| 중복 방지 | ① 같은 postingId가 ZALM_IF_LOG에 POSTED면 BAPI를 다시 부르지 않고 회신만 ② 생성은 ANLA(BUKRS·INVNR·ANLKL·ERNAM = 실행 사용자·ERDAT ≥ 승인일 −1·DEAKT 없음)로 이미 만들어졌는지 확인 |
| 커밋 순서 | RETURN에 E·A가 없으면 ZALM_IF_LOG(POSTED)를 먼저 쓰고 `BAPI_TRANSACTION_COMMIT`(WAIT). 실패는 ROLLBACK 후 FAILED 로그와 회신 |
| 회신 | `POST /sap/postings/{id}/result`, Idempotency-Key = `postingId-attempt`. 실패한 회신은 같은 실행 끝에 다시 보냄(최근 7일, 키 `postingId-R<시각>`) |
| BAPI 호출 | `CALL FUNCTION … PARAMETER-TABLE`로 부르고 구조·필드를 이름으로 채운다. 구조 이름(BAPI1022_FEGLG001·002·003 등)이나 필드가 이 릴리스에 없으면 그 건이 FAILED로 끝나고 메시지에 이름이 나온다 → SE37·SE11 확인(D-13) |
| 변경의 제한 | 값을 비우는 변경은 미지원(빈 값 = 변경 없음). 코스트센터 유효시작일이 미래면 D-03 결정 전이라 FAILED |

**시험 순서**: ① ALM에서 자산 생성 요청을 만들고 2단계 승인(전기 대기 READY) → ② ZALM_IF_POSTING을 P_TEST로 실행해 BAPI 오류가 없는지(구조·필드명 확인) → ③ 실제 실행: 자산번호가 SAP(AS03)에 생기고 ALM 요청이 POSTED가 되는지 → ④ 같은 건을 다시 실행해도 새 자산이 안 생기는지(POSTED 로그) → ⑤ ALM에서 자산명·시리얼·룸을 바꾼 변경 요청이 SAP에 반영되는지(IF-AA-04) → ⑥ 필수 값이 빠진 건이 FAILED로 돌아와 ALM이 POST_ERROR가 되는지.

## 문법 검사(개발용)

`abaplint.json`(SAP_BASIS 7.50 문법, Z 네임스페이스만 엄격히). 표준 객체 정의는 `abaplint/deps`를 `/deps`에 받아 둔 곳에서 `npx @abaplint/cli abaplint.json`.

DDIC XML은 `../tools/gen_ddic.py`에서 만든다(테이블·메시지 클래스를 고치면 다시 실행).


## 7.8 IF-RC-01 대사 스냅샷 (변형 RC01)

같은 프로그램 `ZALM_IF_MASTER_SEND`, **변형 RC01**. `POST /sap/reconciliation`에 5,000건씩 보낸다(마지막 분할 isLast).

| 화면 | 값 |
|---|---|
| 변형 | RC01 |
| 회사코드 | S_BUKRS(비우면 ZALM_CFG BUKRS) |
| 캠페인 코드 P_CAMP | 비우면 주간(WEEKLY), 넣으면 실사 종료 대사(CAMPAIGN, 6자) |
| 요청번호 P_REQ | ALM 화면 IF-OP-01 요청이면 그 번호 |

- 대상: 삭제 표시 아닌 자산, 비활성일이 없거나 최근 12개월 이내. 코스트센터는 오늘 유효한 ANLZ 행
- 보내는 값: 자산번호, INVNR, SERNR, KOSTL, DEAKT, 설명2(ANLA-TXA50, `Location: .. | Room: ..`)
- 위치 차이(LOCATION)는 ALM 위치·룸으로 만든 설명2와 SAP 설명2를 비교한다(D-09)
- 차이 계산은 ALM이 비동기로 한다. 결과는 ALM 대사 화면에서 확인
- 시험 실행(P_DRY)은 건수만 로그에 남기고 보내지 않는다
- **필요한 ALM 서버 버전**: 설명2 필드(migration 0014)가 DEV에 배포돼 있어야 한다


## 7.9 잡 스케줄·운영 모니터

잡 구성·SM36 등록 절차·변형·장애 대응은 프로젝트 문서 `15_SAP_잡_스케줄_런북.md`. 요약:

- ZALM_POSTING_15M(15분): `ZALM_IF_RUNREQ` → `ZALM_IF_POSTING`
- ZALM_MD01_DAILY 05:30 · ZALM_AA01_DAILY 05:40 · ZALM_AA02_DAILY 05:50: `ZALM_IF_MASTER_SEND` 변형 Z_MD01·Z_AA01·Z_AA02
- ZALM_RECON_WEEKLY 월 07:00: 변형 Z_RC01
- 아침 점검: `ZALM_IF_MONITOR`

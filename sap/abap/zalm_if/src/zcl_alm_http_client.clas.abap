"! ALM API 클라이언트. 08 명세서 4.3·4.4, 13 런북 7-2(2026-10-21 결정)
"! - SM59 ZALM_API(유형 G, 경로 접두어 = ALM API)로 ALM API 호출
"! - 토큰: SM59 ZALM_TOKEN(기본 인증 사용자 = 연결 별칭, 비밀번호 = 클라이언트 비밀)에
"!   grant_type=client_credentials&scope=sap.api를 보내 받는다. 비밀은 SM59(보안 저장소)에만 있고 코드·테이블에 두지 않는다.
"!   만료 5분 전까지 메모리에 둔다(실행 단위). 시험용으로 set_credentials( )를 부르면 ZALM_API로 직접 Basic 인증
"! - 헤더: Authorization, X-SAP-System(<SID>-<클라이언트>), X-Company-Code, X-Correlation-Id, Idempotency-Key
"! - 재시도: 통신 오류(0)·5xx·429는 1·2·4분(RETRY_WAIT_SEC × 2^n) 간격 3회, 401은 토큰을 새로 받아 한 번 더. 그 밖의 4xx는 재시도 없음
"! - 응답 대기: ZALM_CFG HTTP_TIMEOUT_SEC(기본 120초)
"! - 응답 207·200의 건별 결과(results)는 parse_batch( )로 읽는다
"! 호출·토큰·재시도는 PAS 공통 패키지(ZCL_PAS_HTTP·ZCL_PAS_TOKEN_DEST, 통합 WBS 7.3)가 한다. 이 클래스의 공개 메서드·결과 형식은 그대로다.
CLASS zcl_alm_http_client DEFINITION
  PUBLIC
  CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES:
      BEGIN OF ty_response,
        status   TYPE i,
        body     TYPE string,
        corr_id  TYPE string,
        attempts TYPE i,
      END OF ty_response,
      BEGIN OF ty_item_result,
        key     TYPE string,
        status  TYPE string,
        code    TYPE string,
        message TYPE string,
      END OF ty_item_result,
      tt_item_result TYPE STANDARD TABLE OF ty_item_result WITH EMPTY KEY,
      BEGIN OF ty_batch_result,
        batch_id  TYPE string,
        received  TYPE i,
        succeeded TYPE i,
        failed    TYPE i,
        results   TYPE tt_item_result,
      END OF ty_batch_result,
      BEGIN OF ty_problem,
        code   TYPE string,
        title  TYPE string,
        detail TYPE string,
      END OF ty_problem,
      BEGIN OF ty_chunk,
        chunk_no TYPE i,
        records  TYPE i,
        is_last  TYPE abap_bool,
        key      TYPE string,
        response TYPE ty_response,
        result   TYPE ty_batch_result,
      END OF ty_chunk,
      tt_chunk TYPE STANDARD TABLE OF ty_chunk WITH EMPTY KEY.

    CONSTANTS:
      c_dest_api   TYPE rfcdest VALUE 'ZALM_API',
      c_dest_token TYPE rfcdest VALUE 'ZALM_TOKEN',
      c_json       TYPE string VALUE 'application/json; charset=utf-8'.

    "! iv_retry_wait: 첫 재시도 대기(초). -1이면 ZALM_CFG RETRY_WAIT_SEC(기본 60). 대화 시험은 0 권장
    "! iv_timeout: 응답 대기(초). -1이면 ZALM_CFG HTTP_TIMEOUT_SEC(기본 120), 0이면 시스템 기본
    METHODS constructor
      IMPORTING
        iv_bukrs      TYPE bukrs
        iv_dest_api   TYPE rfcdest DEFAULT c_dest_api
        iv_dest_token TYPE rfcdest DEFAULT c_dest_token
        iv_retry_wait TYPE i DEFAULT -1
        iv_max_retry  TYPE i DEFAULT 3
        iv_timeout    TYPE i DEFAULT -1.

    "! 시험용: 클라이언트 ID·비밀을 직접 넣는다(SM59 ZALM_TOKEN 없이 ZALM_API로 토큰 요청). 운영은 쓰지 않는다
    METHODS set_credentials
      IMPORTING
        iv_client_id TYPE csequence
        iv_secret    TYPE csequence.

    METHODS get
      IMPORTING
        iv_path            TYPE csequence
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_alm.

    METHODS post
      IMPORTING
        iv_path            TYPE csequence
        iv_body            TYPE string
        iv_key             TYPE csequence OPTIONAL
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_alm.

    "! 레코드를 iv_chunk_size건씩 나눠 보낸다(08 4.3 분할·Idempotency-Key).
    "! - iv_type이 있으면 /sap/master-data 형식: {"batchId","type","chunkNo","isLast","records"}, 키 {batchId}-{type}-{chunkNo}
    "! - iv_chunked이면 {"batchId",<iv_head>,"chunkNo","isLast","records"}, 키 {batchId}-{chunkNo}
    "! - 그 밖은 {"batchId",<iv_head>,"records"}, 키 {batchId}-{chunkNo}
    "! iv_head: 본문 앞에 넣을 JSON 필드(예: "isFull":true). 레코드가 없어도 한 번(빈 records) 보낸다.
    "! 통신 오류·4xx(207 제외)·5xx가 나면 멈추고 그때까지의 분할을 돌려준다
    METHODS send_records
      IMPORTING
        iv_path          TYPE csequence
        iv_batch_id      TYPE csequence
        iv_type          TYPE csequence OPTIONAL
        iv_head          TYPE csequence OPTIONAL
        iv_chunked       TYPE abap_bool DEFAULT abap_false
        it_records       TYPE STANDARD TABLE
        iv_chunk_size    TYPE i
        iv_compress      TYPE abap_bool DEFAULT abap_true
      RETURNING
        VALUE(rt_chunks) TYPE tt_chunk
      RAISING
        zcx_alm.

    "! 액세스 토큰(캐시, 만료 5분 전 갱신)
    METHODS token
      IMPORTING
        iv_force        TYPE abap_bool DEFAULT abap_false
      RETURNING
        VALUE(rv_token) TYPE string
      RAISING
        zcx_alm.

    "! X-SAP-System 값: <SID>-<클라이언트>(예: S4H-100)
    METHODS system_id
      RETURNING
        VALUE(rv_id) TYPE string.

    "! /ui2/cl_json 직렬화(camelCase). iv_compress = abap_false면 0·빈 값도 보냄(금액 0 등, 08 4.3)
    CLASS-METHODS to_json
      IMPORTING
        is_data        TYPE any
        iv_compress    TYPE abap_bool DEFAULT abap_true
      RETURNING
        VALUE(rv_json) TYPE string.

    "! 수신 API 응답(BatchResult)
    CLASS-METHODS parse_batch
      IMPORTING
        iv_body          TYPE string
      RETURNING
        VALUE(rs_result) TYPE ty_batch_result.

    "! 오류 응답(problem+json)
    CLASS-METHODS parse_problem
      IMPORTING
        iv_body           TYPE string
      RETURNING
        VALUE(rs_problem) TYPE ty_problem.

    CLASS-METHODS new_corr_id
      RETURNING
        VALUE(rv_id) TYPE string.

    "! 재시도할 응답인지(통신 오류·5xx·429)
    CLASS-METHODS is_retryable
      IMPORTING
        iv_status    TYPE i
      RETURNING
        VALUE(rv_ok) TYPE abap_bool.

    CLASS-METHODS clear_token_cache.

  PRIVATE SECTION.
    "! 같은 세션에서 토큰을 나눠 쓰는 열쇠의 앞부분(PAS 공통 보관소)
    CONSTANTS c_cache_prefix TYPE string VALUE 'ALM|'.
    CONSTANTS c_cfg_timeout TYPE string VALUE 'HTTP_TIMEOUT_SEC'.
    CONSTANTS c_default_timeout TYPE i VALUE 120.

    DATA mv_dest_api TYPE rfcdest.
    DATA mv_dest_token TYPE rfcdest.
    DATA mv_bukrs TYPE bukrs.
    DATA mv_retry_wait TYPE i.
    DATA mv_max_retry TYPE i.
    DATA mv_timeout TYPE i.
    DATA mv_client_id TYPE string.
    DATA mv_secret TYPE string.
    DATA mo_token TYPE REF TO zcl_pas_token_dest.
    DATA mo_http TYPE REF TO zcl_pas_http.

    "! 토큰 공급자·HTTP 호출기를 만든다(생성자와 set_credentials 뒤)
    METHODS setup.

    METHODS execute
      IMPORTING
        iv_method          TYPE string
        iv_path            TYPE csequence
        iv_body            TYPE string OPTIONAL
        iv_key             TYPE csequence OPTIONAL
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_alm.

    "! PAS 공통 예외 → ZCX_ALM(예전과 같은 문구)
    METHODS raise_alm
      IMPORTING
        ix_pas TYPE REF TO zcx_pas_http
      RAISING
        zcx_alm.
ENDCLASS.



CLASS zcl_alm_http_client IMPLEMENTATION.

  METHOD constructor.
    mv_bukrs = iv_bukrs.
    mv_dest_api = iv_dest_api.
    mv_dest_token = iv_dest_token.
    mv_max_retry = iv_max_retry.
    IF iv_retry_wait >= 0.
      mv_retry_wait = iv_retry_wait.
    ELSE.
      mv_retry_wait = zcl_alm_cfg=>get_int( iv_param = zcl_alm_cfg=>c_retry_wait_sec iv_default = 60 ).
    ENDIF.
    IF iv_timeout >= 0.
      mv_timeout = iv_timeout.
    ELSE.
      mv_timeout = zcl_alm_cfg=>get_int( iv_param = c_cfg_timeout iv_default = c_default_timeout ).
    ENDIF.
    setup( ).
  ENDMETHOD.


  METHOD set_credentials.
    mv_client_id = iv_client_id.
    mv_secret = iv_secret.
    setup( ).
  ENDMETHOD.


  METHOD setup.
    DATA ls_token TYPE zcl_pas_token_dest=>ty_config.
    DATA ls_options TYPE zcl_pas_http=>ty_options.

    ls_token-scope = 'sap.api'.
    ls_token-margin_sec = 300.
    ls_token-max_retry = mv_max_retry.
    ls_token-retry_wait_sec = mv_retry_wait.
    ls_token-timeout_sec = mv_timeout.
    IF mv_client_id IS NOT INITIAL.
      " 시험: ZALM_API로 직접(HTTP Basic = client_secret_basic)
      ls_token-destination = mv_dest_api.
      ls_token-path = '/oauth/token'.
      ls_token-client_id = mv_client_id.
      ls_token-client_secret = mv_secret.
      ls_token-cache_key = |{ c_cache_prefix }{ mv_dest_api }\|{ mv_client_id }|.
    ELSE.
      " 운영: SM59 ZALM_TOKEN의 기본 인증(사용자 = 연결 별칭, 비밀번호 = 비밀)을 SAP이 붙인다
      ls_token-destination = mv_dest_token.
      ls_token-cache_key = |{ c_cache_prefix }{ mv_dest_api }\|{ mv_dest_token }|.
    ENDIF.
    mo_token = NEW #( ls_token ).

    ls_options-timeout_sec = mv_timeout.
    ls_options-max_retry = mv_max_retry.
    ls_options-retry_wait_sec = mv_retry_wait.
    ls_options-request_id_header = 'X-Correlation-Id'.
    ls_options-raise_on_error = abap_false.
    mo_http = zcl_pas_http=>create( iv_dest = mv_dest_api io_token = mo_token is_options = ls_options ).
  ENDMETHOD.


  METHOD system_id.
    rv_id = |{ sy-sysid }-{ sy-mandt }|.
  ENDMETHOD.


  METHOD get.
    rs_response = execute( iv_method = 'GET' iv_path = iv_path ).
  ENDMETHOD.


  METHOD post.
    rs_response = execute( iv_method = 'POST' iv_path = iv_path iv_body = iv_body iv_key = iv_key ).
  ENDMETHOD.


  METHOD execute.
    DATA lt_headers TYPE tihttpnvp.
    DATA ls_response TYPE zcl_pas_http=>ty_response.
    DATA lx_pas TYPE REF TO zcx_pas_http.

    rs_response-corr_id = new_corr_id( ).
    APPEND VALUE #( name = 'X-SAP-System' value = system_id( ) ) TO lt_headers.
    APPEND VALUE #( name = 'X-Company-Code' value = mv_bukrs ) TO lt_headers.
    APPEND VALUE #( name = 'Accept' value = 'application/json' ) TO lt_headers.
    IF iv_key IS NOT INITIAL.
      APPEND VALUE #( name = 'Idempotency-Key' value = iv_key ) TO lt_headers.
    ENDIF.

    TRY.
        ls_response = mo_http->execute( iv_method       = iv_method
                                        iv_uri          = CONV #( iv_path )
                                        it_headers      = lt_headers
                                        iv_body_c       = iv_body
                                        iv_content_type = c_json
                                        iv_request_id   = rs_response-corr_id ).
        rs_response-status = ls_response-status.
        rs_response-body = ls_response-body_c.
        rs_response-attempts = ls_response-attempts.
      CATCH zcx_pas_http INTO lx_pas.
        IF lx_pas->stage = zcx_pas_http=>c_stage-call AND lx_pas->kind = zcx_pas_http=>c_kind-network.
          " 통신 오류는 예외가 아니라 상태 0으로 돌려준다(재시도를 다 쓴 뒤 — 호출한 프로그램이 로그를 남기고 판단)
          rs_response-status = 0.
          rs_response-body = |통신 오류({ lx_pas->comm_code }): { lx_pas->comm_message }|.
          rs_response-attempts = lx_pas->attempts.
        ELSE.
          raise_alm( lx_pas ).
        ENDIF.
    ENDTRY.
  ENDMETHOD.


  METHOD token.
    DATA lx_pas TYPE REF TO zcx_pas_http.

    TRY.
        rv_token = mo_token->get_token( iv_force ).
      CATCH zcx_pas_http INTO lx_pas.
        raise_alm( lx_pas ).
    ENDTRY.
  ENDMETHOD.


  METHOD raise_alm.
    DATA ls_problem TYPE ty_problem.

    CASE ix_pas->kind.
      WHEN zcx_pas_http=>c_kind-config.
        zcx_alm=>raise( |SM59 연결 { ix_pas->destination }을(를) 열 수 없습니다(sy-subrc { ix_pas->rc }). SM59 설정을 확인하세요| ).
      WHEN zcx_pas_http=>c_kind-bad_response.
        zcx_alm=>raise( iv_text = |토큰 응답에 access_token이 없습니다: { ix_pas->body }| iv_http_status = ix_pas->http_status ).
      WHEN zcx_pas_http=>c_kind-network.
        " 토큰 받기의 통신 오류(재시도를 다 쓴 뒤)
        zcx_alm=>raise( iv_text = |토큰 발급 실패 HTTP 0: 통신 오류({ ix_pas->comm_code }): { ix_pas->comm_message }| ).
      WHEN OTHERS.
        ls_problem = parse_problem( ix_pas->body ).
        zcx_alm=>raise( iv_text = |토큰 발급 실패 HTTP { ix_pas->http_status }: { COND string( WHEN ls_problem-detail IS NOT INITIAL
                                                                                    THEN ls_problem-detail ELSE ix_pas->body ) }|
                        iv_http_status = ix_pas->http_status ).
    ENDCASE.
  ENDMETHOD.


  METHOD send_records.
    DATA lr_chunk TYPE REF TO data.
    DATA lv_no TYPE i.
    DATA lv_from TYPE i VALUE 1.
    DATA lv_to TYPE i.
    DATA lv_body TYPE string.
    DATA lv_head TYPE string.
    DATA ls_chunk TYPE ty_chunk.
    FIELD-SYMBOLS <lt_chunk> TYPE STANDARD TABLE.

    IF iv_chunk_size <= 0.
      zcx_alm=>raise( 'send_records: iv_chunk_size는 1 이상' ).
    ENDIF.
    CREATE DATA lr_chunk LIKE it_records.
    ASSIGN lr_chunk->* TO <lt_chunk>.
    DATA(lv_total) = lines( it_records ).
    lv_head = COND #( WHEN iv_head IS NOT INITIAL THEN |{ iv_head },| ).

    DO.
      lv_no = lv_no + 1.
      lv_to = lv_from + iv_chunk_size - 1.
      CLEAR <lt_chunk>.
      LOOP AT it_records ASSIGNING FIELD-SYMBOL(<ls_rec>) FROM lv_from TO lv_to.
        APPEND <ls_rec> TO <lt_chunk>.
      ENDLOOP.
      lv_from = lv_to + 1.

      CLEAR ls_chunk.
      ls_chunk-chunk_no = lv_no.
      ls_chunk-records = lines( <lt_chunk> ).
      ls_chunk-is_last = xsdbool( lv_from > lv_total ).
      DATA(lv_json) = to_json( is_data = <lt_chunk> iv_compress = iv_compress ).
      IF lv_json IS INITIAL OR lv_json = 'null'.
        lv_json = '[]'.
      ENDIF.
      DATA(lv_last) = COND string( WHEN ls_chunk-is_last = abap_true THEN `true` ELSE `false` ).

      IF iv_type IS NOT INITIAL.
        lv_body = |\{"batchId":"{ iv_batch_id }","type":"{ iv_type }","chunkNo":{ lv_no },"isLast":{ lv_last },"records":{ lv_json }\}|.
        ls_chunk-key = |{ iv_batch_id }-{ iv_type }-{ lv_no }|.
      ELSEIF iv_chunked = abap_true.
        lv_body = |\{"batchId":"{ iv_batch_id }",{ lv_head }"chunkNo":{ lv_no },"isLast":{ lv_last },"records":{ lv_json }\}|.
        ls_chunk-key = |{ iv_batch_id }-{ lv_no }|.
      ELSE.
        lv_body = |\{"batchId":"{ iv_batch_id }",{ lv_head }"records":{ lv_json }\}|.
        ls_chunk-key = |{ iv_batch_id }-{ lv_no }|.
      ENDIF.

      ls_chunk-response = post( iv_path = iv_path iv_body = lv_body iv_key = ls_chunk-key ).
      IF ls_chunk-response-status = 200 OR ls_chunk-response-status = 202 OR ls_chunk-response-status = 207.
        ls_chunk-result = parse_batch( ls_chunk-response-body ).
      ENDIF.
      APPEND ls_chunk TO rt_chunks.

      IF ls_chunk-is_last = abap_true
         OR ls_chunk-response-status = 0
         OR ( ls_chunk-response-status >= 400 ).
        EXIT.
      ENDIF.
    ENDDO.
  ENDMETHOD.


  METHOD to_json.
    rv_json = /ui2/cl_json=>serialize( data = is_data
                                       compress = iv_compress
                                       pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
  ENDMETHOD.


  METHOD parse_batch.
    /ui2/cl_json=>deserialize( EXPORTING json = iv_body
                                         pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                               CHANGING  data = rs_result ).
  ENDMETHOD.


  METHOD parse_problem.
    rs_problem = CORRESPONDING #( zcl_pas_problem=>parse( iv_body ) ).
  ENDMETHOD.


  METHOD new_corr_id.
    rv_id = zcl_pas_http=>new_request_id( ).
  ENDMETHOD.


  METHOD is_retryable.
    rv_ok = zcl_pas_problem=>is_retryable( iv_status ).
  ENDMETHOD.


  METHOD clear_token_cache.
    zcl_pas_token_dest=>clear_cache( c_cache_prefix ).
  ENDMETHOD.

ENDCLASS.

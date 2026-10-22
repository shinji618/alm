"! ALM API 클라이언트. 08 명세서 4.3·4.4, 13 런북 7-2(2026-10-21 결정)
"! - SM59 ZALM_API(유형 G, 경로 접두어 /api/v1, SSL)로 ALM API 호출
"! - 토큰: SM59 ZALM_TOKEN(경로 /api/v1/oauth/token, 기본 인증 사용자 = ALM 연결 별칭, 비밀번호 = 클라이언트 비밀)에
"!   grant_type=client_credentials&scope=sap.api를 보내 받는다. 비밀은 SM59(보안 저장소)에만 있고 코드·테이블에 두지 않는다.
"!   만료 5분 전까지 메모리에 둔다(실행 단위). 시험용으로 set_credentials( )를 부르면 ZALM_API로 직접 Basic 인증
"! - 헤더: Authorization, X-SAP-System(<SID>-<클라이언트>), X-Company-Code, X-Correlation-Id, Idempotency-Key
"! - 재시도: 통신 오류(0)·5xx·429는 1·2·4분(RETRY_WAIT_SEC × 2^n) 간격 3회, 401은 토큰을 새로 받아 한 번 더. 그 밖의 4xx는 재시도 없음
"! - 응답 207·200의 건별 결과(results)는 parse_batch( )로 읽는다
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
    METHODS constructor
      IMPORTING
        iv_bukrs      TYPE bukrs
        iv_dest_api   TYPE rfcdest DEFAULT c_dest_api
        iv_dest_token TYPE rfcdest DEFAULT c_dest_token
        iv_retry_wait TYPE i DEFAULT -1
        iv_max_retry  TYPE i DEFAULT 3.

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
    TYPES:
      BEGIN OF ty_token,
        dest    TYPE rfcdest,
        client  TYPE string,
        token   TYPE string,
        expires TYPE timestamp,
      END OF ty_token.

    CLASS-DATA gt_tokens TYPE STANDARD TABLE OF ty_token WITH EMPTY KEY.

    DATA mv_dest_api TYPE rfcdest.
    DATA mv_dest_token TYPE rfcdest.
    DATA mv_bukrs TYPE bukrs.
    DATA mv_retry_wait TYPE i.
    DATA mv_max_retry TYPE i.
    DATA mv_client_id TYPE string.
    DATA mv_secret TYPE string.

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

    "! 한 번 호출. SM59 연결을 못 열면 예외, 통신 오류는 ev_status = 0
    METHODS call
      IMPORTING
        iv_dest        TYPE rfcdest
        iv_method      TYPE string
        iv_path        TYPE csequence OPTIONAL
        iv_ctype       TYPE string
        iv_body        TYPE string OPTIONAL
        it_headers     TYPE tihttpnvp OPTIONAL
      EXPORTING
        ev_status      TYPE i
        ev_body        TYPE string
        ev_retry_after TYPE i
      RAISING
        zcx_alm.

    METHODS wait_before_retry
      IMPORTING
        iv_attempt     TYPE i
        iv_retry_after TYPE i.
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
  ENDMETHOD.


  METHOD set_credentials.
    mv_client_id = iv_client_id.
    mv_secret = iv_secret.
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
    DATA lv_retry_after TYPE i.
    DATA lv_refreshed TYPE abap_bool.

    rs_response-corr_id = new_corr_id( ).
    DO.
      rs_response-attempts = rs_response-attempts + 1.
      CLEAR lt_headers.
      APPEND VALUE #( name = 'Authorization' value = |Bearer { token( ) }| ) TO lt_headers.
      APPEND VALUE #( name = 'X-SAP-System' value = system_id( ) ) TO lt_headers.
      APPEND VALUE #( name = 'X-Company-Code' value = mv_bukrs ) TO lt_headers.
      APPEND VALUE #( name = 'X-Correlation-Id' value = rs_response-corr_id ) TO lt_headers.
      APPEND VALUE #( name = 'Accept' value = 'application/json' ) TO lt_headers.
      IF iv_key IS NOT INITIAL.
        APPEND VALUE #( name = 'Idempotency-Key' value = iv_key ) TO lt_headers.
      ENDIF.

      call( EXPORTING iv_dest = mv_dest_api iv_method = iv_method iv_path = iv_path iv_ctype = c_json
                      iv_body = iv_body it_headers = lt_headers
            IMPORTING ev_status = rs_response-status ev_body = rs_response-body ev_retry_after = lv_retry_after ).

      " 401: 토큰이 만료·폐기됐을 수 있다 → 한 번만 새로 받아 다시(횟수에 넣지 않음)
      IF rs_response-status = 401 AND lv_refreshed = abap_false.
        lv_refreshed = abap_true.
        token( iv_force = abap_true ).
        rs_response-attempts = rs_response-attempts - 1.
        CONTINUE.
      ENDIF.
      IF is_retryable( rs_response-status ) = abap_false OR rs_response-attempts > mv_max_retry.
        EXIT.
      ENDIF.
      wait_before_retry( iv_attempt = rs_response-attempts iv_retry_after = lv_retry_after ).
    ENDDO.
  ENDMETHOD.


  METHOD token.
    DATA lv_client TYPE string.
    DATA lv_status TYPE i.
    DATA lv_body TYPE string.
    DATA lv_retry_after TYPE i.
    DATA lv_expires_in TYPE string.
    DATA lv_now TYPE timestamp.
    DATA lt_headers TYPE tihttpnvp.
    DATA lv_attempt TYPE i.
    DATA ls_token TYPE ty_token.

    lv_client = COND #( WHEN mv_client_id IS NOT INITIAL THEN mv_client_id ELSE mv_dest_token ).
    GET TIME STAMP FIELD lv_now.
    IF iv_force = abap_false.
      READ TABLE gt_tokens INTO ls_token WITH KEY dest = mv_dest_api client = lv_client.
      IF sy-subrc = 0 AND ls_token-expires > lv_now.
        rv_token = ls_token-token.
        RETURN.
      ENDIF.
    ENDIF.
    DELETE gt_tokens WHERE dest = mv_dest_api AND client = lv_client.

    DATA(lv_form) = `grant_type=client_credentials&scope=sap.api`.
    DO.
      lv_attempt = lv_attempt + 1.
      IF mv_client_id IS NOT INITIAL.
        " 시험: ZALM_API로 직접(HTTP Basic = client_secret_basic)
        CLEAR lt_headers.
        APPEND VALUE #( name = 'Authorization'
                        value = |Basic { cl_http_utility=>encode_base64( unencoded = |{ mv_client_id }:{ mv_secret }| ) }| ) TO lt_headers.
        call( EXPORTING iv_dest = mv_dest_api iv_method = 'POST' iv_path = '/oauth/token' iv_ctype = 'application/x-www-form-urlencoded'
                        iv_body = lv_form it_headers = lt_headers
              IMPORTING ev_status = lv_status ev_body = lv_body ev_retry_after = lv_retry_after ).
      ELSE.
        " 운영: SM59 ZALM_TOKEN의 기본 인증(사용자 = 연결 별칭, 비밀번호 = 비밀)을 SAP이 붙인다
        call( EXPORTING iv_dest = mv_dest_token iv_method = 'POST' iv_ctype = 'application/x-www-form-urlencoded' iv_body = lv_form
              IMPORTING ev_status = lv_status ev_body = lv_body ev_retry_after = lv_retry_after ).
      ENDIF.
      IF is_retryable( lv_status ) = abap_false OR lv_attempt > mv_max_retry.
        EXIT.
      ENDIF.
      wait_before_retry( iv_attempt = lv_attempt iv_retry_after = lv_retry_after ).
    ENDDO.

    IF lv_status <> 200.
      DATA(ls_problem) = parse_problem( lv_body ).
      zcx_alm=>raise( iv_text = |토큰 발급 실패 HTTP { lv_status }: { COND string( WHEN ls_problem-detail IS NOT INITIAL
                                                                           THEN ls_problem-detail ELSE lv_body ) }|
                      iv_http_status = lv_status ).
    ENDIF.
    FIND REGEX '"access_token"\s*:\s*"([^"]+)"' IN lv_body SUBMATCHES rv_token.
    FIND REGEX '"expires_in"\s*:\s*(\d+)' IN lv_body SUBMATCHES lv_expires_in.
    IF rv_token IS INITIAL.
      zcx_alm=>raise( iv_text = |토큰 응답에 access_token이 없습니다: { lv_body }| iv_http_status = lv_status ).
    ENDIF.
    IF lv_expires_in IS INITIAL OR lv_expires_in CN '0123456789'.
      lv_expires_in = '3600'.
    ENDIF.
    ls_token-dest = mv_dest_api.
    ls_token-client = lv_client.
    ls_token-token = rv_token.
    ls_token-expires = cl_abap_tstmp=>add( tstmp = lv_now secs = nmax( val1 = 60 val2 = CONV i( lv_expires_in ) - 300 ) ).
    APPEND ls_token TO gt_tokens.
  ENDMETHOD.


  METHOD call.
    DATA lo_http TYPE REF TO if_http_client.
    DATA lv_msg TYPE string.
    DATA lv_code TYPE i.
    DATA lv_ra TYPE string.

    CLEAR: ev_status, ev_body, ev_retry_after.
    cl_http_client=>create_by_destination(
      EXPORTING
        destination              = iv_dest
      IMPORTING
        client                   = lo_http
      EXCEPTIONS
        argument_not_found       = 1
        destination_not_found    = 2
        destination_no_authority = 3
        plugin_not_active        = 4
        internal_error           = 5
        OTHERS                   = 6 ).
    IF sy-subrc <> 0.
      zcx_alm=>raise( |SM59 연결 { iv_dest }을(를) 열 수 없습니다(sy-subrc { sy-subrc }). SM59 설정을 확인하세요| ).
    ENDIF.
    lo_http->propertytype_logon_popup = if_http_client=>co_disabled.
    lo_http->request->set_method( iv_method ).
    IF iv_path IS NOT INITIAL.
      cl_http_utility=>set_request_uri( request = lo_http->request uri = CONV string( iv_path ) ).
    ENDIF.
    lo_http->request->set_header_field( name = 'Content-Type' value = iv_ctype ).
    LOOP AT it_headers INTO DATA(ls_h).
      lo_http->request->set_header_field( name = ls_h-name value = ls_h-value ).
    ENDLOOP.
    IF iv_body IS NOT INITIAL.
      lo_http->request->set_cdata( iv_body ).
    ENDIF.

    lo_http->send( EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc = 0.
      lo_http->receive( EXCEPTIONS OTHERS = 1 ).
    ENDIF.
    IF sy-subrc <> 0.
      lo_http->get_last_error( IMPORTING code = lv_code message = lv_msg ).
      ev_status = 0.
      ev_body = |통신 오류({ lv_code }): { lv_msg }|.
      lo_http->close( ).
      RETURN.
    ENDIF.
    lo_http->response->get_status( IMPORTING code = ev_status ).
    ev_body = lo_http->response->get_cdata( ).
    lv_ra = lo_http->response->get_header_field( 'retry-after' ).
    IF lv_ra IS NOT INITIAL AND lv_ra CO '0123456789'.
      ev_retry_after = lv_ra.
    ENDIF.
    lo_http->close( ).
  ENDMETHOD.


  METHOD wait_before_retry.
    DATA lv_wait TYPE i.
    lv_wait = mv_retry_wait.
    DO iv_attempt - 1 TIMES.
      lv_wait = lv_wait * 2.
    ENDDO.
    lv_wait = nmax( val1 = lv_wait val2 = iv_retry_after ).
    IF lv_wait > 0.
      WAIT UP TO lv_wait SECONDS.
    ENDIF.
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
    IF iv_body IS INITIAL OR iv_body(1) <> '{'.
      rs_problem-detail = iv_body.
      RETURN.
    ENDIF.
    /ui2/cl_json=>deserialize( EXPORTING json = iv_body
                                         pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                               CHANGING  data = rs_problem ).
  ENDMETHOD.


  METHOD new_corr_id.
    TRY.
        rv_id = to_lower( cl_system_uuid=>create_uuid_c36_static( ) ).
      CATCH cx_uuid_error.
        rv_id = |{ sy-datum }{ sy-uzeit }{ sy-uname }|.
    ENDTRY.
  ENDMETHOD.


  METHOD is_retryable.
    rv_ok = xsdbool( iv_status = 0 OR iv_status = 429 OR iv_status >= 500 ).
  ENDMETHOD.


  METHOD clear_token_cache.
    CLEAR gt_tokens.
  ENDMETHOD.

ENDCLASS.

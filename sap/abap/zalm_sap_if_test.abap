*&---------------------------------------------------------------------*
*& ZALM_SAP_IF_TEST - ALM 수신 API 시험(IF-MD-01, IF-AA-01, IF-AA-02)
*&   WBS 4.7 DEV 확인용. 운영 송신 프로그램(ZALM_IF_MASTER_SEND, 7.x)이
*&   나오기 전까지 실제 SAP 데이터를 소량 보내 응답(200/207)을 확인한다.
*&   - 토큰: POST /oauth/token (client_credentials, Basic)
*&   - MD01: COMPANY → PROFIT_CENTER → COST_CENTER → ASSET_CLASS
*&           (유형별 전체 송신, 마지막 분할 isLast=true → ALM에서 없는 코드 비활성)
*&   - AA01: 회사코드의 자산 P_MAX건(ANLA + ANLZ)
*&   - AA02: 위 자산의 회계연도 금액(ANLC, 상각영역 01) - 시험용 단순 계산
*&   clientId·비밀은 화면 입력(SM59 사용자 필드 12자 제한, 13 런북 7-2)
*&---------------------------------------------------------------------*
REPORT zalm_sap_if_test.

PARAMETERS: p_dest  TYPE rfcdest DEFAULT 'ZALM_DEV' OBLIGATORY,
            p_sys   TYPE char10 DEFAULT 'S4H-100' OBLIGATORY,
            p_cid   TYPE char64 LOWER CASE OBLIGATORY,
            p_sec   TYPE char128 LOWER CASE OBLIGATORY MODIF ID sec,
            p_bukrs TYPE bukrs DEFAULT '1000' OBLIGATORY,
            p_max   TYPE i DEFAULT 20,
            p_gjahr TYPE gjahr.
SELECTION-SCREEN SKIP.
PARAMETERS: p_md  AS CHECKBOX DEFAULT 'X',
            p_aa1 AS CHECKBOX DEFAULT 'X',
            p_aa2 AS CHECKBOX DEFAULT 'X'.

TYPES: ty_amount TYPE p LENGTH 15 DECIMALS 2.
TYPES: BEGIN OF ty_company,
         company_code TYPE string,
         name         TYPE string,
         currency     TYPE string,
       END OF ty_company,
       BEGIN OF ty_pc,
         controlling_area TYPE string,
         profit_center    TYPE string,
         name             TYPE string,
         segment          TYPE string,
       END OF ty_pc,
       BEGIN OF ty_cc,
         controlling_area TYPE string,
         cost_center      TYPE string,
         name             TYPE string,
         company_code     TYPE string,
         profit_center    TYPE string,
         responsible      TYPE string,
         valid_from       TYPE string,
         valid_to         TYPE string,
       END OF ty_cc,
       BEGIN OF ty_class,
         asset_class TYPE string,
         name        TYPE string,
       END OF ty_class,
       BEGIN OF ty_asset,
         company_code    TYPE string,
         asset_no        TYPE string,
         sub_no          TYPE string,
         asset_class     TYPE string,
         description     TYPE string,
         serial_no       TYPE string,
         inventory_no    TYPE string,
         cap_date        TYPE string,
         deact_date      TYPE string,
         last_count_date TYPE string,
         inventory_note  TYPE string,
         cost_center     TYPE string,
         profit_center   TYPE string,
         plant           TYPE string,
         location        TYPE string,
         room            TYPE string,
         changed_at      TYPE string,
       END OF ty_asset,
       BEGIN OF ty_value,
         company_code        TYPE string,
         asset_no            TYPE string,
         sub_no              TYPE string,
         fiscal_year         TYPE i,
         period              TYPE i,
         dep_area            TYPE string,
         acquisition_value   TYPE ty_amount,
         accum_depreciation  TYPE ty_amount,
         net_book_value      TYPE ty_amount,
         useful_life_years   TYPE i,
         useful_life_periods TYPE i,
         dep_key             TYPE string,
       END OF ty_value.

*----------------------------------------------------------------------*
CLASS lcl_api DEFINITION.
  PUBLIC SECTION.
    METHODS constructor IMPORTING iv_dest TYPE rfcdest iv_sys TYPE csequence iv_bukrs TYPE bukrs.
    METHODS token IMPORTING iv_id TYPE csequence iv_secret TYPE csequence RETURNING VALUE(rv_ok) TYPE abap_bool.
    "! 레코드를 iv_size건씩 나눠 보낸다. iv_type이 있으면 /sap/master-data 형식
    METHODS send IMPORTING iv_path TYPE string iv_type TYPE string OPTIONAL iv_batch TYPE string
                           it_recs TYPE STANDARD TABLE iv_size TYPE i iv_compress TYPE abap_bool DEFAULT abap_true.
  PRIVATE SECTION.
    DATA: mv_dest TYPE rfcdest, mv_sys TYPE string, mv_bukrs TYPE string, mv_token TYPE string.
    METHODS call IMPORTING iv_path TYPE string iv_ctype TYPE string iv_body TYPE string it_headers TYPE tihttpnvp
                 EXPORTING ev_status TYPE i ev_body TYPE string.
    METHODS out IMPORTING iv_text TYPE string.
ENDCLASS.

CLASS lcl_api IMPLEMENTATION.
  METHOD constructor.
    mv_dest = iv_dest. mv_sys = iv_sys. mv_bukrs = iv_bukrs.
  ENDMETHOD.

  METHOD call.
    DATA: lo_http TYPE REF TO if_http_client,
          lv_msg  TYPE string.
    cl_http_client=>create_by_destination( EXPORTING destination = mv_dest IMPORTING client = lo_http
                                           EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc <> 0.
      ev_status = 0. ev_body = |SM59 { mv_dest } 연결을 만들 수 없습니다|. RETURN.
    ENDIF.
    lo_http->request->set_method( 'POST' ).
    cl_http_utility=>set_request_uri( request = lo_http->request uri = iv_path ).
    lo_http->request->set_header_field( name = 'Content-Type' value = iv_ctype ).
    LOOP AT it_headers INTO DATA(ls_h).
      lo_http->request->set_header_field( name = ls_h-name value = ls_h-value ).
    ENDLOOP.
    lo_http->request->set_cdata( iv_body ).
    lo_http->send( EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc = 0.
      lo_http->receive( EXCEPTIONS OTHERS = 1 ).
    ENDIF.
    IF sy-subrc <> 0.
      lo_http->get_last_error( IMPORTING message = lv_msg ).
      ev_status = 0. ev_body = lv_msg.
      lo_http->close( ).
      RETURN.
    ENDIF.
    lo_http->response->get_status( IMPORTING code = ev_status ).
    ev_body = lo_http->response->get_cdata( ).
    lo_http->close( ).
  ENDMETHOD.

  METHOD token.
    DATA: lv_status TYPE i, lv_body TYPE string.
    DATA(lv_basic) = cl_http_utility=>encode_base64( unencoded = |{ iv_id }:{ iv_secret }| ).
    call( EXPORTING iv_path = '/oauth/token' iv_ctype = 'application/x-www-form-urlencoded'
                    iv_body = 'grant_type=client_credentials&scope=sap.api'
                    it_headers = VALUE #( ( name = 'Authorization' value = |Basic { lv_basic }| ) )
          IMPORTING ev_status = lv_status ev_body = lv_body ).
    IF lv_status <> 200.
      out( |토큰 실패 HTTP { lv_status }: { lv_body }| ).
      RETURN.
    ENDIF.
    FIND REGEX '"access_token"\s*:\s*"([^"]+)"' IN lv_body SUBMATCHES mv_token.
    rv_ok = xsdbool( mv_token IS NOT INITIAL ).
    out( |토큰 HTTP 200 (토큰 { strlen( mv_token ) }자)| ).
  ENDMETHOD.

  METHOD send.
    DATA: lr_chunk  TYPE REF TO data,
          lv_status TYPE i,
          lv_resp   TYPE string,
          lv_no     TYPE i,
          lv_from   TYPE i VALUE 1,
          lv_to     TYPE i,
          lv_key    TYPE string,
          lv_body   TYPE string,
          lv_corr   TYPE string.
    FIELD-SYMBOLS <chunk> TYPE STANDARD TABLE.
    CREATE DATA lr_chunk LIKE it_recs.
    ASSIGN lr_chunk->* TO <chunk>.
    DATA(lv_total) = lines( it_recs ).
    DO.
      lv_no = lv_no + 1.
      lv_to = lv_from + iv_size - 1.
      CLEAR <chunk>.
      LOOP AT it_recs ASSIGNING FIELD-SYMBOL(<r>) FROM lv_from TO lv_to.
        APPEND <r> TO <chunk>.
      ENDLOOP.
      lv_from = lv_to + 1.
      DATA(lv_last) = xsdbool( lv_from > lv_total ).
      DATA(lv_json) = /ui2/cl_json=>serialize( data = <chunk> pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                               compress = iv_compress ).
      IF lv_json IS INITIAL OR lv_json = 'null'.
        lv_json = '[]'.
      ENDIF.
      IF iv_type IS NOT INITIAL.
        DATA(lv_islast) = COND string( WHEN lv_last = abap_true THEN 'true' ELSE 'false' ).
        lv_body = |\{"batchId":"{ iv_batch }","type":"{ iv_type }","chunkNo":{ lv_no },"isLast":{ lv_islast },"records":{ lv_json }\}|.
        lv_key = |{ iv_batch }-{ iv_type }-{ lv_no }|.
      ELSE.
        lv_body = |\{"batchId":"{ iv_batch }","records":{ lv_json }\}|.
        lv_key = |{ iv_batch }-{ lv_no }|.
      ENDIF.
      TRY.
          lv_corr = to_lower( cl_system_uuid=>create_uuid_c36_static( ) ).
        CATCH cx_uuid_error.
          CLEAR lv_corr.
      ENDTRY.
      call( EXPORTING iv_path = iv_path iv_ctype = 'application/json; charset=utf-8' iv_body = lv_body
                      it_headers = VALUE #( ( name = 'Authorization'    value = |Bearer { mv_token }| )
                                            ( name = 'X-SAP-System'     value = mv_sys )
                                            ( name = 'X-Company-Code'   value = mv_bukrs )
                                            ( name = 'Idempotency-Key'  value = lv_key )
                                            ( name = 'X-Correlation-Id' value = lv_corr ) )
            IMPORTING ev_status = lv_status ev_body = lv_resp ).
      out( |{ iv_path } { iv_type } 분할 { lv_no } ({ lines( <chunk> ) }건) → HTTP { lv_status }| ).
      out( |  { lv_resp }| ).
      IF lv_last = abap_true OR lv_status = 0 OR lv_status >= 400.
        EXIT.
      ENDIF.
    ENDDO.
  ENDMETHOD.

  METHOD out.
    DATA(lv_len) = strlen( iv_text ).
    DATA(lv_off) = 0.
    WHILE lv_off < lv_len.
      DATA(lv_n) = nmin( val1 = 200 val2 = lv_len - lv_off ).
      WRITE / iv_text+lv_off(lv_n).
      lv_off = lv_off + lv_n.
    ENDWHILE.
  ENDMETHOD.
ENDCLASS.

*----------------------------------------------------------------------*
INITIALIZATION.
  p_gjahr = sy-datum(4).

AT SELECTION-SCREEN OUTPUT.
  LOOP AT SCREEN.
    IF screen-group1 = 'SEC'.
      screen-invisible = '1'.
      MODIFY SCREEN.
    ENDIF.
  ENDLOOP.

START-OF-SELECTION.
  DATA: lt_company TYPE STANDARD TABLE OF ty_company,
        lt_pc      TYPE STANDARD TABLE OF ty_pc,
        lt_cc      TYPE STANDARD TABLE OF ty_cc,
        lt_class   TYPE STANDARD TABLE OF ty_class,
        lt_asset   TYPE STANDARD TABLE OF ty_asset,
        lt_value   TYPE STANDARD TABLE OF ty_value,
        lv_kokrs   TYPE kokrs,
        lv_ts      TYPE timestamp.

  DATA(go_api) = NEW lcl_api( iv_dest = p_dest iv_sys = p_sys iv_bukrs = p_bukrs ).
  IF go_api->token( iv_id = p_cid iv_secret = p_sec ) = abap_false.
    RETURN.
  ENDIF.
  GET TIME STAMP FIELD lv_ts.
  DATA(gv_stamp) = |{ lv_ts }|.
  DATA(gv_batch) = |TEST-{ gv_stamp(12) }|.          " TEST-yyyymmddhhmm (UTC)
  DATA(gv_changed) = |{ lv_ts TIMESTAMP = ISO }Z|.

  SELECT SINGLE kokrs FROM tka02 WHERE bukrs = @p_bukrs INTO @lv_kokrs.

  "---------------- IF-MD-01 ----------------
  IF p_md = abap_true.
    SELECT bukrs, butxt, waers FROM t001 WHERE bukrs = @p_bukrs INTO TABLE @DATA(lt_t001).
    lt_company = VALUE #( FOR c IN lt_t001 ( company_code = c-bukrs name = c-butxt currency = c-waers ) ).
    go_api->send( iv_path = '/sap/master-data' iv_type = 'COMPANY' iv_batch = |{ gv_batch }-MD| it_recs = lt_company iv_size = 5000 ).

    SELECT c~prctr, c~segment, t~ktext FROM cepc AS c
      LEFT OUTER JOIN cepct AS t ON t~prctr = c~prctr AND t~kokrs = c~kokrs AND t~datbi = c~datbi AND t~spras = 'E'
      WHERE c~kokrs = @lv_kokrs AND c~datab <= @sy-datum AND c~datbi >= @sy-datum
      INTO TABLE @DATA(lt_cepc).
    lt_pc = VALUE #( FOR p IN lt_cepc ( controlling_area = lv_kokrs profit_center = p-prctr
                                        name = COND #( WHEN p-ktext IS INITIAL THEN p-prctr ELSE p-ktext ) segment = p-segment ) ).
    go_api->send( iv_path = '/sap/master-data' iv_type = 'PROFIT_CENTER' iv_batch = |{ gv_batch }-MD| it_recs = lt_pc iv_size = 5000 ).

    SELECT c~kostl, c~datab, c~datbi, c~prctr, c~verak, t~ktext FROM csks AS c
      LEFT OUTER JOIN cskt AS t ON t~kostl = c~kostl AND t~kokrs = c~kokrs AND t~datbi = c~datbi AND t~spras = 'E'
      WHERE c~kokrs = @lv_kokrs AND c~bukrs = @p_bukrs AND c~datab <= @sy-datum AND c~datbi >= @sy-datum
      INTO TABLE @DATA(lt_csks).
    lt_cc = VALUE #( FOR k IN lt_csks ( controlling_area = lv_kokrs cost_center = k-kostl company_code = p_bukrs
                                        name = COND #( WHEN k-ktext IS INITIAL THEN k-kostl ELSE k-ktext )
                                        profit_center = k-prctr responsible = k-verak
                                        valid_from = |{ k-datab DATE = ISO }| valid_to = |{ k-datbi DATE = ISO }| ) ).
    go_api->send( iv_path = '/sap/master-data' iv_type = 'COST_CENTER' iv_batch = |{ gv_batch }-MD| it_recs = lt_cc iv_size = 5000 ).

    SELECT a~anlkl, t~txk50 FROM anka AS a
      LEFT OUTER JOIN ankt AS t ON t~anlkl = a~anlkl AND t~spras = 'E'
      INTO TABLE @DATA(lt_anka).
    lt_class = VALUE #( FOR a IN lt_anka ( asset_class = a-anlkl name = COND #( WHEN a-txk50 IS INITIAL THEN a-anlkl ELSE a-txk50 ) ) ).
    go_api->send( iv_path = '/sap/master-data' iv_type = 'ASSET_CLASS' iv_batch = |{ gv_batch }-MD| it_recs = lt_class iv_size = 5000 ).
  ENDIF.

  "---------------- IF-AA-01 ----------------
  SELECT anln1, anln2, anlkl, txt50, sernr, invnr, aktiv, deakt, ivdat, invzu FROM anla
    WHERE bukrs = @p_bukrs
    ORDER BY anln1, anln2
    INTO TABLE @DATA(lt_anla) UP TO @p_max ROWS.
  IF lt_anla IS NOT INITIAL.
    SELECT anln1, anln2, kostl, prctr, werks, stort, raumn FROM anlz
      FOR ALL ENTRIES IN @lt_anla
      WHERE bukrs = @p_bukrs AND anln1 = @lt_anla-anln1 AND anln2 = @lt_anla-anln2
        AND adatu <= @sy-datum AND bdatu >= @sy-datum
      INTO TABLE @DATA(lt_anlz).
  ENDIF.

  IF p_aa1 = abap_true.
    LOOP AT lt_anla INTO DATA(ls_a).
      READ TABLE lt_anlz INTO DATA(ls_z) WITH KEY anln1 = ls_a-anln1 anln2 = ls_a-anln2.
      IF sy-subrc <> 0.
        CLEAR ls_z.
      ENDIF.
      APPEND VALUE #( company_code = p_bukrs asset_no = ls_a-anln1 sub_no = ls_a-anln2 asset_class = ls_a-anlkl
                      description = COND #( WHEN ls_a-txt50 IS INITIAL THEN ls_a-anln1 ELSE ls_a-txt50 )
                      serial_no = ls_a-sernr inventory_no = ls_a-invnr
                      cap_date        = COND #( WHEN ls_a-aktiv IS NOT INITIAL THEN |{ ls_a-aktiv DATE = ISO }| )
                      deact_date      = COND #( WHEN ls_a-deakt IS NOT INITIAL THEN |{ ls_a-deakt DATE = ISO }| )
                      last_count_date = COND #( WHEN ls_a-ivdat IS NOT INITIAL THEN |{ ls_a-ivdat DATE = ISO }| )
                      inventory_note = ls_a-invzu cost_center = ls_z-kostl profit_center = ls_z-prctr
                      plant = ls_z-werks location = ls_z-stort room = ls_z-raumn changed_at = gv_changed ) TO lt_asset.
    ENDLOOP.
    go_api->send( iv_path = '/sap/assets:upsert' iv_batch = |{ gv_batch }-AA01| it_recs = lt_asset iv_size = 1000 ).
  ENDIF.

  "---------------- IF-AA-02 (시험용 단순 계산) ----------------
  IF p_aa2 = abap_true AND lt_anla IS NOT INITIAL.
    SELECT anln1, anln2, kansw, answl, knafa, ksafa, kaafa, nafag, safag, aafag FROM anlc
      FOR ALL ENTRIES IN @lt_anla
      WHERE bukrs = @p_bukrs AND anln1 = @lt_anla-anln1 AND anln2 = @lt_anla-anln2 AND gjahr = @p_gjahr AND afabe = '01'
      INTO TABLE @DATA(lt_anlc).
    SELECT anln1, anln2, ndjar, ndper, afasl FROM anlb
      FOR ALL ENTRIES IN @lt_anla
      WHERE bukrs = @p_bukrs AND anln1 = @lt_anla-anln1 AND anln2 = @lt_anla-anln2 AND afabe = '01'
        AND adatu <= @sy-datum AND bdatu >= @sy-datum
      INTO TABLE @DATA(lt_anlb).
    LOOP AT lt_anlc INTO DATA(ls_c).
      READ TABLE lt_anlb INTO DATA(ls_b) WITH KEY anln1 = ls_c-anln1 anln2 = ls_c-anln2.
      IF sy-subrc <> 0.
        CLEAR ls_b.
      ENDIF.
      DATA(lv_acq) = CONV ty_amount( ls_c-kansw + ls_c-answl ).
      DATA(lv_dep) = CONV ty_amount( ls_c-knafa + ls_c-ksafa + ls_c-kaafa + ls_c-nafag + ls_c-safag + ls_c-aafag ).
      APPEND VALUE #( company_code = p_bukrs asset_no = ls_c-anln1 sub_no = ls_c-anln2 fiscal_year = p_gjahr
                      period = COND #( WHEN p_gjahr = sy-datum(4) THEN CONV i( sy-datum+4(2) ) ELSE 12 ) dep_area = '01'
                      acquisition_value = lv_acq accum_depreciation = lv_dep net_book_value = lv_acq + lv_dep
                      useful_life_years = ls_b-ndjar useful_life_periods = ls_b-ndper dep_key = ls_b-afasl ) TO lt_value.
    ENDLOOP.
    go_api->send( iv_path = '/sap/asset-values' iv_batch = |{ gv_batch }-AA02| it_recs = lt_value iv_size = 1000
                  iv_compress = abap_false ).
  ENDIF.

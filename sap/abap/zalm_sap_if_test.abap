*&---------------------------------------------------------------------*
*& ZALM_SAP_IF_TEST - ALM 수신 API 시험(IF-MD-01, IF-AA-01·02, IF-MM-01·03, IF-RC-01)
*&   WBS 4.7 DEV 확인용. 운영 송신 프로그램(ZALM_IF_MASTER_SEND, 7.x)이
*&   나오기 전까지 실제 SAP 데이터를 소량 보내 응답(200/207)을 확인한다.
*&   - 토큰: POST /oauth/token (client_credentials, Basic)
*&   - MD01: COMPANY → PROFIT_CENTER → COST_CENTER → ASSET_CLASS
*&           (유형별 전체 송신, 마지막 분할 isLast=true → ALM에서 없는 코드 비활성)
*&   - AA01: 회사코드의 자산 P_MAX건(ANLA + ANLZ)
*&   - AA02: 위 자산의 회계연도 금액(ANLC, 상각영역 01) - 시험용 단순 계산
*&   - MM01: 자산 PO 항목(EKPO KNTTP=A, EKKN) P_MAX건
*&   - MM03: 입고(MATDOC BWART 101·102·122, 계정지정 A PO) 최근 P_GRDAY일 P_MAX건
*&           ALM에 PO 항목이 먼저 있어야 함(같이 실행하면 MM01 → MM03 순서)
*&   - RC01: 대사 스냅샷(회사코드 자산 전체, 비활성은 최근 12개월) WEEKLY
*&   - OP01: GET /sap/run-requests (대기 요청을 '가져감'으로 바꿈)
*&   - POST: POST /sap/postings:claim - 전기 대상을 15분 잠그고 시도 횟수를 올린다.
*&           결과는 회신하지 않으므로 DEV에서만, 대상이 없을 때 확인용으로 쓴다(기본 해제)
*&   - PST: IF-AA-03 자산 생성 전기 - claim(ASSET_CREATE) → BAPI_FIXEDASSET_CREATE1
*&          → COMMIT → POST /sap/postings/{id}/result (POSTED 자산번호 / FAILED BAPI 메시지)
*&          같은 INVNR(자산태그) 자산이 이미 있으면 새로 만들지 않고 그 번호로 POSTED 회신(재실행 안전)
*&          P_LOC: STORT(위치=룸 코드)도 넘긴다. T499S에 없는 위치면 BAPI 오류이므로 기본 해제
*&          P_TRUN: BAPI 시험 실행(TESTRUN) - SAP에 만들지 않고 메시지만 출력, 성공·실패 모두 ALM 회신 안 함(잠금은 15분 뒤 풀림)
*&          클래스 화면 레이아웃에서 입력 불가 필드(AY/219)면 시리얼·룸·위치를 빼고 한 번 더 시도(회신에 W 메시지)
*&        IF-AA-04 변경(ASSET_CHANGE, 손익센터가 같은 코스트센터 이관 포함) → BAPI_FIXEDASSET_CHANGE
*&        IF-AA-06 폐기(ASSET_RETIRE: SCRAP·LOSS) → BAPI_ASSET_RETIREMENT_POST 전체 폐기(P_TTRET 거래유형)
*&        IF-AA-07 실사 결과(COUNT_RESULT) → BAPI_FIXEDASSET_CHANGE 최종 실사일(IVDAT)·재고 메모(INVZU)
*&          (매개변수 INVENTORY-DATE·NOTE). SAP 값이 이미 같으면 BAPI 없이 POSTED(재실행 안전)
*&          BKTXT(머리글 텍스트)=요청번호. 같은 BKTXT 전표가 있으면 다시 전기하지 않고 그 전표로 POSTED(재실행 안전)
*&          매각(SALE, 매출 금액 필드)과 손익센터가 바뀌는 이관(IF-AA-05 ABUMN)은 아직 - 가져가지 않거나 회신하지 않는다
*&          BAPI는 FUPARAREF로 매개변수를 읽어 동적으로 부른다. 필드가 없으면 호출하지 않고 서명을 출력(회신 안 함)
*&   - SIG: 위 BAPI들의 매개변수·필드 목록 출력(시스템별 서명 확인용)
*&   clientId·비밀은 화면 입력(SM59 사용자 필드 12자 제한, 13 런북 7-2)
*&---------------------------------------------------------------------*
REPORT zalm_sap_if_test.

PARAMETERS: p_dest  TYPE rfcdest DEFAULT 'ZALM_DEV' OBLIGATORY,
            p_sys   TYPE char10 DEFAULT 'S4H-100' OBLIGATORY,
            p_cid   TYPE char64 LOWER CASE OBLIGATORY,
            p_sec   TYPE char128 LOWER CASE OBLIGATORY MODIF ID sec,
            p_bukrs TYPE bukrs DEFAULT '1000' OBLIGATORY,
            p_max   TYPE i DEFAULT 20,
            p_gjahr TYPE gjahr,
            p_grday TYPE i DEFAULT 30.
SELECTION-SCREEN SKIP.
PARAMETERS: p_md  AS CHECKBOX DEFAULT 'X',
            p_aa1 AS CHECKBOX DEFAULT 'X',
            p_aa2 AS CHECKBOX DEFAULT 'X',
            p_po  AS CHECKBOX DEFAULT 'X',
            p_gr  AS CHECKBOX DEFAULT ' ',
            p_rc  AS CHECKBOX DEFAULT ' ',
            p_opr AS CHECKBOX DEFAULT 'X',
            p_clm AS CHECKBOX DEFAULT ' ',
            p_pst AS CHECKBOX DEFAULT ' ',
            p_loc AS CHECKBOX DEFAULT ' ',
            p_trun AS CHECKBOX DEFAULT ' ',
            p_ttret TYPE bwasl DEFAULT '200',
            p_sig  AS CHECKBOX DEFAULT ' '.

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
       END OF ty_value,
       BEGIN OF ty_asset_ref,
         asset_no TYPE string,
         sub_no   TYPE string,
       END OF ty_asset_ref,
       ty_asset_refs TYPE STANDARD TABLE OF ty_asset_ref WITH EMPTY KEY,
       ty_qty TYPE p LENGTH 13 DECIMALS 3,
       BEGIN OF ty_po,
         po_no          TYPE string,
         item           TYPE string,
         company_code   TYPE string,
         vendor         TYPE string,
         vendor_name    TYPE string,
         description    TYPE string,
         quantity       TYPE ty_qty,
         unit_price     TYPE ty_amount,
         cost_center    TYPE string,
         assets         TYPE ty_asset_refs,
         deletion_flag  TYPE abap_bool,
         alm_request_no TYPE string,
       END OF ty_po,
       BEGIN OF ty_gr,
         material_doc  TYPE string,
         doc_year      TYPE string,
         doc_item      TYPE string,
         po_no         TYPE string,
         po_item       TYPE string,
         movement_type TYPE string,
         quantity      TYPE ty_qty,
         posting_date  TYPE string,
       END OF ty_gr,
       BEGIN OF ty_recon,
         company_code TYPE string,
         asset_no     TYPE string,
         sub_no       TYPE string,
         inventory_no TYPE string,
         serial_no    TYPE string,
         cost_center  TYPE string,
         location     TYPE string,
         room         TYPE string,
         deact_date   TYPE string,
       END OF ty_recon.
" IF-AA-03 전기 봉투(claim 응답)와 결과 회신
TYPES: BEGIN OF ty_fields,
         description  TYPE string,
         serial_no    TYPE string,
         inventory_no TYPE string,
         location     TYPE string,
         room         TYPE string,
         cost_center  TYPE string,
       END OF ty_fields,
       BEGIN OF ty_create_pl,
         asset_class  TYPE string,
         description  TYPE string,
         cost_center  TYPE string,
         cap_date     TYPE string,
         serial_no    TYPE string,
         inventory_no TYPE string,
         location     TYPE string,
         room         TYPE string,
         po_no        TYPE string,
         po_item      TYPE string,
         " ASSET_CHANGE
         fields                 TYPE ty_fields,
         cost_center_valid_from TYPE string,
         " ASSET_RETIRE
         retire_type  TYPE string,
         sale_amount  TYPE ty_amount,
         customer     TYPE string,
         is_partial   TYPE abap_bool,
         reason       TYPE string,
         " COUNT_RESULT
         last_count_date TYPE string,
         inventory_note  TYPE string,
       END OF ty_create_pl,
       BEGIN OF ty_env_asset,
         asset_no     TYPE string,
         sub_no       TYPE string,
         inventory_no TYPE string,
       END OF ty_env_asset,
       BEGIN OF ty_envelope,
         posting_id   TYPE string,
         type         TYPE string,
         company_code TYPE string,
         posting_date TYPE string,
         value_date   TYPE string,
         attempt      TYPE i,
         asset        TYPE ty_env_asset,
         payload      TYPE ty_create_pl,
       END OF ty_envelope,
       BEGIN OF ty_claim,
         batch_id      TYPE string,
         lease_seconds TYPE i,
         items         TYPE STANDARD TABLE OF ty_envelope WITH EMPTY KEY,
       END OF ty_claim,
       BEGIN OF ty_res_msg,
         type   TYPE string,
         id     TYPE string,
         number TYPE string,
         text   TYPE string,
       END OF ty_res_msg,
       BEGIN OF ty_res_asset,
         asset_no     TYPE string,
         sub_no       TYPE string,
         inventory_no TYPE string,
       END OF ty_res_asset,
       BEGIN OF ty_sap_doc,
         belnr TYPE string,
         gjahr TYPE string,
       END OF ty_sap_doc,
       BEGIN OF ty_result,
         posting_id   TYPE string,
         status       TYPE string,
         sap_document TYPE ty_sap_doc,
         asset        TYPE ty_res_asset,
         messages   TYPE STANDARD TABLE OF ty_res_msg WITH EMPTY KEY,
       END OF ty_result.

*----------------------------------------------------------------------*
CLASS lcl_api DEFINITION.
  PUBLIC SECTION.
    METHODS constructor IMPORTING iv_dest TYPE rfcdest iv_sys TYPE csequence iv_bukrs TYPE bukrs.
    METHODS token IMPORTING iv_id TYPE csequence iv_secret TYPE csequence RETURNING VALUE(rv_ok) TYPE abap_bool.
    "! 레코드를 iv_size건씩 나눠 보낸다. iv_type이 있으면 /sap/master-data 형식
    "! iv_chunked: 분할 필드(chunkNo·isLast)를 붙인다. iv_head: 본문 머리에 넣을 JSON 필드(예: "runType":"WEEKLY")
    METHODS send IMPORTING iv_path TYPE string iv_type TYPE string OPTIONAL iv_batch TYPE string
                           iv_head TYPE string OPTIONAL iv_chunked TYPE abap_bool DEFAULT abap_false
                           it_recs TYPE STANDARD TABLE iv_size TYPE i iv_compress TYPE abap_bool DEFAULT abap_true.
    "! 단건 호출(GET·POST)과 응답 출력
    METHODS request IMPORTING iv_method TYPE string iv_path TYPE string iv_body TYPE string OPTIONAL iv_key TYPE string OPTIONAL.
    "! 단건 호출 후 상태·본문을 돌려준다(출력도 함)
    METHODS exec IMPORTING iv_method TYPE string iv_path TYPE string iv_body TYPE string OPTIONAL iv_key TYPE string OPTIONAL
                 EXPORTING ev_status TYPE i ev_body TYPE string.
  PRIVATE SECTION.
    DATA: mv_dest TYPE rfcdest, mv_sys TYPE string, mv_bukrs TYPE string, mv_token TYPE string.
    METHODS headers IMPORTING iv_key TYPE string OPTIONAL RETURNING VALUE(rt_headers) TYPE tihttpnvp.
    METHODS call IMPORTING iv_method TYPE string DEFAULT 'POST' iv_path TYPE string iv_ctype TYPE string iv_body TYPE string it_headers TYPE tihttpnvp
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
    lo_http->request->set_method( iv_method ).
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
      DATA(lv_islast) = COND string( WHEN lv_last = abap_true THEN 'true' ELSE 'false' ).
      IF iv_type IS NOT INITIAL.
        lv_body = |\{"batchId":"{ iv_batch }","type":"{ iv_type }","chunkNo":{ lv_no },"isLast":{ lv_islast },"records":{ lv_json }\}|.
        lv_key = |{ iv_batch }-{ iv_type }-{ lv_no }|.
      ELSEIF iv_chunked = abap_true.
        lv_body = |\{"batchId":"{ iv_batch }",{ iv_head },"chunkNo":{ lv_no },"isLast":{ lv_islast },"records":{ lv_json }\}|.
        lv_key = |{ iv_batch }-{ lv_no }|.
      ELSE.
        lv_body = |\{"batchId":"{ iv_batch }","records":{ lv_json }\}|.
        lv_key = |{ iv_batch }-{ lv_no }|.
      ENDIF.
      call( EXPORTING iv_path = iv_path iv_ctype = 'application/json; charset=utf-8' iv_body = lv_body
                      it_headers = headers( lv_key )
            IMPORTING ev_status = lv_status ev_body = lv_resp ).
      out( |{ iv_path } { iv_type } 분할 { lv_no } ({ lines( <chunk> ) }건) → HTTP { lv_status }| ).
      out( |  { lv_resp }| ).
      IF lv_last = abap_true OR lv_status = 0 OR lv_status >= 400.
        EXIT.
      ENDIF.
    ENDDO.
  ENDMETHOD.

  METHOD headers.
    DATA lv_corr TYPE string.
    TRY.
        lv_corr = to_lower( cl_system_uuid=>create_uuid_c36_static( ) ).
      CATCH cx_uuid_error.
        CLEAR lv_corr.
    ENDTRY.
    rt_headers = VALUE #( ( name = 'Authorization'    value = |Bearer { mv_token }| )
                          ( name = 'X-SAP-System'     value = mv_sys )
                          ( name = 'X-Company-Code'   value = mv_bukrs )
                          ( name = 'X-Correlation-Id' value = lv_corr ) ).
    IF iv_key IS NOT INITIAL.
      APPEND VALUE #( name = 'Idempotency-Key' value = iv_key ) TO rt_headers.
    ENDIF.
  ENDMETHOD.

  METHOD request.
    exec( iv_method = iv_method iv_path = iv_path iv_body = iv_body iv_key = iv_key ).
  ENDMETHOD.

  METHOD exec.
    call( EXPORTING iv_method = iv_method iv_path = iv_path iv_ctype = 'application/json; charset=utf-8' iv_body = iv_body
                    it_headers = headers( iv_key )
          IMPORTING ev_status = ev_status ev_body = ev_body ).
    out( |{ iv_method } { iv_path } → HTTP { ev_status }| ).
    out( |  { ev_body }| ).
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
" BAPI 동적 호출: FUPARAREF에서 매개변수·타입을 읽어 데이터를 만들고, 필드를 이름으로 채운다.
" 시스템마다 다른 서명(필드 이름)을 컴파일 오류 없이 다루고, 없는 필드는 mt_missing에 모은다
CLASS lcl_bapi DEFINITION.
  PUBLIC SECTION.
    DATA: mv_ok      TYPE abap_bool READ-ONLY,
          mt_missing TYPE string_table READ-ONLY,
          mv_error   TYPE string READ-ONLY.
    METHODS constructor IMPORTING iv_func TYPE csequence.
    METHODS has IMPORTING iv_param TYPE csequence RETURNING VALUE(rv) TYPE abap_bool.
    "! 매개변수 구조에 있는 첫 필드 이름(후보 순서대로). 없으면 빈 값
    METHODS field IMPORTING iv_param TYPE csequence it_names TYPE string_table RETURNING VALUE(rv) TYPE string.
    METHODS set IMPORTING iv_param TYPE csequence iv_field TYPE csequence OPTIONAL iv_value TYPE any.
    METHODS get IMPORTING iv_param TYPE csequence iv_field TYPE csequence OPTIONAL RETURNING VALUE(rv) TYPE string.
    METHODS call.
    METHODS ret RETURNING VALUE(rs) TYPE bapiret2.
    METHODS signature.
  PRIVATE SECTION.
    TYPES: BEGIN OF ty_p,
             name TYPE string,
             kind TYPE c LENGTH 1,
             type TYPE string,
             ref  TYPE REF TO data,
           END OF ty_p.
    DATA: mv_func TYPE rs38l_fnam,
          mt_p    TYPE STANDARD TABLE OF ty_p WITH EMPTY KEY.
ENDCLASS.

CLASS lcl_bapi IMPLEMENTATION.
  METHOD constructor.
    mv_func = to_upper( iv_func ).
    SELECT parameter, paramtype, structure FROM fupararef
      WHERE funcname = @mv_func AND r3state = 'A' AND paramtype IN ('I','E','T','C')
      INTO TABLE @DATA(lt_par).
    IF lt_par IS INITIAL.
      mv_error = |{ mv_func } 함수가 없습니다|.
      RETURN.
    ENDIF.
    LOOP AT lt_par INTO DATA(ls_par) WHERE structure IS NOT INITIAL.
      DATA(ls_p) = VALUE ty_p( name = ls_par-parameter kind = ls_par-paramtype type = ls_par-structure ).
      TRY.
          IF ls_p-kind = 'T'.
            CREATE DATA ls_p-ref TYPE STANDARD TABLE OF (ls_p-type).
          ELSE.
            CREATE DATA ls_p-ref TYPE (ls_p-type).
          ENDIF.
          APPEND ls_p TO mt_p.
        CATCH cx_sy_create_data_error.
          APPEND |{ ls_p-name }({ ls_p-type }) 타입 생성 실패| TO mt_missing.
      ENDTRY.
    ENDLOOP.
    mv_ok = abap_true.
  ENDMETHOD.

  METHOD has.
    rv = xsdbool( line_exists( mt_p[ name = to_upper( iv_param ) ] ) ).
  ENDMETHOD.

  METHOD field.
    FIELD-SYMBOLS: <d> TYPE any, <c> TYPE any.
    READ TABLE mt_p INTO DATA(ls_p) WITH KEY name = to_upper( iv_param ).
    CHECK sy-subrc = 0.
    ASSIGN ls_p-ref->* TO <d>.
    LOOP AT it_names INTO DATA(lv_n).
      ASSIGN COMPONENT to_upper( lv_n ) OF STRUCTURE <d> TO <c>.
      IF sy-subrc = 0.
        rv = to_upper( lv_n ).
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD set.
    FIELD-SYMBOLS: <d> TYPE any, <c> TYPE any.
    READ TABLE mt_p INTO DATA(ls_p) WITH KEY name = to_upper( iv_param ).
    IF sy-subrc <> 0.
      APPEND to_upper( iv_param ) TO mt_missing.
      RETURN.
    ENDIF.
    ASSIGN ls_p-ref->* TO <d>.
    IF iv_field IS INITIAL.
      <d> = iv_value.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT to_upper( iv_field ) OF STRUCTURE <d> TO <c>.
    IF sy-subrc <> 0.
      APPEND |{ to_upper( iv_param ) }-{ to_upper( iv_field ) }| TO mt_missing.
      RETURN.
    ENDIF.
    <c> = iv_value.
  ENDMETHOD.

  METHOD get.
    FIELD-SYMBOLS: <d> TYPE any, <c> TYPE any.
    READ TABLE mt_p INTO DATA(ls_p) WITH KEY name = to_upper( iv_param ).
    CHECK sy-subrc = 0.
    ASSIGN ls_p-ref->* TO <d>.
    IF iv_field IS INITIAL.
      rv = |{ <d> }|.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT to_upper( iv_field ) OF STRUCTURE <d> TO <c>.
    CHECK sy-subrc = 0.
    rv = |{ <c> }|.
  ENDMETHOD.

  METHOD call.
    DATA: lt_bind TYPE abap_func_parmbind_tab,
          lt_exc  TYPE abap_func_excpbind_tab.
    LOOP AT mt_p INTO DATA(ls_p).
      INSERT VALUE #( name = ls_p-name
                      kind = SWITCH #( ls_p-kind WHEN 'I' THEN abap_func_exporting WHEN 'E' THEN abap_func_importing
                                                 WHEN 'T' THEN abap_func_tables ELSE abap_func_changing )
                      value = ls_p-ref ) INTO TABLE lt_bind.
    ENDLOOP.
    INSERT VALUE #( name = 'OTHERS' value = 99 ) INTO TABLE lt_exc.
    TRY.
        CALL FUNCTION mv_func PARAMETER-TABLE lt_bind EXCEPTION-TABLE lt_exc.
        IF sy-subrc <> 0.
          mv_error = |{ mv_func } 예외 sy-subrc={ sy-subrc }|.
        ENDIF.
      CATCH cx_sy_dyn_call_error INTO DATA(lx).
        mv_error = |{ mv_func }: { lx->get_text( ) }|.
    ENDTRY.
  ENDMETHOD.

  " RETURN(구조 또는 표)과 RETURN_ALL(표)의 메시지를 모두 출력하고, E·A가 있으면 그것을, 없으면 RETURN을 돌려준다
  METHOD ret.
    FIELD-SYMBOLS: <t> TYPE STANDARD TABLE.
    DATA: ls_m TYPE bapiret2, lt_all TYPE STANDARD TABLE OF bapiret2 WITH EMPTY KEY.
    LOOP AT mt_p INTO DATA(ls_p) WHERE name = 'RETURN' OR name = 'RETURN_ALL'.
      IF ls_p-kind = 'T'.
        ASSIGN ls_p-ref->* TO <t>.
        LOOP AT <t> ASSIGNING FIELD-SYMBOL(<l>).
          CLEAR ls_m.
          MOVE-CORRESPONDING <l> TO ls_m.
          APPEND ls_m TO lt_all.
        ENDLOOP.
      ELSE.
        ASSIGN ls_p-ref->* TO FIELD-SYMBOL(<s>).
        CLEAR ls_m.
        MOVE-CORRESPONDING <s> TO ls_m.
        IF ls_m-type IS NOT INITIAL.
          INSERT ls_m INTO lt_all INDEX 1.
        ENDIF.
      ENDIF.
    ENDLOOP.
    LOOP AT lt_all INTO ls_m.
      WRITE / |    { ls_m-type } { ls_m-id }/{ ls_m-number } { ls_m-message }|.
    ENDLOOP.
    READ TABLE lt_all INTO rs WITH KEY type = 'A'.
    IF sy-subrc <> 0.
      READ TABLE lt_all INTO rs WITH KEY type = 'E'.
      IF sy-subrc <> 0.
        READ TABLE lt_all INTO rs INDEX 1.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD signature.
    WRITE / |== { mv_func } { mv_error }|.
    LOOP AT mt_p INTO DATA(ls_p).
      WRITE / |  { ls_p-kind } { ls_p-name } : { ls_p-type }|.
      TRY.
          DATA(lo_t) = cl_abap_typedescr=>describe_by_name( ls_p-type ).
          IF lo_t IS INSTANCE OF cl_abap_structdescr.
            DATA(lv_comps) = REDUCE string( INIT x = `` FOR c IN CAST cl_abap_structdescr( lo_t )->components
                                            NEXT x = |{ x } { c-name }| ).
            WRITE / |      { lv_comps }|.
          ENDIF.
        CATCH cx_root ##NO_HANDLER.
      ENDTRY.
    ENDLOOP.
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

  "---------------- IF-MM-01 자산 PO 항목 ----------------
  IF p_po = abap_true.
    DATA lt_po TYPE STANDARD TABLE OF ty_po.
    SELECT p~ebeln, p~ebelp, p~txz01, p~menge, p~netpr, p~peinh, p~loekz, k~lifnr, k~ihrez, l~name1
      FROM ekpo AS p
      INNER JOIN ekko AS k ON k~ebeln = p~ebeln
      LEFT OUTER JOIN lfa1 AS l ON l~lifnr = k~lifnr
      WHERE k~bukrs = @p_bukrs AND p~knttp = 'A'
      ORDER BY p~ebeln DESCENDING, p~ebelp
      INTO TABLE @DATA(lt_ekpo) UP TO @p_max ROWS.
    IF lt_ekpo IS NOT INITIAL.
      SELECT ebeln, ebelp, kostl, anln1, anln2 FROM ekkn
        FOR ALL ENTRIES IN @lt_ekpo
        WHERE ebeln = @lt_ekpo-ebeln AND ebelp = @lt_ekpo-ebelp
        INTO TABLE @DATA(lt_ekkn).
    ENDIF.
    LOOP AT lt_ekpo INTO DATA(ls_p).
      DATA(lv_cc) = VALUE string( ).
      DATA(lt_refs) = VALUE ty_asset_refs( ).
      LOOP AT lt_ekkn INTO DATA(ls_k) WHERE ebeln = ls_p-ebeln AND ebelp = ls_p-ebelp.
        IF lv_cc IS INITIAL.
          lv_cc = ls_k-kostl.
        ENDIF.
        IF ls_k-anln1 IS NOT INITIAL.
          APPEND VALUE #( asset_no = ls_k-anln1 sub_no = ls_k-anln2 ) TO lt_refs.
        ENDIF.
      ENDLOOP.
      APPEND VALUE #( po_no = ls_p-ebeln item = ls_p-ebelp company_code = p_bukrs vendor = ls_p-lifnr vendor_name = ls_p-name1
                      description = COND #( WHEN ls_p-txz01 IS INITIAL THEN |{ ls_p-ebeln }/{ ls_p-ebelp }| ELSE ls_p-txz01 )
                      quantity = ls_p-menge
                      unit_price = COND #( WHEN ls_p-peinh > 0 THEN ls_p-netpr / ls_p-peinh ELSE ls_p-netpr )
                      cost_center = lv_cc assets = lt_refs deletion_flag = xsdbool( ls_p-loekz IS NOT INITIAL )
                      alm_request_no = ls_p-ihrez ) TO lt_po.
    ENDLOOP.
    go_api->send( iv_path = '/sap/purchase-orders' iv_batch = |{ gv_batch }-MM01| it_recs = lt_po iv_size = 1000 ).
  ENDIF.

  "---------------- IF-MM-03 입고(계정지정 A PO) ----------------
  "  101 입고, 102 입고 취소, 122 공급업체 반품. 같은 문서 행을 다시 보내면 ALM이 SKIPPED
  IF p_gr = abap_true.
    DATA lt_gr TYPE STANDARD TABLE OF ty_gr.
    DATA(lv_from) = CONV d( sy-datum - p_grday ).
    "  수량: MENGE(기본단위)가 비어 있는 행이 있어(계정지정 소비 입고) ERFMG(입력단위) → STOCK_QTY 순으로 대체
    SELECT m~mblnr, m~mjahr, m~zeile, m~ebeln, m~ebelp, m~bwart, m~menge, m~erfmg, m~stock_qty, m~budat
      FROM matdoc AS m
      INNER JOIN ekpo AS p ON p~ebeln = m~ebeln AND p~ebelp = m~ebelp
      INNER JOIN ekko AS k ON k~ebeln = m~ebeln
      WHERE k~bukrs = @p_bukrs AND p~knttp = 'A'
        AND m~bwart IN ('101','102','122') AND m~budat >= @lv_from
        AND m~ebeln <> @space AND m~xauto = @space
      ORDER BY m~mblnr, m~mjahr, m~zeile
      INTO TABLE @DATA(lt_mdoc) UP TO @p_max ROWS.
    LOOP AT lt_mdoc INTO DATA(ls_m).
      DATA(lv_q) = CONV ty_qty( COND #( WHEN ls_m-menge <> 0 THEN abs( ls_m-menge )
                                        WHEN ls_m-erfmg <> 0 THEN abs( ls_m-erfmg )
                                        ELSE abs( ls_m-stock_qty ) ) ).
      WRITE: / |MM03 { ls_m-mblnr }/{ ls_m-mjahr }/{ ls_m-zeile } { ls_m-bwart } PO { ls_m-ebeln }/{ ls_m-ebelp }|,
               |MENGE { ls_m-menge } ERFMG { ls_m-erfmg } STOCK_QTY { ls_m-stock_qty } → { lv_q }|.
      "  같은 문서 행이 여러 레코드로 있으면 수량이 있는 행 하나만 보냄
      READ TABLE lt_gr ASSIGNING FIELD-SYMBOL(<gr>) WITH KEY material_doc = CONV string( ls_m-mblnr )
           doc_year = |{ ls_m-mjahr }| doc_item = |{ ls_m-zeile }|.
      IF sy-subrc = 0.
        IF <gr>-quantity = 0.
          <gr>-quantity = lv_q.
        ENDIF.
        CONTINUE.
      ENDIF.
      APPEND VALUE #( material_doc = ls_m-mblnr doc_year = |{ ls_m-mjahr }| doc_item = |{ ls_m-zeile }|
                      po_no = ls_m-ebeln po_item = |{ ls_m-ebelp }| movement_type = ls_m-bwart
                      quantity = lv_q posting_date = |{ ls_m-budat DATE = ISO }| ) TO lt_gr.
    ENDLOOP.
    IF lt_gr IS INITIAL.
      WRITE: / |MM03: 최근 { p_grday }일 계정지정 A 입고 없음({ lv_from DATE = ISO } 이후)|.
    ELSE.
      go_api->send( iv_path = '/sap/goods-receipts' iv_batch = |{ gv_batch }-MM03| it_recs = lt_gr iv_size = 1000
                    iv_compress = abap_false ).
    ENDIF.
  ENDIF.

  "---------------- IF-RC-01 대사 스냅샷(WEEKLY) ----------------
  IF p_rc = abap_true.
    DATA lt_rc TYPE STANDARD TABLE OF ty_recon.
    DATA(lv_cut) = CONV d( sy-datum - 365 ).
    SELECT a~anln1, a~anln2, a~invnr, a~sernr, a~deakt, z~kostl, z~stort, z~raumn
      FROM anla AS a
      LEFT OUTER JOIN anlz AS z ON z~bukrs = a~bukrs AND z~anln1 = a~anln1 AND z~anln2 = a~anln2
                               AND z~adatu <= @sy-datum AND z~bdatu >= @sy-datum
      WHERE a~bukrs = @p_bukrs AND ( a~deakt = '00000000' OR a~deakt >= @lv_cut )
      ORDER BY a~anln1, a~anln2
      INTO TABLE @DATA(lt_snap).
    lt_rc = VALUE #( FOR s IN lt_snap ( company_code = p_bukrs asset_no = s-anln1 sub_no = s-anln2 inventory_no = s-invnr serial_no = s-sernr
                                        cost_center = s-kostl location = s-stort room = s-raumn
                                        deact_date = COND #( WHEN s-deakt IS NOT INITIAL THEN |{ s-deakt DATE = ISO }| ) ) ).
    go_api->send( iv_path = '/sap/reconciliation' iv_batch = |{ gv_batch }-RC01| iv_chunked = abap_true
                  iv_head = |"runType":"WEEKLY","snapshotAt":"{ gv_changed }"| it_recs = lt_rc iv_size = 5000 ).
  ENDIF.

  "---------------- IF-OP-01 수동 실행 요청 ----------------
  IF p_opr = abap_true.
    go_api->request( iv_method = 'GET' iv_path = '/sap/run-requests' ).
  ENDIF.

  "---------------- 전기 대상 가져오기(claim) ----------------
  IF p_clm = abap_true.
    go_api->request( iv_method = 'POST' iv_path = '/sap/postings:claim' iv_key = |{ gv_batch }-POST|
                     iv_body = |\{"batchId":"{ gv_batch }-POST","maxItems":10\}| ).
  ENDIF.

  "---------------- BAPI 서명 출력 ----------------
  IF p_sig = abap_true.
    LOOP AT VALUE string_table( ( `BAPI_FIXEDASSET_CHANGE` ) ( `BAPI_ASSET_RETIREMENT_POST` ) ( `BAPI_ASSET_TRANSFER_POST` ) ) INTO DATA(lv_fn).
      NEW lcl_bapi( lv_fn )->signature( ).
    ENDLOOP.
  ENDIF.

  "---------------- IF-AA-03·04·06 전기(claim → BAPI → 결과 회신) ----------------
  IF p_pst = abap_true.
    DATA: ls_claim  TYPE ty_claim,
          ls_res    TYPE ty_result,
          lv_cstat  TYPE i,
          lv_cbody  TYPE string,
          ls_key    TYPE bapi1022_key,
          ls_gen    TYPE bapi1022_feglg001,
          ls_genx   TYPE bapi1022_feglg001x,
          ls_time   TYPE bapi1022_feglg003,
          ls_timex  TYPE bapi1022_feglg003x,
          ls_pinf   TYPE bapi1022_feglg002,
          ls_pinfx  TYPE bapi1022_feglg002x,
          lv_anln1  TYPE bapi1022_1-assetmaino,
          lv_anln2  TYPE bapi1022_1-assetsubno,
          ls_ret    TYPE bapiret2,
          lv_invnr  TYPE anla-invnr,
          lv_try    TYPE i,
          lv_dropped TYPE abap_bool,
          lv_skip   TYPE abap_bool,
          lv_bktxt  TYPE bkpf-bktxt,
          lv_objkey TYPE string,
          lv_deakt  TYPE anla-deakt,
          lv_today  TYPE string,
          lv_ivdat  TYPE d,
          lv_invzu  TYPE anla-invzu.
    lv_today = |{ sy-datum DATE = ISO }|.

    go_api->exec( EXPORTING iv_method = 'POST' iv_path = '/sap/postings:claim' iv_key = |{ gv_batch }-PST|
                            iv_body = |\{"batchId":"{ gv_batch }-PST","maxItems":10,"types":["ASSET_CREATE","ASSET_CHANGE","ASSET_RETIRE","COUNT_RESULT"]\}|
                  IMPORTING ev_status = lv_cstat ev_body = lv_cbody ).
    IF lv_cstat = 200.
      /ui2/cl_json=>deserialize( EXPORTING json = lv_cbody pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                 CHANGING data = ls_claim ).
    ENDIF.
    WRITE / |전기 대상 { lines( ls_claim-items ) }건|.

    LOOP AT ls_claim-items INTO DATA(ls_env).
      CLEAR: ls_res, lv_anln1, lv_anln2, ls_ret, lv_dropped, lv_skip.
      ls_res-posting_id = ls_env-posting_id.
      DATA(ls_pl) = ls_env-payload.
      DATA(lv_pdate) = replace( val = COND string( WHEN ls_env-posting_date IS NOT INITIAL THEN ls_env-posting_date ELSE lv_today )
                                sub = '-' with = '' occ = 0 ).
      DATA(lv_vdate) = COND string( WHEN ls_env-value_date IS NOT INITIAL
                                    THEN replace( val = ls_env-value_date sub = '-' with = '' occ = 0 ) ELSE lv_pdate ).
      CASE ls_env-type.
        WHEN 'ASSET_CREATE'.
          WRITE / |{ ls_env-posting_id } { ls_env-company_code } { ls_pl-inventory_no } { ls_pl-asset_class } { ls_pl-cost_center } "{ ls_pl-description }"|.

          " 재실행 안전: 같은 자산태그(INVNR) 자산이 이미 있으면 그 번호로 회신
          lv_invnr = ls_pl-inventory_no.
          SELECT SINGLE anln1, anln2 FROM anla
            WHERE bukrs = @ls_env-company_code AND invnr = @lv_invnr
            INTO (@lv_anln1, @lv_anln2).
          IF sy-subrc = 0.
            WRITE / |  이미 있음 → { lv_anln1 }-{ lv_anln2 }|.
          ELSE.
            " 1차는 모든 필드. 자산 클래스 화면 레이아웃에서 입력 불가 필드(AY/219)면
            " 선택 필드(시리얼·룸·위치)를 빼고 한 번 더 시도하고, 회신에 W 메시지로 남긴다
            DO 2 TIMES.
              lv_try = sy-index.
              CLEAR: ls_key, ls_gen, ls_genx, ls_time, ls_timex, ls_pinf, ls_pinfx, lv_anln1, lv_anln2, ls_ret.
              ls_key-companycode = ls_env-company_code.
              ls_gen-assetclass = |{ ls_pl-asset_class ALPHA = IN WIDTH = 8 }|.
              ls_gen-descript   = ls_pl-description.
              ls_gen-invent_no  = ls_pl-inventory_no.
              ls_genx-assetclass = ls_genx-descript = ls_genx-invent_no = abap_true.
              ls_time-costcenter = |{ ls_pl-cost_center ALPHA = IN WIDTH = 10 }|.
              ls_timex-costcenter = abap_true.
              IF lv_try = 1.
                IF ls_pl-serial_no IS NOT INITIAL.
                  ls_gen-serial_no = ls_pl-serial_no.
                  ls_genx-serial_no = abap_true.
                ENDIF.
                IF p_loc = abap_true AND ls_pl-location IS NOT INITIAL.
                  ls_time-location = ls_pl-location.
                  ls_timex-location = abap_true.
                ENDIF.
                IF ls_pl-room IS NOT INITIAL.
                  ls_time-room = ls_pl-room.
                  ls_timex-room = abap_true.
                ENDIF.
              ENDIF.
              IF ls_pl-cap_date IS NOT INITIAL.
                ls_pinf-cap_date = replace( val = ls_pl-cap_date sub = '-' with = '' occ = 0 ).
                ls_pinfx-cap_date = abap_true.
              ENDIF.

              CALL FUNCTION 'BAPI_FIXEDASSET_CREATE1'
                EXPORTING
                  key                 = ls_key
                  testrun             = p_trun
                  generaldata         = ls_gen
                  generaldatax        = ls_genx
                  postinginformation  = ls_pinf
                  postinginformationx = ls_pinfx
                  timedependentdata   = ls_time
                  timedependentdatax  = ls_timex
                IMPORTING
                  asset               = lv_anln1
                  subnumber           = lv_anln2
                  return              = ls_ret.
              WRITE / |  BAPI({ lv_try }) { ls_ret-type } { ls_ret-id }/{ ls_ret-number } { ls_ret-message }|.

              IF ls_ret-type CA 'EA'.
                CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
                IF lv_try = 1 AND ls_ret-id = 'AY' AND ls_ret-number = '219'
                   AND ( ls_genx-serial_no = abap_true OR ls_timex-room = abap_true OR ls_timex-location = abap_true ).
                  lv_dropped = abap_true.
                  WRITE / '  입력 불가 필드 - 시리얼·룸·위치를 빼고 다시 시도'.
                  CONTINUE.
                ENDIF.
              ENDIF.
              EXIT.
            ENDDO.

            IF ls_ret-type CA 'EA'.
              ls_res-status = 'FAILED'.
              APPEND VALUE #( type = ls_ret-type id = ls_ret-id number = ls_ret-number text = ls_ret-message ) TO ls_res-messages.
            ELSEIF p_trun = abap_true.
              CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
            ELSE.
              CALL FUNCTION 'BAPI_TRANSACTION_COMMIT' EXPORTING wait = abap_true.
              WRITE / |  생성 → { lv_anln1 }-{ lv_anln2 }|.
            ENDIF.
            IF lv_dropped = abap_true AND ls_res-status IS INITIAL.
              APPEND VALUE #( type = 'W' id = 'AY' number = '219'
                              text = 'Serial no./room/location not ready for input in the asset class screen layout - not transferred to SAP' )
                TO ls_res-messages.
            ENDIF.
          ENDIF.

        WHEN 'ASSET_CHANGE'.
          " IF-AA-04: 바뀐 필드만 BAPI_FIXEDASSET_CHANGE (코스트센터는 시간종속 데이터)
          DATA(ls_f) = ls_pl-fields.
          WRITE / |{ ls_env-posting_id } CHANGE { ls_env-asset-asset_no }-{ ls_env-asset-sub_no } { ls_f-description } { ls_f-cost_center } { ls_f-location }|.
          DATA(lo_ch) = NEW lcl_bapi( 'BAPI_FIXEDASSET_CHANGE' ).
          lo_ch->set( iv_param = 'COMPANYCODE' iv_value = ls_env-company_code ).
          lo_ch->set( iv_param = 'ASSET' iv_value = ls_env-asset-asset_no ).
          lo_ch->set( iv_param = 'SUBNUMBER' iv_value = ls_env-asset-sub_no ).
          DATA(lv_nchg) = 0.
          IF ls_f-description IS NOT INITIAL.
            lo_ch->set( iv_param = 'GENERALDATA' iv_field = 'DESCRIPT' iv_value = ls_f-description ).
            lo_ch->set( iv_param = 'GENERALDATAX' iv_field = 'DESCRIPT' iv_value = abap_true ).
            lv_nchg = lv_nchg + 1.
          ENDIF.
          IF ls_f-serial_no IS NOT INITIAL.
            lo_ch->set( iv_param = 'GENERALDATA' iv_field = 'SERIAL_NO' iv_value = ls_f-serial_no ).
            lo_ch->set( iv_param = 'GENERALDATAX' iv_field = 'SERIAL_NO' iv_value = abap_true ).
            lv_nchg = lv_nchg + 1.
          ENDIF.
          IF ls_f-inventory_no IS NOT INITIAL.
            lo_ch->set( iv_param = 'GENERALDATA' iv_field = 'INVENT_NO' iv_value = ls_f-inventory_no ).
            lo_ch->set( iv_param = 'GENERALDATAX' iv_field = 'INVENT_NO' iv_value = abap_true ).
            lv_nchg = lv_nchg + 1.
          ENDIF.
          IF ls_f-cost_center IS NOT INITIAL.
            lo_ch->set( iv_param = 'TIMEDEPENDENTDATA' iv_field = 'COSTCENTER' iv_value = |{ ls_f-cost_center ALPHA = IN WIDTH = 10 }| ).
            lo_ch->set( iv_param = 'TIMEDEPENDENTDATAX' iv_field = 'COSTCENTER' iv_value = abap_true ).
            lv_nchg = lv_nchg + 1.
          ENDIF.
          IF ls_f-room IS NOT INITIAL.
            lo_ch->set( iv_param = 'TIMEDEPENDENTDATA' iv_field = 'ROOM' iv_value = ls_f-room ).
            lo_ch->set( iv_param = 'TIMEDEPENDENTDATAX' iv_field = 'ROOM' iv_value = abap_true ).
            lv_nchg = lv_nchg + 1.
          ENDIF.
          IF ls_f-location IS NOT INITIAL.
            IF p_loc = abap_true.
              lo_ch->set( iv_param = 'TIMEDEPENDENTDATA' iv_field = 'LOCATION' iv_value = ls_f-location ).
              lo_ch->set( iv_param = 'TIMEDEPENDENTDATAX' iv_field = 'LOCATION' iv_value = abap_true ).
              lv_nchg = lv_nchg + 1.
            ELSE.
              APPEND VALUE #( type = 'W' id = 'ZALM' number = '001'
                              text = |Location { ls_f-location } not transferred (P_LOC off)| ) TO ls_res-messages.
            ENDIF.
          ENDIF.
          IF lo_ch->mt_missing IS NOT INITIAL OR lo_ch->mv_ok = abap_false.
            WRITE / |  BAPI 서명 불일치: { concat_lines_of( table = lo_ch->mt_missing sep = `, ` ) } { lo_ch->mv_error }|.
            lo_ch->signature( ).
            lv_skip = abap_true.
          ELSEIF lv_nchg = 0.
            WRITE / '  SAP에 바꿀 필드 없음 → POSTED'.
          ELSE.
            IF lo_ch->has( 'TESTRUN' ).
              lo_ch->set( iv_param = 'TESTRUN' iv_value = p_trun ).
            ENDIF.
            lo_ch->call( ).
            ls_ret = lo_ch->ret( ).
            IF lo_ch->mv_error IS NOT INITIAL AND ls_ret IS INITIAL.
              ls_ret = VALUE #( type = 'E' id = 'ZALM' number = '002' message = lo_ch->mv_error ).
            ENDIF.
            WRITE / |  BAPI { ls_ret-type } { ls_ret-id }/{ ls_ret-number } { ls_ret-message }|.
            IF ls_ret-type CA 'EA'.
              CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
              ls_res-status = 'FAILED'.
              APPEND VALUE #( type = ls_ret-type id = ls_ret-id number = ls_ret-number text = ls_ret-message ) TO ls_res-messages.
            ELSEIF p_trun = abap_true.
              CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
            ELSE.
              CALL FUNCTION 'BAPI_TRANSACTION_COMMIT' EXPORTING wait = abap_true.
              WRITE / '  변경 완료'.
            ENDIF.
          ENDIF.

        WHEN 'ASSET_RETIRE'.
          " IF-AA-06: 전체 폐기(ABAVN). BKTXT=요청번호로 중복 전기 방지
          WRITE / |{ ls_env-posting_id } RETIRE { ls_env-asset-asset_no }-{ ls_env-asset-sub_no } { ls_pl-retire_type } { ls_pl-reason }|.
          IF ls_pl-retire_type = 'SALE'.
            WRITE / '  매각(SALE)은 아직 지원하지 않음 - 회신하지 않음(15분 뒤 다시 대상)'.
            lv_skip = abap_true.
          ELSEIF ls_pl-is_partial = abap_true.
            ls_res-status = 'FAILED'.
            APPEND VALUE #( type = 'E' id = 'ZALM' number = '003' text = 'Partial retirement is not supported (v1)' ) TO ls_res-messages.
          ELSE.
            lv_bktxt = ls_env-posting_id.
            CLEAR lv_deakt.
            SELECT SINGLE deakt FROM anla WHERE bukrs = @ls_env-company_code AND anln1 = @ls_env-asset-asset_no
              AND anln2 = @ls_env-asset-sub_no INTO @lv_deakt.
            SELECT SINGLE belnr, gjahr FROM bkpf
              WHERE bukrs = @ls_env-company_code AND bktxt = @lv_bktxt AND stblg = @space
              INTO @DATA(ls_bkpf).
            IF sy-subrc = 0.
              WRITE / |  이미 전기됨 → { ls_bkpf-belnr }/{ ls_bkpf-gjahr }|.
              ls_res-sap_document = VALUE #( belnr = ls_bkpf-belnr gjahr = ls_bkpf-gjahr ).
            ELSEIF lv_deakt IS NOT INITIAL.
              " 이미 비활성(전체 폐기)인데 요청번호 전표를 못 찾음: 이중 전기를 막기 위해 전기하지 않고 회신도 하지 않는다
              WRITE / '  자산이 이미 비활성(DEAKT) - 요청번호(BKTXT) 전표를 찾지 못해 전기하지 않음. AW01N에서 확인 필요'.
              lv_skip = abap_true.
            ELSE.
              DATA(lo_rt) = NEW lcl_bapi( 'BAPI_ASSET_RETIREMENT_POST' ).
              lo_rt->set( iv_param = 'GENERALPOSTINGDATA' iv_field = 'COMP_CODE' iv_value = ls_env-company_code ).
              lo_rt->set( iv_param = 'GENERALPOSTINGDATA' iv_field = 'ASSETMAINO' iv_value = ls_env-asset-asset_no ).
              lo_rt->set( iv_param = 'GENERALPOSTINGDATA' iv_field = 'ASSETSUBNO' iv_value = ls_env-asset-sub_no ).
              lo_rt->set( iv_param = 'GENERALPOSTINGDATA' iv_field = 'ASSETTRTYP' iv_value = p_ttret ).
              lo_rt->set( iv_param = 'GENERALPOSTINGDATA' iv_field = 'PSTNG_DATE' iv_value = lv_pdate ).
              lo_rt->set( iv_param = 'GENERALPOSTINGDATA' iv_field = 'DOC_DATE' iv_value = lv_pdate ).
              " 가치일은 RETIREMENTDATA-VALUEDATE, 머리글 텍스트(BKTXT)는 FURTHERPOSTINGDATA-HEADER_TXT (S/4 BAPIFAPO_* 서명)
              lo_rt->set( iv_param = 'RETIREMENTDATA' iv_field = 'COMPL_RET' iv_value = abap_true ).
              lo_rt->set( iv_param = 'RETIREMENTDATA' iv_field = 'VALUEDATE' iv_value = lv_vdate ).
              lo_rt->set( iv_param = 'FURTHERPOSTINGDATA' iv_field = 'HEADER_TXT' iv_value = ls_env-posting_id ).
              " TESTRUN 매개변수가 없는 시스템: 시험 실행은 호출 뒤 COMMIT 없이 ROLLBACK(업데이트 작업이 버려져 전기되지 않음)
              IF lo_rt->has( 'TESTRUN' ).
                lo_rt->set( iv_param = 'TESTRUN' iv_value = p_trun ).
              ENDIF.
              IF lo_rt->mt_missing IS NOT INITIAL OR lo_rt->mv_ok = abap_false.
                WRITE / |  BAPI 서명 불일치: { concat_lines_of( table = lo_rt->mt_missing sep = `, ` ) } { lo_rt->mv_error }|.
                lo_rt->signature( ).
                lv_skip = abap_true.
              ELSE.
                lo_rt->call( ).
                ls_ret = lo_rt->ret( ).
                IF lo_rt->mv_error IS NOT INITIAL AND ls_ret IS INITIAL.
                  ls_ret = VALUE #( type = 'E' id = 'ZALM' number = '002' message = lo_rt->mv_error ).
                ENDIF.
                WRITE / |  BAPI { ls_ret-type } { ls_ret-id }/{ ls_ret-number } { ls_ret-message }|.
                IF ls_ret-type CA 'EA'.
                  CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
                  ls_res-status = 'FAILED'.
                  APPEND VALUE #( type = ls_ret-type id = ls_ret-id number = ls_ret-number text = ls_ret-message ) TO ls_res-messages.
                ELSEIF p_trun = abap_true.
                  CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
                ELSE.
                  CALL FUNCTION 'BAPI_TRANSACTION_COMMIT' EXPORTING wait = abap_true.
                  " 회계전표 키 OBJ_KEY = BELNR(10) BUKRS(4) GJAHR(4)
                  lv_objkey = lo_rt->get( iv_param = 'DOCUMENTREFERENCE' iv_field = 'OBJ_KEY' ).
                  IF strlen( lv_objkey ) >= 18.
                    ls_res-sap_document = VALUE #( belnr = lv_objkey(10) gjahr = lv_objkey+14(4) ).
                  ELSE.
                    " 문서 참조가 비면 머리글 텍스트(BKTXT)로 방금 만든 전표를 찾는다
                    SELECT SINGLE belnr, gjahr FROM bkpf
                      WHERE bukrs = @ls_env-company_code AND bktxt = @lv_bktxt AND stblg = @space
                      INTO @DATA(ls_bk2).
                    IF sy-subrc = 0.
                      ls_res-sap_document = VALUE #( belnr = ls_bk2-belnr gjahr = ls_bk2-gjahr ).
                    ENDIF.
                  ENDIF.
                  WRITE / |  폐기 전기 → { ls_res-sap_document-belnr }/{ ls_res-sap_document-gjahr } (OBJ_KEY { lv_objkey })|.
                  IF ls_res-sap_document IS INITIAL.
                    " 전표를 확인하지 못하면 회신하지 않는다(15분 뒤 다시 가져가며, 그때 BKTXT 전표가 있으면 그 번호로 회신)
                    WRITE / '  전표를 찾지 못함 - AW01N·FB03에서 확인 필요. ALM에 회신하지 않음'.
                    lv_skip = abap_true.
                  ENDIF.
                ENDIF.
              ENDIF.
            ENDIF.
          ENDIF.

        WHEN 'COUNT_RESULT'.
          " IF-AA-07: 최종 실사일(ANLA-IVDAT)·재고 메모(ANLA-INVZU)를 BAPI_FIXEDASSET_CHANGE로
          lv_ivdat = replace( val = ls_pl-last_count_date sub = '-' with = '' occ = 0 ).
          lv_invzu = ls_pl-inventory_note.
          WRITE / |{ ls_env-posting_id } COUNT { ls_env-asset-asset_no }-{ ls_env-asset-sub_no } IVDAT { ls_pl-last_count_date } INVZU { ls_pl-inventory_note }|.
          SELECT SINGLE ivdat, invzu FROM anla
            WHERE bukrs = @ls_env-company_code AND anln1 = @ls_env-asset-asset_no AND anln2 = @ls_env-asset-sub_no
            INTO @DATA(ls_cur).
          IF sy-subrc <> 0.
            ls_res-status = 'FAILED'.
            APPEND VALUE #( type = 'E' id = 'ZALM' number = '004'
                            text = |Asset { ls_env-asset-asset_no }-{ ls_env-asset-sub_no } not found in company code { ls_env-company_code }| ) TO ls_res-messages.
            WRITE / '  SAP에 자산 없음 → FAILED'.
          ELSEIF ls_cur-ivdat = lv_ivdat AND ( lv_invzu IS INITIAL OR ls_cur-invzu = lv_invzu ).
            WRITE / '  SAP 값이 이미 같음 → POSTED'.
          ELSE.
            DATA(lo_ct) = NEW lcl_bapi( 'BAPI_FIXEDASSET_CHANGE' ).
            " 실사 정보는 INVENTORY(BAPI1022_FEGLG011: DATE·NOTE·INCLUDE_IN_LIST) 매개변수(S/4 서명 확인 2026-10-18)
            IF lo_ct->has( 'INVENTORY' ) = abap_false.
              WRITE / '  INVENTORY 매개변수가 없음 - 서명을 출력하고 회신하지 않음'.
              lo_ct->signature( ).
              lv_skip = abap_true.
            ELSE.
              lo_ct->set( iv_param = 'COMPANYCODE' iv_value = ls_env-company_code ).
              lo_ct->set( iv_param = 'ASSET' iv_value = ls_env-asset-asset_no ).
              lo_ct->set( iv_param = 'SUBNUMBER' iv_value = ls_env-asset-sub_no ).
              lo_ct->set( iv_param = 'INVENTORY' iv_field = 'DATE' iv_value = lv_ivdat ).
              lo_ct->set( iv_param = 'INVENTORYX' iv_field = 'DATE' iv_value = abap_true ).
              IF lv_invzu IS NOT INITIAL.
                lo_ct->set( iv_param = 'INVENTORY' iv_field = 'NOTE' iv_value = lv_invzu ).
                lo_ct->set( iv_param = 'INVENTORYX' iv_field = 'NOTE' iv_value = abap_true ).
              ENDIF.
              IF lo_ct->has( 'TESTRUN' ).
                lo_ct->set( iv_param = 'TESTRUN' iv_value = p_trun ).
              ENDIF.
              IF lo_ct->mt_missing IS NOT INITIAL OR lo_ct->mv_ok = abap_false.
                WRITE / |  BAPI 서명 불일치: { concat_lines_of( table = lo_ct->mt_missing sep = `, ` ) } { lo_ct->mv_error }|.
                lo_ct->signature( ).
                lv_skip = abap_true.
              ELSE.
                lo_ct->call( ).
                ls_ret = lo_ct->ret( ).
                IF lo_ct->mv_error IS NOT INITIAL AND ls_ret IS INITIAL.
                  ls_ret = VALUE #( type = 'E' id = 'ZALM' number = '002' message = lo_ct->mv_error ).
                ENDIF.
                WRITE / |  BAPI(INVENTORY) { ls_ret-type } { ls_ret-id }/{ ls_ret-number } { ls_ret-message }|.
                IF ls_ret-type CA 'EA'.
                  CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
                  ls_res-status = 'FAILED'.
                  APPEND VALUE #( type = ls_ret-type id = ls_ret-id number = ls_ret-number text = ls_ret-message ) TO ls_res-messages.
                ELSEIF p_trun = abap_true.
                  CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
                ELSE.
                  CALL FUNCTION 'BAPI_TRANSACTION_COMMIT' EXPORTING wait = abap_true.
                  WRITE / '  실사일 반영 완료'.
                ENDIF.
              ENDIF.
            ENDIF.
          ENDIF.

        WHEN OTHERS.
          WRITE / |{ ls_env-posting_id } { ls_env-type } - 이 프로그램은 처리하지 않음(회신 안 함)|.
          lv_skip = abap_true.
      ENDCASE.

      IF lv_skip = abap_true.
        CONTINUE.
      ENDIF.

      " 시험 실행은 결과(성공·실패 모두)를 ALM에 회신하지 않는다. 잠금은 15분 뒤 풀려 다시 대상이 된다
      IF p_trun = abap_true.
        WRITE / '  시험 실행 - ALM에 회신하지 않음(잠금 15분 뒤 해제)'.
        CONTINUE.
      ENDIF.
      IF ls_res-status IS INITIAL.
        ls_res-status = 'POSTED'.
        IF ls_env-type = 'ASSET_CREATE'.
          ls_res-asset = VALUE #( asset_no = lv_anln1 sub_no = lv_anln2 inventory_no = ls_pl-inventory_no ).
        ENDIF.
      ENDIF.
      DATA(lv_rjson) = /ui2/cl_json=>serialize( data = ls_res pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                                compress = abap_true ).
      go_api->request( iv_method = 'POST' iv_path = |/sap/postings/{ ls_env-posting_id }/result|
                       iv_key = |{ gv_batch }-RES-{ ls_env-posting_id }| iv_body = lv_rjson ).
    ENDLOOP.
  ENDIF.

*&---------------------------------------------------------------------*
*& ZALM_IF_POSTING - ALM → SAP 전기 잡(WBS 7.6 1단계: IF-AA-03 자산 생성, IF-AA-04 자산 변경)
*&   08 명세 4.2 전기 처리 흐름, 6.1·6.2
*&   1. POST /sap/postings:claim (ASSET_CREATE·ASSET_CHANGE만, 15분 잠금) → 2. 이미 POSTED면 BAPI 없이 회신
*&   3. 생성은 ANLA로 이미 만들어졌는지 확인(BUKRS·INVNR·ANLKL·ERNAM·ERDAT·DEAKT) → 4. BAPI(동적 호출)
*&   5. RETURN에 E·A가 없으면 ZALM_IF_LOG(POSTED)를 먼저 쓰고 BAPI_TRANSACTION_COMMIT(WAIT) → 6. 결과 회신
*&   7. 한 건이 실패해도 다음 건 계속 → 8. 끝에 회신 실패 건(최근 7일) 다시 회신
*&   BAPI는 CALL FUNCTION … PARAMETER-TABLE로 부르고 구조·필드는 이름으로 채운다(ASSIGN COMPONENT):
*&   릴리스마다 필드명이 달라도 활성화가 깨지지 않고, 없는 필드는 그 건의 오류 메시지로 드러난다(SE11 확인, D-13)
*&   변경에서 값을 비우는 것은 v1 미지원(빈 값 = 변경 없음). 미래 유효일 코스트센터 변경은 D-03 확정 전이라 FAILED
*&   P_TEST: BAPI TESTRUN = X(커밋·로그·회신 없음). 단, claim은 하므로 그 건은 15분 뒤 다시 대상이 되고 시도 횟수가 1 오른다
*&---------------------------------------------------------------------*
REPORT zalm_if_posting.

CONSTANTS: gc_if_create TYPE c LENGTH 10 VALUE 'IF-AA-03',
           gc_if_change TYPE c LENGTH 10 VALUE 'IF-AA-04'.

DATA gv_bukrs_sel TYPE bukrs.

SELECT-OPTIONS s_bukrs FOR gv_bukrs_sel NO INTERVALS.
PARAMETERS: p_api  TYPE rfcdest DEFAULT 'ZALM_API' OBLIGATORY,
            p_tok  TYPE rfcdest DEFAULT 'ZALM_TOKEN' OBLIGATORY,
            p_max  TYPE i DEFAULT 50 OBLIGATORY,
            p_test AS CHECKBOX DEFAULT ' '.

TYPES:
  BEGIN OF gty_asref,
    asset_no     TYPE string,
    sub_no       TYPE string,
    inventory_no TYPE string,
  END OF gty_asref,
  BEGIN OF gty_item,
    posting_id   TYPE string,
    type         TYPE string,
    company_code TYPE string,
    posting_date TYPE string,
    value_date   TYPE string,
    asset        TYPE gty_asref,
    payload      TYPE /ui2/cl_json=>json,
    approved_by  TYPE string,
    approved_at  TYPE string,
    attempt      TYPE i,
    lease_until  TYPE string,
  END OF gty_item,
  BEGIN OF gty_claim,
    batch_id      TYPE string,
    lease_seconds TYPE i,
    items         TYPE STANDARD TABLE OF gty_item WITH EMPTY KEY,
  END OF gty_claim,
  BEGIN OF gty_create,
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
  END OF gty_create,
  BEGIN OF gty_fields,
    description  TYPE string,
    serial_no    TYPE string,
    inventory_no TYPE string,
    location     TYPE string,
    room         TYPE string,
    cost_center  TYPE string,
  END OF gty_fields,
  BEGIN OF gty_change,
    fields                 TYPE gty_fields,
    cost_center_valid_from TYPE string,
  END OF gty_change,
  BEGIN OF gty_msg,
    type   TYPE string,
    id     TYPE string,
    number TYPE string,
    text   TYPE string,
  END OF gty_msg,
  BEGIN OF gty_result,
    posting_id TYPE string,
    status     TYPE string,
    asset      TYPE gty_asref,
    messages   TYPE STANDARD TABLE OF gty_msg WITH EMPTY KEY,
  END OF gty_result,
  BEGIN OF gty_claim_req,
    batch_id  TYPE string,
    max_items TYPE i,
    types     TYPE string_table,
  END OF gty_claim_req.

CLASS lcl_post DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run.

  PRIVATE SECTION.
    DATA mt_bukrs TYPE STANDARD TABLE OF bukrs WITH EMPTY KEY.
    DATA mo_api TYPE REF TO zcl_alm_http_client.
    DATA mv_bukrs TYPE bukrs.
    DATA mv_batch TYPE string.
    DATA mv_stamp TYPE string.
    DATA mv_any_failed TYPE abap_bool.
    DATA mv_locked TYPE abap_bool.

    METHODS targets.
    METHODS lock RETURNING VALUE(rv_ok) TYPE abap_bool.
    METHODS unlock.
    METHODS finish.
    METHODS one_company IMPORTING iv_bukrs TYPE bukrs.
    METHODS process IMPORTING is_item TYPE gty_item.
    METHODS handle_create
      IMPORTING is_item  TYPE gty_item
                io_log   TYPE REF TO zcl_alm_log
      EXPORTING es_asset TYPE gty_asref
      CHANGING  ct_ret   TYPE bapirettab
      RAISING   cx_sy_create_data_error cx_sy_dyn_call_error.
    METHODS handle_change
      IMPORTING is_item  TYPE gty_item
                io_log   TYPE REF TO zcl_alm_log
      EXPORTING es_asset TYPE gty_asref
      CHANGING  ct_ret   TYPE bapirettab
      RAISING   cx_sy_create_data_error cx_sy_dyn_call_error.
    METHODS call_bapi
      IMPORTING iv_fm   TYPE csequence
      CHANGING  ct_ptab TYPE abap_func_parmbind_tab
                ct_ret  TYPE bapirettab
      RAISING   cx_sy_create_data_error.
    METHODS reply
      IMPORTING is_res     TYPE gty_result
                iv_key     TYPE csequence
                io_log     TYPE REF TO zcl_alm_log OPTIONAL
                iv_log_id  TYPE zalm_if_log-log_id OPTIONAL
      RETURNING VALUE(rv_http) TYPE i.
    METHODS resend.
    METHODS setf
      IMPORTING ir_struct TYPE REF TO data
                ir_x      TYPE REF TO data OPTIONAL
                iv_field  TYPE csequence
                iv_val    TYPE csequence
                iv_alpha  TYPE abap_bool DEFAULT abap_false
                iv_type   TYPE csequence
      CHANGING  ct_ret    TYPE bapirettab.
    METHODS err
      IMPORTING iv_text TYPE csequence
      CHANGING  ct_ret  TYPE bapirettab.
    METHODS to_date
      IMPORTING iv_iso      TYPE csequence
      RETURNING VALUE(rv_d) TYPE d.
    METHODS approved_date
      IMPORTING iv_iso      TYPE csequence
      RETURNING VALUE(rv_d) TYPE d.
ENDCLASS.


CLASS lcl_post IMPLEMENTATION.

  METHOD run.
    DATA lv_ts TYPE timestamp.

    GET TIME STAMP FIELD lv_ts.
    mv_stamp = |{ lv_ts }|.

    targets( ).
    IF mt_bukrs IS INITIAL.
      MESSAGE '대상 회사코드가 없습니다. S_BUKRS를 넣거나 ZALM_IF_CONFIG에서 BUKRS를 등록하세요' TYPE 'E'.
    ENDIF.

    IF p_test = abap_false AND lock( ) = abap_false.
      MESSAGE '전기 잡이 이미 실행 중입니다(잠금). 끝난 뒤 다시 실행하세요' TYPE 'E'.
    ENDIF.

    LOOP AT mt_bukrs INTO DATA(lv_bukrs).
      one_company( lv_bukrs ).
    ENDLOOP.

    unlock( ).
    finish( ).
  ENDMETHOD.


  METHOD targets.
    IF s_bukrs[] IS NOT INITIAL.
      SELECT bukrs FROM t001 WHERE bukrs IN @s_bukrs ORDER BY bukrs INTO TABLE @mt_bukrs.
    ELSE.
      DATA(lt_cfg) = zcl_alm_cfg=>get_list( zcl_alm_cfg=>c_bukrs ).
      LOOP AT lt_cfg INTO DATA(lv_cfg).
        APPEND CONV bukrs( lv_cfg ) TO mt_bukrs.
      ENDLOOP.
      SORT mt_bukrs.
      DELETE ADJACENT DUPLICATES FROM mt_bukrs.
    ENDIF.
  ENDMETHOD.


  METHOD lock.
    " VARKEY는 RSTABLE-VARKEY 유형이어야 한다
    DATA lv_varkey TYPE rstable-varkey.
    lv_varkey = 'POSTING'.
    CALL FUNCTION 'ENQUEUE_E_TABLE'
      EXPORTING
        mode_rstable   = 'E'
        tabname        = 'ZALM_IF_LOG'
        varkey         = lv_varkey
      EXCEPTIONS
        foreign_lock   = 1
        system_failure = 2
        OTHERS         = 3.
    rv_ok = xsdbool( sy-subrc = 0 ).
    mv_locked = rv_ok.
  ENDMETHOD.


  METHOD unlock.
    DATA lv_varkey TYPE rstable-varkey.
    IF mv_locked = abap_true.
      lv_varkey = 'POSTING'.
      CALL FUNCTION 'DEQUEUE_E_TABLE'
        EXPORTING
          mode_rstable = 'E'
          tabname      = 'ZALM_IF_LOG'
          varkey       = lv_varkey.
      mv_locked = abap_false.
    ENDIF.
  ENDMETHOD.


  METHOD finish.
    IF mv_any_failed = abap_true.
      IF sy-batch = abap_true.
        MESSAGE '전기 실패가 있습니다. SLG1(객체 ZALM)과 ZALM_IF_LOG를 확인하세요' TYPE 'E'.
      ELSE.
        MESSAGE '전기 실패가 있습니다. SLG1(객체 ZALM)과 ZALM_IF_LOG를 확인하세요' TYPE 'S' DISPLAY LIKE 'E'.
      ENDIF.
    ELSE.
      MESSAGE '전기 완료' TYPE 'S'.
    ENDIF.
  ENDMETHOD.


  METHOD one_company.
    mv_bukrs = iv_bukrs.
    mv_batch = |POST-{ mv_stamp(14) }-{ iv_bukrs }|.
    DATA(lo_log) = NEW zcl_alm_log( iv_if_id = 'IF-AA-03' iv_batch_id = mv_batch iv_bukrs = iv_bukrs ).
    mo_api = NEW #( iv_bukrs = iv_bukrs iv_dest_api = p_api iv_dest_token = p_tok ).

    lo_log->add( |전기 잡(IF-AA-03·04) { COND string( WHEN p_test = abap_true THEN `시험 실행(TESTRUN)` ELSE `실행` ) }: 회사코드 { iv_bukrs }, 배치 { mv_batch }, SAP 시스템 { mo_api->system_id( ) }| ).

    IF zcl_alm_cfg=>get( zcl_alm_cfg=>c_post_block ) IS NOT INITIAL.
      lo_log->add( iv_type = 'W' iv_text = 'ZALM_CFG POST_BLOCK = X: 월말 마감 중이라 전기를 건너뜁니다' ).
      lo_log->set_result( iv_status = zcl_alm_log=>c_success iv_rec_cnt = 0 ).
      IF p_test = abap_false.
        lo_log->save( iv_commit = abap_true ).
      ENDIF.
      RETURN.
    ENDIF.

    DATA ls_req TYPE gty_claim_req.
    DATA ls_claim TYPE gty_claim.
    ls_req-batch_id = mv_batch.
    ls_req-max_items = p_max.
    ls_req-types = VALUE #( ( `ASSET_CREATE` ) ( `ASSET_CHANGE` ) ).
    TRY.
        DATA(ls_resp) = mo_api->post( iv_path = '/sap/postings:claim' iv_body = zcl_alm_http_client=>to_json( ls_req ) iv_key = mv_batch ).
        IF ls_resp-status <> 200.
          DATA(ls_prob) = zcl_alm_http_client=>parse_problem( ls_resp-body ).
          lo_log->add( iv_type = 'E' iv_text = |claim 실패 HTTP { ls_resp-status } { ls_prob-code } { ls_prob-detail }| ).
          lo_log->set_result( iv_status = zcl_alm_log=>c_failed iv_http = ls_resp-status ).
          IF p_test = abap_false.
            lo_log->save( iv_commit = abap_true ).
          ENDIF.
          mv_any_failed = abap_true.
          RETURN.
        ENDIF.
        /ui2/cl_json=>deserialize( EXPORTING json = ls_resp-body pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                   CHANGING data = ls_claim ).
      CATCH zcx_alm INTO DATA(lx).
        lo_log->add( iv_type = 'E' iv_text = |claim 통신 오류: { lx->get_text( ) }| ).
        lo_log->set_result( iv_status = zcl_alm_log=>c_failed ).
        IF p_test = abap_false.
          lo_log->save( iv_commit = abap_true ).
        ENDIF.
        mv_any_failed = abap_true.
        RETURN.
    ENDTRY.

    lo_log->add( |claim: { lines( ls_claim-items ) }건(최대 { p_max })| ).
    lo_log->set_result( iv_status = zcl_alm_log=>c_success iv_rec_cnt = lines( ls_claim-items ) ).
    IF p_test = abap_false.
      lo_log->save( iv_commit = abap_true ).
    ENDIF.

    LOOP AT ls_claim-items INTO DATA(ls_item).
      process( ls_item ).
    ENDLOOP.

    IF p_test = abap_false.
      resend( ).
    ENDIF.
  ENDMETHOD.


  METHOD process.
    DATA ls_res TYPE gty_result.
    DATA ls_asset TYPE gty_asref.
    DATA lt_ret TYPE bapirettab.

    DATA(lv_if) = COND #( WHEN is_item-type = 'ASSET_CREATE' THEN gc_if_create ELSE gc_if_change ).
    DATA(lo_log) = NEW zcl_alm_log( iv_if_id = lv_if iv_batch_id = mv_batch iv_posting_id = is_item-posting_id iv_bukrs = mv_bukrs ).
    ls_res-posting_id = is_item-posting_id.
    lo_log->add( |{ is_item-posting_id } { is_item-type } 시도 { is_item-attempt }| ).

    " 2. 같은 postingId가 이미 POSTED면 BAPI를 다시 부르지 않고 저장된 결과를 회신
    DATA(ls_prev) = zcl_alm_log=>find_posting( is_item-posting_id ).
    IF p_test = abap_false AND ls_prev-status = zcl_alm_log=>c_posted.
      ls_res-status = 'POSTED'.
      ls_res-asset = VALUE #( asset_no = ls_prev-anln1 sub_no = ls_prev-anln2 ).
      DATA(lv_h) = reply( is_res = ls_res iv_key = |{ is_item-posting_id }-{ is_item-attempt }| iv_log_id = ls_prev-log_id ).
      WRITE: / is_item-posting_id, 'POSTED 로그가 있어 저장된 결과를 회신', lv_h.
      RETURN.
    ENDIF.

    IF is_item-company_code <> mv_bukrs.
      err( EXPORTING iv_text = |전기 건의 회사코드({ is_item-company_code })가 연결 회사코드({ mv_bukrs })와 다릅니다| CHANGING ct_ret = lt_ret ).
    ELSE.
      TRY.
          CASE is_item-type.
            WHEN 'ASSET_CREATE'.
              handle_create( EXPORTING is_item = is_item io_log = lo_log IMPORTING es_asset = ls_asset CHANGING ct_ret = lt_ret ).
            WHEN 'ASSET_CHANGE'.
              handle_change( EXPORTING is_item = is_item io_log = lo_log IMPORTING es_asset = ls_asset CHANGING ct_ret = lt_ret ).
            WHEN OTHERS.
              err( EXPORTING iv_text = |지원하지 않는 유형 { is_item-type }| CHANGING ct_ret = lt_ret ).
          ENDCASE.
        CATCH cx_sy_create_data_error cx_sy_dyn_call_error INTO DATA(lx_dyn).
          err( EXPORTING iv_text = |BAPI 호출 준비 오류: { lx_dyn->get_text( ) } (SE37·SE11에서 BAPI 구조 확인)| CHANGING ct_ret = lt_ret ).
      ENDTRY.
    ENDIF.

    DATA(lv_err) = abap_false.
    LOOP AT lt_ret INTO DATA(ls_r).
      lo_log->add( iv_type = COND #( WHEN ls_r-type CA 'EAWSI' THEN ls_r-type ELSE 'I' )
                   iv_text = |{ ls_r-id }{ ls_r-number } { ls_r-message }| ).
      IF ls_r-type = 'E' OR ls_r-type = 'A'.
        lv_err = abap_true.
        APPEND VALUE #( type = ls_r-type id = ls_r-id number = ls_r-number text = ls_r-message ) TO ls_res-messages.
      ENDIF.
    ENDLOOP.

    IF lv_err = abap_true.
      CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
      ls_res-status = 'FAILED'.
      mv_any_failed = abap_true.
      IF p_test = abap_true.
        WRITE: / is_item-posting_id, 'TESTRUN 오류', COND string( WHEN ls_res-messages IS NOT INITIAL THEN ls_res-messages[ 1 ]-text ).
        RETURN.
      ENDIF.
      lo_log->set_result( iv_status = zcl_alm_log=>c_failed iv_rec_cnt = 1 iv_err_cnt = 1 ).
      lo_log->save( iv_commit = abap_true ).
    ELSEIF p_test = abap_true.
      CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
      WRITE: / is_item-posting_id, 'TESTRUN 정상', ls_asset-asset_no.
      RETURN.
    ELSE.
      " 5. 로그를 먼저 쓰고 같은 LUW에서 커밋한다(커밋 뒤 덤프가 나도 다음 실행이 2단계에서 멈춘다)
      ls_res-status = 'POSTED'.
      ls_res-asset = VALUE #( asset_no = ls_asset-asset_no sub_no = ls_asset-sub_no ).
      lo_log->set_posting( iv_anln1 = CONV #( ls_asset-asset_no ) iv_anln2 = CONV #( ls_asset-sub_no ) ).
      lo_log->set_result( iv_status = zcl_alm_log=>c_posted iv_rec_cnt = 1 ).
      lo_log->save( ).
      CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
        EXPORTING
          wait = abap_true.
    ENDIF.

    " 6. 결과 회신
    DATA(lv_http) = reply( is_res = ls_res iv_key = |{ is_item-posting_id }-{ is_item-attempt }| io_log = lo_log ).
    WRITE: / is_item-posting_id, ls_res-status, ls_res-asset-asset_no, lv_http.
  ENDMETHOD.


  METHOD handle_create.
    DATA ls_p TYPE gty_create.
    DATA lr_key TYPE REF TO data.
    DATA lr_gd TYPE REF TO data.
    DATA lr_gdx TYPE REF TO data.
    DATA lr_pi TYPE REF TO data.
    DATA lr_pix TYPE REF TO data.
    DATA lr_td TYPE REF TO data.
    DATA lr_tdx TYPE REF TO data.
    DATA lv_testrun TYPE c LENGTH 1.
    DATA lv_cc TYPE bukrs.
    DATA lv_asset TYPE anln1.
    DATA lv_sub TYPE anln2.

    /ui2/cl_json=>deserialize( EXPORTING json = is_item-payload pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                               CHANGING data = ls_p ).
    IF ls_p-asset_class IS INITIAL OR ls_p-description IS INITIAL OR ls_p-cost_center IS INITIAL OR ls_p-inventory_no IS INITIAL.
      err( EXPORTING iv_text = 'ASSET_CREATE payload에 assetClass·description·costCenter·inventoryNo가 모두 필요합니다' CHANGING ct_ret = ct_ret ).
      RETURN.
    ENDIF.

    " 3. 로그가 없어도 SAP에 이미 만들어졌는지 확인(로그 유실·덤프 대비). 조건을 좁혀 사람이 만든 같은 태그 자산을 잡지 않게 한다
    DATA(lv_cls) = CONV anla-anlkl( |{ ls_p-asset_class ALPHA = IN }| ).
    DATA(lv_inv) = CONV anla-invnr( ls_p-inventory_no ).
    DATA lv_from TYPE d.
    lv_from = approved_date( is_item-approved_at ) - 1.
    SELECT SINGLE anln1, anln2 FROM anla
      WHERE bukrs = @is_item-company_code AND invnr = @lv_inv AND anlkl = @lv_cls
        AND ernam = @sy-uname AND erdat >= @lv_from AND deakt = '00000000'
      INTO @DATA(ls_dup).
    IF sy-subrc = 0.
      es_asset = VALUE #( asset_no = ls_dup-anln1 sub_no = ls_dup-anln2 ).
      io_log->add( |이미 SAP에 생성된 자산 { ls_dup-anln1 }-{ ls_dup-anln2 }이(가) 있어 BAPI를 부르지 않고 그 번호로 POSTED 처리합니다| ).
      RETURN.
    ENDIF.

    CREATE DATA lr_key TYPE ('BAPI1022_KEY').
    CREATE DATA lr_gd TYPE ('BAPI1022_FEGLG001').
    CREATE DATA lr_gdx TYPE ('BAPI1022_FEGLG001X').
    CREATE DATA lr_pi TYPE ('BAPI1022_FEGLG002').
    CREATE DATA lr_pix TYPE ('BAPI1022_FEGLG002X').
    CREATE DATA lr_td TYPE ('BAPI1022_FEGLG003').
    CREATE DATA lr_tdx TYPE ('BAPI1022_FEGLG003X').

    setf( EXPORTING ir_struct = lr_key iv_field = 'COMPANYCODE' iv_val = is_item-company_code iv_type = 'KEY' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_gd ir_x = lr_gdx iv_field = 'ASSETCLASS' iv_val = ls_p-asset_class iv_alpha = abap_true iv_type = 'GENERALDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_gd ir_x = lr_gdx iv_field = 'DESCRIPT' iv_val = ls_p-description iv_type = 'GENERALDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_gd ir_x = lr_gdx iv_field = 'SERIAL_NO' iv_val = ls_p-serial_no iv_type = 'GENERALDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_gd ir_x = lr_gdx iv_field = 'INVENT_NO' iv_val = ls_p-inventory_no iv_type = 'GENERALDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_pi ir_x = lr_pix iv_field = 'CAP_DATE' iv_val = ls_p-cap_date iv_type = 'POSTINGINFORMATION' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_td ir_x = lr_tdx iv_field = 'COSTCENTER' iv_val = ls_p-cost_center iv_alpha = abap_true iv_type = 'TIMEDEPENDENTDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_td ir_x = lr_tdx iv_field = 'LOCATION' iv_val = ls_p-location iv_type = 'TIMEDEPENDENTDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_td ir_x = lr_tdx iv_field = 'ROOM' iv_val = ls_p-room iv_type = 'TIMEDEPENDENTDATA' CHANGING ct_ret = ct_ret ).
    IF ct_ret IS NOT INITIAL.
      RETURN.   " 구조·필드 이름 오류 — BAPI를 부르지 않는다
    ENDIF.

    lv_testrun = COND #( WHEN p_test = abap_true THEN 'X' ELSE ' ' ).
    DATA(lt_ptab) = VALUE abap_func_parmbind_tab(
      ( name = 'KEY'                kind = abap_func_exporting value = lr_key )
      ( name = 'TESTRUN'            kind = abap_func_exporting value = REF #( lv_testrun ) )
      ( name = 'GENERALDATA'        kind = abap_func_exporting value = lr_gd )
      ( name = 'GENERALDATAX'       kind = abap_func_exporting value = lr_gdx )
      ( name = 'POSTINGINFORMATION' kind = abap_func_exporting value = lr_pi )
      ( name = 'POSTINGINFORMATIONX' kind = abap_func_exporting value = lr_pix )
      ( name = 'TIMEDEPENDENTDATA'  kind = abap_func_exporting value = lr_td )
      ( name = 'TIMEDEPENDENTDATAX' kind = abap_func_exporting value = lr_tdx )
      ( name = 'COMPANYCODE'        kind = abap_func_importing value = REF #( lv_cc ) )
      ( name = 'ASSET'              kind = abap_func_importing value = REF #( lv_asset ) )
      ( name = 'SUBNUMBER'          kind = abap_func_importing value = REF #( lv_sub ) ) ).
    call_bapi( EXPORTING iv_fm = 'BAPI_FIXEDASSET_CREATE1' CHANGING ct_ptab = lt_ptab ct_ret = ct_ret ).
    es_asset = VALUE #( asset_no = lv_asset sub_no = lv_sub ).
    IF p_test = abap_false AND lv_asset IS INITIAL AND NOT line_exists( ct_ret[ type = 'E' ] ) AND NOT line_exists( ct_ret[ type = 'A' ] ).
      err( EXPORTING iv_text = 'BAPI가 오류 없이 끝났지만 자산번호를 돌려주지 않았습니다' CHANGING ct_ret = ct_ret ).
    ENDIF.
  ENDMETHOD.


  METHOD handle_change.
    DATA ls_p TYPE gty_change.
    DATA lr_key TYPE REF TO data.
    DATA lr_gd TYPE REF TO data.
    DATA lr_gdx TYPE REF TO data.
    DATA lr_td TYPE REF TO data.
    DATA lr_tdx TYPE REF TO data.
    DATA lv_testrun TYPE c LENGTH 1.

    /ui2/cl_json=>deserialize( EXPORTING json = is_item-payload pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                               CHANGING data = ls_p ).
    IF is_item-asset-asset_no IS INITIAL.
      err( EXPORTING iv_text = 'ASSET_CHANGE 전기 건에 asset.assetNo가 없습니다' CHANGING ct_ret = ct_ret ).
      RETURN.
    ENDIF.
    DATA(lv_a1) = CONV anln1( |{ is_item-asset-asset_no ALPHA = IN }| ).
    DATA(lv_a2) = CONV anln2( COND string( WHEN is_item-asset-sub_no IS INITIAL THEN `0000` ELSE is_item-asset-sub_no ) ).
    es_asset = VALUE #( asset_no = lv_a1 sub_no = lv_a2 ).

    SELECT SINGLE anln1 FROM anla WHERE bukrs = @is_item-company_code AND anln1 = @lv_a1 AND anln2 = @lv_a2 INTO @DATA(lv_exists).
    IF sy-subrc <> 0.
      err( EXPORTING iv_text = |자산 { is_item-company_code }/{ lv_a1 }-{ lv_a2 }이(가) SAP에 없습니다| CHANGING ct_ret = ct_ret ).
      RETURN.
    ENDIF.
    IF ls_p-fields IS INITIAL.
      io_log->add( 'fields가 비어 있어 변경할 것이 없습니다(변경 없음으로 POSTED 처리)' ).
      RETURN.
    ENDIF.
    IF ls_p-fields-cost_center IS NOT INITIAL AND ls_p-cost_center_valid_from IS NOT INITIAL AND to_date( ls_p-cost_center_valid_from ) > sy-datum.
      err( EXPORTING iv_text = |코스트센터 유효시작일({ ls_p-cost_center_valid_from })이 미래입니다. 미래일자 시간종속 변경 방식은 D-03 확정 전이라 지원하지 않습니다| CHANGING ct_ret = ct_ret ).
      RETURN.
    ENDIF.

    CREATE DATA lr_key TYPE ('BAPI1022_KEY').
    CREATE DATA lr_gd TYPE ('BAPI1022_FEGLG001').
    CREATE DATA lr_gdx TYPE ('BAPI1022_FEGLG001X').
    CREATE DATA lr_td TYPE ('BAPI1022_FEGLG003').
    CREATE DATA lr_tdx TYPE ('BAPI1022_FEGLG003X').

    setf( EXPORTING ir_struct = lr_key iv_field = 'COMPANYCODE' iv_val = is_item-company_code iv_type = 'KEY' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_key iv_field = 'ASSET' iv_val = lv_a1 iv_type = 'KEY' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_key iv_field = 'SUBNUMBER' iv_val = lv_a2 iv_type = 'KEY' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_gd ir_x = lr_gdx iv_field = 'DESCRIPT' iv_val = ls_p-fields-description iv_type = 'GENERALDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_gd ir_x = lr_gdx iv_field = 'SERIAL_NO' iv_val = ls_p-fields-serial_no iv_type = 'GENERALDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_gd ir_x = lr_gdx iv_field = 'INVENT_NO' iv_val = ls_p-fields-inventory_no iv_type = 'GENERALDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_td ir_x = lr_tdx iv_field = 'COSTCENTER' iv_val = ls_p-fields-cost_center iv_alpha = abap_true iv_type = 'TIMEDEPENDENTDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_td ir_x = lr_tdx iv_field = 'LOCATION' iv_val = ls_p-fields-location iv_type = 'TIMEDEPENDENTDATA' CHANGING ct_ret = ct_ret ).
    setf( EXPORTING ir_struct = lr_td ir_x = lr_tdx iv_field = 'ROOM' iv_val = ls_p-fields-room iv_type = 'TIMEDEPENDENTDATA' CHANGING ct_ret = ct_ret ).
    IF ct_ret IS NOT INITIAL.
      RETURN.
    ENDIF.

    lv_testrun = COND #( WHEN p_test = abap_true THEN 'X' ELSE ' ' ).
    DATA(lt_ptab) = VALUE abap_func_parmbind_tab(
      ( name = 'KEY'                kind = abap_func_exporting value = lr_key )
      ( name = 'TESTRUN'            kind = abap_func_exporting value = REF #( lv_testrun ) )
      ( name = 'GENERALDATA'        kind = abap_func_exporting value = lr_gd )
      ( name = 'GENERALDATAX'       kind = abap_func_exporting value = lr_gdx )
      ( name = 'TIMEDEPENDENTDATA'  kind = abap_func_exporting value = lr_td )
      ( name = 'TIMEDEPENDENTDATAX' kind = abap_func_exporting value = lr_tdx ) ).
    call_bapi( EXPORTING iv_fm = 'BAPI_FIXEDASSET_CHANGE' CHANGING ct_ptab = lt_ptab ct_ret = ct_ret ).
  ENDMETHOD.


  METHOD call_bapi.
    " BAPI의 메시지 파라미터 이름·종류는 릴리스마다 달라(RETURN이 없을 수 있음) 함수 인터페이스(FUPARAREF)에서 찾아 붙인다.
    " 인터페이스에 없는 선택 파라미터(TESTRUN·X 구조 등)는 빼고 경고를 남긴다
    TYPES: BEGIN OF lty_par,
             parameter TYPE fupararef-parameter,
             paramtype TYPE fupararef-paramtype,
             structure TYPE fupararef-structure,
           END OF lty_par.
    DATA lt_par TYPE STANDARD TABLE OF lty_par WITH EMPTY KEY.
    DATA lv_fm TYPE fupararef-funcname.
    DATA lr_ret TYPE REF TO data.
    DATA lt_return TYPE bapirettab.
    DATA ls_r TYPE bapiret2.
    DATA lv_dropped TYPE string.
    DATA lv_list TYPE string.
    FIELD-SYMBOLS <ls_x> TYPE any.
    FIELD-SYMBOLS <lt_x> TYPE ANY TABLE.
    FIELD-SYMBOLS <ls_row> TYPE any.

    lv_fm = iv_fm.
    SELECT parameter, paramtype, structure FROM fupararef
      WHERE funcname = @lv_fm AND r3state = 'A'
      INTO CORRESPONDING FIELDS OF TABLE @lt_par.
    IF lt_par IS INITIAL.
      SELECT parameter, paramtype, structure FROM fupararef
        WHERE funcname = @lv_fm
        INTO CORRESPONDING FIELDS OF TABLE @lt_par.
    ENDIF.
    IF lt_par IS INITIAL.
      err( EXPORTING iv_text = |함수 { iv_fm }의 인터페이스(FUPARAREF)를 읽지 못했습니다. SE37에서 함수가 있는지 확인하세요| CHANGING ct_ret = ct_ret ).
      RETURN.
    ENDIF.
    lv_list = concat_lines_of( table = VALUE string_table( FOR p IN lt_par ( |{ p-parameter }({ p-paramtype })| ) ) sep = ` ` ).

    DATA(lt_keep) = VALUE abap_func_parmbind_tab( ).
    LOOP AT ct_ptab INTO DATA(ls_pt).
      IF line_exists( lt_par[ parameter = ls_pt-name ] ).
        INSERT ls_pt INTO TABLE lt_keep.
      ELSE.
        lv_dropped = |{ lv_dropped } { ls_pt-name }|.
      ENDIF.
    ENDLOOP.
    IF lv_dropped IS NOT INITIAL.
      APPEND VALUE #( type = 'W' id = 'ZALM' number = '000' message = |{ iv_fm }에 없는 파라미터를 뺐습니다:{ lv_dropped }| ) TO ct_ret.
    ENDIF.

    " 메시지 파라미터: 구조가 BAPIRET*이거나 이름이 RETURN
    DATA(lv_found) = abap_false.
    LOOP AT lt_par INTO DATA(ls_par) WHERE structure CP 'BAPIRET*' OR parameter = 'RETURN'.
      lv_found = abap_true.
      EXIT.
    ENDLOOP.
    IF lv_found = abap_false.
      err( EXPORTING iv_text = |{ iv_fm }에서 메시지(BAPIRET2) 파라미터를 찾지 못했습니다. 파라미터: { lv_list }| CHANGING ct_ret = ct_ret ).
      RETURN.
    ENDIF.
    CASE ls_par-paramtype.
      WHEN 'T'.
        INSERT VALUE #( name = ls_par-parameter kind = abap_func_tables value = REF #( lt_return ) ) INTO TABLE lt_keep.
      WHEN 'E'.
        CREATE DATA lr_ret TYPE (ls_par-structure).
        INSERT VALUE #( name = ls_par-parameter kind = abap_func_importing value = lr_ret ) INTO TABLE lt_keep.
      WHEN OTHERS.
        err( EXPORTING iv_text = |{ iv_fm } 메시지 파라미터 { ls_par-parameter }의 종류({ ls_par-paramtype })를 지원하지 않습니다. 파라미터: { lv_list }| CHANGING ct_ret = ct_ret ).
        RETURN.
    ENDCASE.

    DATA(lt_etab) = VALUE abap_func_excpbind_tab( ( name = 'OTHERS' value = 99 ) ).
    TRY.
        CALL FUNCTION iv_fm
          PARAMETER-TABLE lt_keep
          EXCEPTION-TABLE lt_etab.
        IF sy-subrc <> 0.
          err( EXPORTING iv_text = |{ iv_fm } 호출 예외(sy-subrc { sy-subrc })| CHANGING ct_ret = ct_ret ).
        ENDIF.
      CATCH cx_sy_dyn_call_error INTO DATA(lx).
        err( EXPORTING iv_text = |{ iv_fm } 호출 오류: { lx->get_text( ) }. 인터페이스 파라미터: { lv_list }| CHANGING ct_ret = ct_ret ).
        RETURN.
    ENDTRY.

    IF lr_ret IS BOUND.
      ASSIGN lr_ret->* TO <ls_x>.
      IF cl_abap_typedescr=>describe_by_data( <ls_x> )->kind = cl_abap_typedescr=>kind_table.
        ASSIGN lr_ret->* TO <lt_x>.
        LOOP AT <lt_x> ASSIGNING <ls_row>.
          CLEAR ls_r.
          MOVE-CORRESPONDING <ls_row> TO ls_r.
          APPEND ls_r TO lt_return.
        ENDLOOP.
      ELSE.
        MOVE-CORRESPONDING <ls_x> TO ls_r.
        IF ls_r IS NOT INITIAL.
          APPEND ls_r TO lt_return.
        ENDIF.
      ENDIF.
    ENDIF.
    APPEND LINES OF lt_return TO ct_ret.
  ENDMETHOD.


  METHOD setf.
    " 구조의 필드를 이름으로 채우고 X 구조의 같은 필드에 'X'. 빈 값은 건드리지 않는다(변경 없음)
    FIELD-SYMBOLS <ls_s> TYPE any.
    FIELD-SYMBOLS <ls_x> TYPE any.
    FIELD-SYMBOLS <lv_f> TYPE any.
    FIELD-SYMBOLS <lv_fx> TYPE any.
    DATA lv_type TYPE c LENGTH 1.
    DATA lv_d TYPE d.

    IF iv_val IS INITIAL.
      RETURN.
    ENDIF.
    ASSIGN ir_struct->* TO <ls_s>.
    ASSIGN COMPONENT iv_field OF STRUCTURE <ls_s> TO <lv_f>.
    IF sy-subrc <> 0.
      err( EXPORTING iv_text = |BAPI 구조({ iv_type })에 { iv_field } 필드가 없습니다. SE11에서 필드명을 확인하세요| CHANGING ct_ret = ct_ret ).
      RETURN.
    ENDIF.
    DESCRIBE FIELD <lv_f> TYPE lv_type.
    IF lv_type = 'D'.
      lv_d = to_date( iv_val ).
      <lv_f> = lv_d.
    ELSEIF iv_alpha = abap_true.
      DATA(lv_s) = CONV string( iv_val ).
      <lv_f> = |{ lv_s ALPHA = IN }|.
    ELSE.
      <lv_f> = iv_val.
    ENDIF.
    IF ir_x IS BOUND.
      ASSIGN ir_x->* TO <ls_x>.
      ASSIGN COMPONENT iv_field OF STRUCTURE <ls_x> TO <lv_fx>.
      IF sy-subrc <> 0.
        err( EXPORTING iv_text = |BAPI X 구조({ iv_type }X)에 { iv_field } 필드가 없습니다. SE11에서 확인하세요| CHANGING ct_ret = ct_ret ).
        RETURN.
      ENDIF.
      <lv_fx> = abap_true.
    ENDIF.
  ENDMETHOD.


  METHOD err.
    APPEND VALUE #( type = 'E' id = 'ZALM' number = '000' message = iv_text ) TO ct_ret.
  ENDMETHOD.


  METHOD to_date.
    IF strlen( iv_iso ) >= 10.
      rv_d = |{ iv_iso(4) }{ iv_iso+5(2) }{ iv_iso+8(2) }|.
    ENDIF.
  ENDMETHOD.


  METHOD approved_date.
    " 승인 일시(UTC ISO) → 시스템 시간대의 날짜. 값이 없으면 오늘
    DATA lv_ts TYPE timestamp.
    DATA lv_t TYPE t.
    DATA(lv_digits) = iv_iso.
    REPLACE ALL OCCURRENCES OF REGEX '[^0-9]' IN lv_digits WITH ''.
    IF strlen( lv_digits ) < 14.
      rv_d = sy-datum.
      RETURN.
    ENDIF.
    lv_ts = lv_digits(14).
    CONVERT TIME STAMP lv_ts TIME ZONE sy-zonlo INTO DATE rv_d TIME lv_t.
  ENDMETHOD.


  METHOD reply.
    " POST /sap/postings/{id}/result. 로그에 회신 결과(HTTP 코드)를 덧붙인다
    DATA(lv_json) = zcl_alm_http_client=>to_json( is_res ).
    TRY.
        DATA(ls_resp) = mo_api->post( iv_path = |/sap/postings/{ is_res-posting_id }/result| iv_body = lv_json iv_key = iv_key ).
        rv_http = ls_resp-status.
        IF ls_resp-status <> 200.
          DATA(ls_prob) = zcl_alm_http_client=>parse_problem( ls_resp-body ).
          DATA(lv_txt) = |결과 회신 HTTP { ls_resp-status } { ls_prob-code } { ls_prob-detail }|.
        ENDIF.
      CATCH zcx_alm INTO DATA(lx).
        rv_http = COND #( WHEN lx->mv_http_status > 0 THEN lx->mv_http_status ELSE 599 ).
        lv_txt = |결과 회신 통신 오류: { lx->get_text( ) }|.
    ENDTRY.
    IF lv_txt IS NOT INITIAL.
      mv_any_failed = abap_true.
    ENDIF.
    IF io_log IS BOUND.
      IF lv_txt IS NOT INITIAL.
        io_log->add( iv_type = 'E' iv_text = lv_txt ).
      ENDIF.
      io_log->set_result( iv_status = io_log->ms_row-status iv_http = rv_http ).
      io_log->save( iv_commit = abap_true ).
    ELSEIF iv_log_id IS NOT INITIAL.
      UPDATE zalm_if_log SET http_status = rv_http WHERE log_id = iv_log_id.
      COMMIT WORK.
    ENDIF.
  ENDMETHOD.


  METHOD resend.
    " 8. 회신이 실패한 POSTED 건(최근 7일)을 다시 회신한다. ALM이 15분 잠금 만료를 기다리지 않고 빨리 상태를 맞추게 한다
    DATA lv_now TYPE timestampl.
    GET TIME STAMP FIELD lv_now.
    DATA(lv_from) = cl_abap_tstmp=>subtractsecs( tstmp = lv_now secs = 604800 ).
    SELECT * FROM zalm_if_log
      WHERE bukrs = @mv_bukrs AND ( if_id = 'IF-AA-03' OR if_id = 'IF-AA-04' )
        AND status = 'POSTED' AND http_status <> 200 AND start_ts >= @lv_from AND posting_id <> @space
      INTO TABLE @DATA(lt_rows).
    LOOP AT lt_rows INTO DATA(ls_row).
      DATA(ls_res) = VALUE gty_result( posting_id = ls_row-posting_id status = 'POSTED'
                                       asset = VALUE #( asset_no = ls_row-anln1 sub_no = ls_row-anln2 ) ).
      DATA(lv_http) = reply( is_res = ls_res iv_key = |{ ls_row-posting_id }-R{ mv_stamp(12) }| iv_log_id = ls_row-log_id ).
      WRITE: / ls_row-posting_id, '회신 재시도', lv_http.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.


AT SELECTION-SCREEN.
  IF p_max < 1 OR p_max > 200.
    MESSAGE '한 번에 가져올 건수는 1~200입니다' TYPE 'E'.
  ENDIF.

START-OF-SELECTION.
  NEW lcl_post( )->run( ).

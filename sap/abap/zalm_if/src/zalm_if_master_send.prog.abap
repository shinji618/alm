*&---------------------------------------------------------------------*
*& ZALM_IF_MASTER_SEND - SAP → ALM 마스터 송신(08 5.1 IF-MD-01, WBS 7.4)
*&   변형 MD01: 조직·코드 마스터 전체 송신
*&     COMPANY → PLANT → PROFIT_CENTER → COST_CENTER → ASSET_CLASS → LOCATION (참조되는 쪽 먼저)
*&   - 대상 회사코드: 화면 S_BUKRS, 비우면 ZALM_CFG BUKRS(여러 행). 회사코드마다 ALM 연결(X-Company-Code)이 따로 있어야 한다
*&   - 회사코드마다 배치 ID가 다르다(MD01-<UTC yyyymmddhhmm>-<BUKRS>). 회사에 딸린 유형(PLANT·COST_CENTER·LOCATION)은 그 회사 연결로,
*&     ALM이 전체 범위로 비활성 처리하는 유형(PROFIT_CENTER·ASSET_CLASS)은 모든 대상 회사의 합집합을 첫 회사 연결로 한 번만 보낸다
*&   - 유형마다 5,000건씩 분할, 마지막 분할에 isLast = true. 409 ALM-E303(분할 순서 오류)이면 그 유형을 새 배치 ID로 한 번 다시 보낸다
*&   - 같은 프로그램이 겹쳐 돌지 않게 ENQUEUE_E_TABLE(ZALM_IF_LOG, 키 IF-MD-01)로 잠근다(시험 실행은 잠그지 않음)
*&   - 결과는 ZALM_IF_LOG(IF_ID = IF-MD-01, 회사코드별 1행)·SLG1(객체 ZALM, 하위 객체 IF-MD-01)에 남긴다
*&   - 수동 실행과 잡(SM36)을 겸한다. 백그라운드에서 실패가 있으면 잡이 오류로 끝난다
*&   - 저가자산 클래스(D-06 미결)는 ZALM_CFG LOWVAL_CLASS(여러 행)에 넣은 클래스만 true. 없으면 모두 false
*&---------------------------------------------------------------------*
REPORT zalm_if_master_send.

CONSTANTS gc_if_id TYPE c LENGTH 10 VALUE 'IF-MD-01'.

DATA gv_bukrs_sel TYPE bukrs.

PARAMETERS p_var TYPE c LENGTH 4 DEFAULT 'MD01' OBLIGATORY.
SELECT-OPTIONS s_bukrs FOR gv_bukrs_sel NO INTERVALS.
PARAMETERS: p_api   TYPE rfcdest DEFAULT 'ZALM_API' OBLIGATORY,
            p_tok   TYPE rfcdest DEFAULT 'ZALM_TOKEN' OBLIGATORY,
            p_chunk TYPE i DEFAULT 5000 OBLIGATORY,
            p_req   TYPE c LENGTH 8,
            p_dry   AS CHECKBOX DEFAULT ' '.

TYPES:
  BEGIN OF gty_company,
    company_code TYPE string,
    name         TYPE string,
    currency     TYPE string,
  END OF gty_company,
  gtt_company TYPE STANDARD TABLE OF gty_company WITH EMPTY KEY,
  BEGIN OF gty_plant,
    plant_code   TYPE string,
    company_code TYPE string,
    name         TYPE string,
    address      TYPE string,
  END OF gty_plant,
  gtt_plant TYPE STANDARD TABLE OF gty_plant WITH EMPTY KEY,
  BEGIN OF gty_pc,
    controlling_area TYPE string,
    profit_center    TYPE string,
    name             TYPE string,
    segment          TYPE string,
  END OF gty_pc,
  gtt_pc TYPE STANDARD TABLE OF gty_pc WITH EMPTY KEY,
  BEGIN OF gty_cc,
    controlling_area TYPE string,
    cost_center      TYPE string,
    name             TYPE string,
    company_code     TYPE string,
    profit_center    TYPE string,
    responsible      TYPE string,
    valid_from       TYPE string,
    valid_to         TYPE string,
  END OF gty_cc,
  gtt_cc TYPE STANDARD TABLE OF gty_cc WITH EMPTY KEY,
  BEGIN OF gty_class,
    asset_class       TYPE string,
    name              TYPE string,
    is_low_value      TYPE abap_bool,
    useful_life_years TYPE i,
  END OF gty_class,
  gtt_class TYPE STANDARD TABLE OF gty_class WITH EMPTY KEY,
  BEGIN OF gty_loc,
    plant_code TYPE string,
    location   TYPE string,
    name       TYPE string,
  END OF gty_loc,
  gtt_loc TYPE STANDARD TABLE OF gty_loc WITH EMPTY KEY.

CLASS lcl_run DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run.

  PRIVATE SECTION.
    TYPES gtt_bukrs TYPE STANDARD TABLE OF bukrs WITH EMPTY KEY.

    DATA mt_bukrs TYPE gtt_bukrs.
    DATA mr_kokrs TYPE RANGE OF kokrs.
    DATA mv_stamp TYPE string.
    DATA mv_batch TYPE string.
    DATA mo_log TYPE REF TO zcl_alm_log.
    DATA mo_api TYPE REF TO zcl_alm_http_client.
    " 회사코드 하나의 결과
    DATA mv_failed TYPE abap_bool.
    DATA mv_sent TYPE i.
    DATA mv_err TYPE i.
    DATA mv_http TYPE i.
    " 전체 결과
    DATA mv_any_failed TYPE abap_bool.
    DATA mv_locked TYPE abap_bool.

    METHODS lock RETURNING VALUE(rv_ok) TYPE abap_bool.
    METHODS unlock.
    METHODS targets.
    METHODS kokrs_of
      IMPORTING iv_bukrs        TYPE bukrs
      RETURNING VALUE(rv_kokrs) TYPE kokrs.
    METHODS one_company
      IMPORTING iv_bukrs TYPE bukrs
                iv_first TYPE abap_bool.
    METHODS send
      IMPORTING iv_type    TYPE csequence
                it_records TYPE STANDARD TABLE.
    METHODS finish.

    METHODS sel_company IMPORTING iv_bukrs TYPE bukrs RETURNING VALUE(rt_rec) TYPE gtt_company.
    METHODS sel_plant IMPORTING iv_bukrs TYPE bukrs RETURNING VALUE(rt_rec) TYPE gtt_plant.
    METHODS sel_profit_center RETURNING VALUE(rt_rec) TYPE gtt_pc.
    METHODS sel_cost_center IMPORTING iv_bukrs TYPE bukrs RETURNING VALUE(rt_rec) TYPE gtt_cc.
    METHODS sel_asset_class RETURNING VALUE(rt_rec) TYPE gtt_class.
    METHODS sel_location IMPORTING iv_bukrs TYPE bukrs RETURNING VALUE(rt_rec) TYPE gtt_loc.
ENDCLASS.


CLASS lcl_run IMPLEMENTATION.

  METHOD run.
    DATA lv_ts TYPE timestamp.

    GET TIME STAMP FIELD lv_ts.
    mv_stamp = |{ lv_ts }|.

    targets( ).
    IF mt_bukrs IS INITIAL.
      MESSAGE '대상 회사코드가 없습니다. S_BUKRS를 넣거나 ZALM_IF_CONFIG에서 BUKRS를 등록하세요' TYPE 'E'.
    ENDIF.

    IF p_dry = abap_false AND lock( ) = abap_false.
      MESSAGE 'IF-MD-01이 이미 실행 중입니다(잠금). 끝난 뒤 다시 실행하세요' TYPE 'E'.
    ENDIF.

    LOOP AT mt_bukrs INTO DATA(lv_bukrs).
      one_company( iv_bukrs = lv_bukrs iv_first = xsdbool( sy-tabix = 1 ) ).
    ENDLOOP.

    unlock( ).
    finish( ).
  ENDMETHOD.


  METHOD lock.
    " VARKEY는 RSTABLE-VARKEY 유형이어야 한다(상수 gc_if_id를 그대로 넘기면 CALL_FUNCTION_CONFLICT_TYPE)
    DATA lv_varkey TYPE rstable-varkey.
    lv_varkey = gc_if_id.
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
      lv_varkey = gc_if_id.
      CALL FUNCTION 'DEQUEUE_E_TABLE'
        EXPORTING
          mode_rstable = 'E'
          tabname      = 'ZALM_IF_LOG'
          varkey       = lv_varkey.
      mv_locked = abap_false.
    ENDIF.
  ENDMETHOD.


  METHOD targets.
    DATA lt_cfg TYPE zcl_alm_cfg=>tt_value.

    IF s_bukrs[] IS NOT INITIAL.
      SELECT bukrs FROM t001 WHERE bukrs IN @s_bukrs ORDER BY bukrs INTO TABLE @mt_bukrs.
    ELSE.
      lt_cfg = zcl_alm_cfg=>get_list( zcl_alm_cfg=>c_bukrs ).
      LOOP AT lt_cfg INTO DATA(lv_cfg).
        APPEND CONV bukrs( lv_cfg ) TO mt_bukrs.
      ENDLOOP.
      SORT mt_bukrs.
      DELETE ADJACENT DUPLICATES FROM mt_bukrs.
    ENDIF.

    " 손익센터는 모든 대상 회사의 관리회계영역 합집합으로 한 번에 보낸다
    LOOP AT mt_bukrs INTO DATA(lv_bukrs).
      DATA(lv_kokrs) = kokrs_of( lv_bukrs ).
      IF lv_kokrs IS NOT INITIAL AND NOT line_exists( mr_kokrs[ low = lv_kokrs ] ).
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_kokrs ) TO mr_kokrs.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD kokrs_of.
    " 관리회계영역: ZALM_CFG KOKRS(D-02)가 있으면 그 값, 없으면 회사코드에 지정된 값(TKA02)
    DATA(lv_cfg) = zcl_alm_cfg=>get( zcl_alm_cfg=>c_kokrs ).
    IF lv_cfg IS NOT INITIAL.
      rv_kokrs = lv_cfg.
    ELSE.
      SELECT SINGLE kokrs FROM tka02 WHERE bukrs = @iv_bukrs INTO @rv_kokrs.
    ENDIF.
  ENDMETHOD.


  METHOD one_company.
    DATA(lv_req) = COND string( WHEN p_req IS NOT INITIAL THEN |-REQ{ p_req }| ).
    mv_batch = |MD01-{ mv_stamp(12) }-{ iv_bukrs }{ lv_req }|.
    CLEAR: mv_failed, mv_sent, mv_err, mv_http.

    mo_log = NEW #( iv_if_id = gc_if_id iv_batch_id = mv_batch iv_bukrs = iv_bukrs ).
    mo_api = NEW #( iv_bukrs = iv_bukrs iv_dest_api = p_api iv_dest_token = p_tok ).
    mo_log->add( |IF-MD-01 { COND string( WHEN p_dry = abap_true THEN `시험 실행(보내지 않음)` ELSE `송신` ) }: 회사코드 { iv_bukrs }, 배치 { mv_batch }, SAP 시스템 { mo_api->system_id( ) }| ).

    DATA(lt_company) = sel_company( iv_bukrs ).
    IF lt_company IS INITIAL.
      mo_log->add( iv_type = 'E' iv_text = |회사코드 { iv_bukrs }이(가) T001에 없습니다| ).
      mv_failed = abap_true.
    ENDIF.

    IF mv_failed = abap_false.
      send( iv_type = 'COMPANY' it_records = lt_company ).
    ENDIF.
    IF mv_failed = abap_false.
      send( iv_type = 'PLANT' it_records = sel_plant( iv_bukrs ) ).
    ENDIF.
    IF mv_failed = abap_false AND iv_first = abap_true.
      send( iv_type = 'PROFIT_CENTER' it_records = sel_profit_center( ) ).
    ENDIF.
    IF mv_failed = abap_false.
      send( iv_type = 'COST_CENTER' it_records = sel_cost_center( iv_bukrs ) ).
    ENDIF.
    IF mv_failed = abap_false AND iv_first = abap_true.
      send( iv_type = 'ASSET_CLASS' it_records = sel_asset_class( ) ).
    ENDIF.
    IF mv_failed = abap_false.
      send( iv_type = 'LOCATION' it_records = sel_location( iv_bukrs ) ).
    ENDIF.
    IF mv_failed = abap_true.
      mo_log->add( iv_type = 'W' iv_text = '앞 단계가 실패해 나머지 유형은 보내지 않았습니다' ).
      mv_any_failed = abap_true.
    ENDIF.

    IF p_dry = abap_false.
      DATA(lt_warn) = VALUE zcl_alm_log=>tt_msg( FOR m IN mo_log->mt_msg WHERE ( type CA 'EW' ) ( m ) ).
      mo_log->set_result(
        iv_status   = COND #( WHEN mv_failed = abap_true THEN zcl_alm_log=>c_failed
                              WHEN mv_err > 0 THEN zcl_alm_log=>c_partial
                              ELSE zcl_alm_log=>c_success )
        iv_http     = mv_http
        iv_rec_cnt  = mv_sent
        iv_err_cnt  = mv_err + COND i( WHEN mv_failed = abap_true THEN 1 ELSE 0 )
        iv_msg_json = zcl_alm_log=>messages_json( lt_warn ) ).
      mo_log->save( iv_commit = abap_true ).
    ENDIF.
  ENDMETHOD.


  METHOD send.
    DATA lt_chunks TYPE zcl_alm_http_client=>tt_chunk.
    DATA lv_batch TYPE string.
    DATA lv_retry TYPE abap_bool.

    DATA(lv_count) = lines( it_records ).
    IF p_dry = abap_true.
      mo_log->add( |{ iv_type }: { lv_count }건 선택| ).
      RETURN.
    ENDIF.

    lv_batch = mv_batch.
    DO 2 TIMES.
      DATA(lv_try) = sy-index.
      CLEAR: lt_chunks, lv_retry.
      TRY.
          lt_chunks = mo_api->send_records( iv_path       = '/sap/master-data'
                                            iv_batch_id   = lv_batch
                                            iv_type       = iv_type
                                            it_records    = it_records
                                            iv_chunk_size = p_chunk ).
        CATCH zcx_alm INTO DATA(lx).
          mo_log->add( iv_type = 'E' iv_text = |{ iv_type }: { lx->get_text( ) }| ).
          mv_http = lx->mv_http_status.
          mv_failed = abap_true.
          RETURN.
      ENDTRY.

      " 409 ALM-E303(분할 순서 오류): 4xx 재시도 금지의 예외로, 새 배치 ID로 처음부터 한 번 다시 보낸다
      LOOP AT lt_chunks INTO DATA(ls_probe) WHERE response-status = 409.
        DATA(ls_probe_problem) = zcl_alm_http_client=>parse_problem( ls_probe-response-body ).
        IF ls_probe_problem-code = 'ALM-E303' AND lv_try = 1.
          lv_retry = abap_true.
        ENDIF.
      ENDLOOP.
      IF lv_retry = abap_true.
        lv_batch = |{ mv_batch }-R|.
        mo_log->add( iv_type = 'W' iv_text = |{ iv_type }: 분할 순서 오류(ALM-E303), 새 배치 { lv_batch }로 다시 보냅니다| ).
        CONTINUE.
      ENDIF.
      EXIT.
    ENDDO.

    DATA(lv_ok) = 0.
    LOOP AT lt_chunks INTO DATA(ls_chunk).
      mv_sent = mv_sent + ls_chunk-records.
      mv_http = ls_chunk-response-status.
      CASE ls_chunk-response-status.
        WHEN 200 OR 202 OR 207.
          lv_ok = lv_ok + ls_chunk-result-succeeded.
          mv_err = mv_err + ls_chunk-result-failed.
          LOOP AT ls_chunk-result-results INTO DATA(ls_item) WHERE status = 'ERROR'.
            mo_log->add( iv_type = 'W' iv_text = |{ iv_type } { ls_item-key }: { ls_item-code } { ls_item-message }| ).
          ENDLOOP.
          LOOP AT ls_chunk-result-results INTO ls_item WHERE status = 'SKIPPED'.
            mo_log->add( iv_type = 'I' iv_text = |{ iv_type } { ls_item-key }: { ls_item-message }| ).
          ENDLOOP.
        WHEN OTHERS.
          DATA(ls_problem) = zcl_alm_http_client=>parse_problem( ls_chunk-response-body ).
          mo_log->add( iv_type = 'E' iv_text = |{ iv_type } 분할 { ls_chunk-chunk_no } HTTP { ls_chunk-response-status } { ls_problem-code }: {
                                                COND string( WHEN ls_problem-detail IS NOT INITIAL THEN ls_problem-detail ELSE ls_chunk-response-body ) }| ).
          mv_failed = abap_true.
      ENDCASE.
    ENDLOOP.
    mo_log->add( iv_type = COND #( WHEN mv_failed = abap_true THEN 'E' ELSE 'S' )
                 iv_text = |{ iv_type }: { lv_count }건, 분할 { lines( lt_chunks ) }개, 반영 { lv_ok }건| ).
  ENDMETHOD.


  METHOD finish.
    IF mv_any_failed = abap_true.
      IF sy-batch = abap_true.
        MESSAGE 'IF-MD-01 실패가 있습니다. SLG1(객체 ZALM)과 ZALM_IF_LOG를 확인하세요' TYPE 'E'.
      ELSE.
        MESSAGE 'IF-MD-01 실패가 있습니다. SLG1(객체 ZALM)과 ZALM_IF_LOG를 확인하세요' TYPE 'S' DISPLAY LIKE 'E'.
      ENDIF.
    ELSE.
      MESSAGE 'IF-MD-01 완료' TYPE 'S'.
    ENDIF.
  ENDMETHOD.


  METHOD sel_company.
    SELECT SINGLE bukrs, butxt, waers FROM t001 WHERE bukrs = @iv_bukrs INTO @DATA(ls_t001).
    IF sy-subrc = 0.
      APPEND VALUE #( company_code = ls_t001-bukrs name = ls_t001-butxt currency = ls_t001-waers ) TO rt_rec.
    ENDIF.
  ENDMETHOD.


  METHOD sel_plant.
    " 평가영역(T001K-BWKEY = 플랜트)의 회사코드가 대상인 플랜트
    SELECT w~werks, w~name1, w~stras, w~ort01, w~regio, w~pstlz
      FROM t001w AS w
      INNER JOIN t001k AS k ON k~bwkey = w~werks
      WHERE k~bukrs = @iv_bukrs
      ORDER BY w~werks
      INTO TABLE @DATA(lt_w).
    DATA lt_part TYPE STANDARD TABLE OF string WITH EMPTY KEY.
    LOOP AT lt_w INTO DATA(ls_w).
      CLEAR lt_part.
      APPEND CONV string( ls_w-stras ) TO lt_part.
      APPEND CONV string( ls_w-ort01 ) TO lt_part.
      APPEND condense( |{ ls_w-regio } { ls_w-pstlz }| ) TO lt_part.
      DATA(lv_addr) = VALUE string( ).
      LOOP AT lt_part INTO DATA(lv_part).
        lv_part = condense( lv_part ).
        IF lv_part IS NOT INITIAL.
          lv_addr = COND #( WHEN lv_addr IS INITIAL THEN lv_part ELSE |{ lv_addr }, { lv_part }| ).
        ENDIF.
      ENDLOOP.
      IF strlen( lv_addr ) > 200.
        lv_addr = lv_addr(200).
      ENDIF.
      APPEND VALUE #( plant_code = ls_w-werks company_code = iv_bukrs
                      name = COND #( WHEN ls_w-name1 IS INITIAL THEN ls_w-werks ELSE ls_w-name1 )
                      address = lv_addr ) TO rt_rec.
    ENDLOOP.
  ENDMETHOD.


  METHOD sel_profit_center.
    IF mr_kokrs IS INITIAL.
      RETURN.
    ENDIF.
    SELECT c~kokrs, c~prctr, c~segment, t~ktext
      FROM cepc AS c
      LEFT OUTER JOIN cepct AS t ON t~prctr = c~prctr AND t~kokrs = c~kokrs AND t~datbi = c~datbi AND t~spras = 'E'
      WHERE c~kokrs IN @mr_kokrs AND c~datab <= @sy-datum AND c~datbi >= @sy-datum
      ORDER BY c~kokrs, c~prctr
      INTO TABLE @DATA(lt_cepc).
    rt_rec = VALUE #( FOR p IN lt_cepc ( controlling_area = p-kokrs profit_center = p-prctr
                                         name = COND #( WHEN p-ktext IS INITIAL THEN p-prctr ELSE p-ktext )
                                         segment = p-segment ) ).
  ENDMETHOD.


  METHOD sel_cost_center.
    DATA(lv_kokrs) = kokrs_of( iv_bukrs ).
    IF lv_kokrs IS INITIAL.
      mo_log->add( iv_type = 'W' iv_text = |회사코드 { iv_bukrs }의 관리회계영역(TKA02·ZALM_CFG KOKRS)을 알 수 없어 코스트센터를 보내지 않습니다| ).
      RETURN.
    ENDIF.
    SELECT c~kostl, c~datab, c~datbi, c~prctr, c~verak, t~ktext
      FROM csks AS c
      LEFT OUTER JOIN cskt AS t ON t~kostl = c~kostl AND t~kokrs = c~kokrs AND t~datbi = c~datbi AND t~spras = 'E'
      WHERE c~kokrs = @lv_kokrs AND c~bukrs = @iv_bukrs AND c~datab <= @sy-datum AND c~datbi >= @sy-datum
      ORDER BY c~kostl
      INTO TABLE @DATA(lt_csks).
    rt_rec = VALUE #( FOR k IN lt_csks ( controlling_area = lv_kokrs cost_center = k-kostl company_code = iv_bukrs
                                         name = COND #( WHEN k-ktext IS INITIAL THEN k-kostl ELSE k-ktext )
                                         profit_center = k-prctr responsible = k-verak
                                         valid_from = |{ k-datab DATE = ISO }| valid_to = |{ k-datbi DATE = ISO }| ) ).
  ENDMETHOD.


  METHOD sel_asset_class.
    " 클래스 기본 상각영역 01의 내용연수(ANKB-NDJAR). 저가자산(D-06)은 ZALM_CFG LOWVAL_CLASS 목록
    SELECT a~anlkl, t~txk50
      FROM anka AS a
      LEFT OUTER JOIN ankt AS t ON t~anlkl = a~anlkl AND t~spras = 'E'
      ORDER BY a~anlkl
      INTO TABLE @DATA(lt_anka).
    SELECT anlkl, ndjar FROM ankb WHERE afabe = '01' INTO TABLE @DATA(lt_ankb).
    DATA(lt_low) = zcl_alm_cfg=>get_list( 'LOWVAL_CLASS' ).

    LOOP AT lt_anka INTO DATA(ls_a).
      DATA(ls_rec) = VALUE gty_class( asset_class = ls_a-anlkl
                                      name = COND #( WHEN ls_a-txk50 IS INITIAL THEN ls_a-anlkl ELSE ls_a-txk50 ) ).
      READ TABLE lt_ankb INTO DATA(ls_b) WITH KEY anlkl = ls_a-anlkl.
      IF sy-subrc = 0.
        ls_rec-useful_life_years = ls_b-ndjar.
      ENDIF.
      ls_rec-is_low_value = xsdbool( line_exists( lt_low[ table_line = CONV string( ls_a-anlkl ) ] ) ).
      APPEND ls_rec TO rt_rec.
    ENDLOOP.
  ENDMETHOD.


  METHOD sel_location.
    SELECT w~werks
      FROM t001w AS w
      INNER JOIN t001k AS k ON k~bwkey = w~werks
      WHERE k~bukrs = @iv_bukrs
      INTO TABLE @DATA(lt_plant).
    IF lt_plant IS INITIAL.
      RETURN.
    ENDIF.
    SELECT werks, stand, ktext FROM t499s
      FOR ALL ENTRIES IN @lt_plant
      WHERE werks = @lt_plant-werks
      INTO TABLE @DATA(lt_loc).
    SORT lt_loc BY werks stand.
    rt_rec = VALUE #( FOR l IN lt_loc ( plant_code = l-werks location = l-stand
                                        name = COND #( WHEN l-ktext IS INITIAL THEN l-stand ELSE l-ktext ) ) ).
  ENDMETHOD.

ENDCLASS.


AT SELECTION-SCREEN.
  IF p_var <> 'MD01'.
    MESSAGE '변형은 MD01만 있습니다(AA01·AA02·MM01은 7.5에서 추가)' TYPE 'E'.
  ENDIF.
  IF p_chunk < 1 OR p_chunk > 5000.
    MESSAGE '분할 크기는 1~5000입니다' TYPE 'E'.
  ENDIF.

START-OF-SELECTION.
  NEW lcl_run( )->run( ).

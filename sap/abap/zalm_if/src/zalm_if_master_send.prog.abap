*&---------------------------------------------------------------------*
*& ZALM_IF_MASTER_SEND - SAP → ALM 마스터 송신(08 5.1 IF-MD-01 WBS 7.4, 5.2 IF-AA-01·5.3 IF-AA-02 WBS 7.5)
*&   변형 AA02: 자산 금액 송신(/sap/asset-values, 1,000건 분할). 아래 "AA02" 블록 참고
*&   변형 AA01: 자산 마스터 델타 송신(/sap/assets:upsert, 1,000건 분할). 아래 "AA01" 블록 참고
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
*& AA01 (IF-AA-01, 08 5.2)
*&   - 대상: ① 마지막 성공 이후 변경 문서(CDHDR ANLA) ② 그 이후 생성(ANLA-ERDAT) ③ 효력일이 도래한 시간종속 행(ANLZ-ADATU)
*&   - 마지막 성공 시각은 회사코드별 ZALM_CFG LAST_AA01_<BUKRS>(UTC). 비었으면 최초 → 대상 회사코드 전체, isFull = true. 화면 P_FULL로도 전체
*&   - 성공(HTTP 오류 없음)하면 잡 시작 시각을 저장한다. 건별 ERROR(예: 코스트센터 없음)는 ALM이 다음 IF-MD-01 뒤 자동 재처리하므로 시각은 올린다
*&   - 삭제 표시(XLOEV) 자산은 보내지 않는다(ALM 쪽 정리는 IF-RC-01 대사). 설명·클래스·코스트센터가 빈 자산은 빼고 경고(T31)
*&   - 결과는 ZALM_IF_LOG(IF_ID = IF-AA-01)·SLG1. 유형별 요약: 반영 a / 변경 없음 b / 오류 c
*& AA02 (IF-AA-02, 08 5.3, D-06 초안 산식)
*&   - 대상: 회사코드의 삭제 표시 아닌 자산 전체(매일 전체, 같은 값이면 ALM이 SKIPPED). 상각영역 01만
*&   - 기간: 올해 회계연도(GET_CURRENT_YEAR)의 ANLC 행. period = 화면 P_PER(1~16, 마감 실행은 이 값을 지정), 0이면 ANLC-PERAF가 있으면 그 값,
*&     S/4HANA 호환 뷰처럼 PERAF가 없으면 현재 전기 기간. ANLC 행이 없으면 금액 0으로 명시(T30)
*&   - ANLC 필드는 모두 이름으로 읽는다(ASSIGN COMPONENT): 릴리스에 따라 없는 필드(PERAF 등)가 있어도 활성화·실행이 깨지지 않게
*&   - acquisitionValue = KANSW + ANSWL, accumDepreciation = KNAFA + NAFAG(음수), netBookValue = 둘의 합
*&     계획외·특별 상각 등을 더해야 하면 ZALM_CFG AA02_DEP_EXTRA(여러 행, 예: KMAFA MAFAG KSAFA SAFAG)에 ANLC 필드명을 넣는다(AW01N과 맞추기)
*&   - 내용연수·상각키: ANLB(상각영역 01, 오늘 유효) NDJAR·NDPER·AFASL
*&   - 마감 실행: P_CLOSE(isClosing) 체크 → 요청 본문 isClosing = true, ALM이 그 기간 값을 마감값으로 잠금(자산회계가 ALM 화면 IF-OP-01로 요청)
*&   - 취득 출처(origins): P_ORIG(기본 켬)이면 각 자산 레코드에 PO와 AuC 정산 출처를 실어 보낸다(자산 마스터가 아니라 금액과 같이 보냄 = 가액이 생기는 시점)
*&     DIRECT = 그 자산에 걸린 PO(EKKN-ANLN1/ANLN2, 삭제 표시 제외), AUC = AuC 정산으로 취득한 경우 원천 AuC 자산번호와 그 AuC에 걸린 PO.
*&     AuC 정산 판별: ZALM_CFG AUC_CLASS(AuC 자산클래스, 여러 행). 비어 있으면 AUC 출처는 찾지 않는다. AuC 자산 자체는 보내지 않는다
*&   - 시험 실행은 앞 10건의 금액 구성(KANSW·ANSWL·KNAFA·NAFAG와 추가 필드)을 로그에 보여 AW01N과 대조하게 한다
*&---------------------------------------------------------------------*
REPORT zalm_if_master_send.

CONSTANTS: gc_if_md TYPE c LENGTH 10 VALUE 'IF-MD-01',
           gc_if_aa TYPE c LENGTH 10 VALUE 'IF-AA-01',
           gc_if_av TYPE c LENGTH 10 VALUE 'IF-AA-02'.

DATA gv_bukrs_sel TYPE bukrs.

PARAMETERS p_var TYPE c LENGTH 4 DEFAULT 'MD01' OBLIGATORY.
SELECT-OPTIONS s_bukrs FOR gv_bukrs_sel NO INTERVALS.
PARAMETERS: p_api   TYPE rfcdest DEFAULT 'ZALM_API' OBLIGATORY,
            p_tok   TYPE rfcdest DEFAULT 'ZALM_TOKEN' OBLIGATORY,
            p_chunk TYPE i DEFAULT 5000 OBLIGATORY,
            p_req   TYPE c LENGTH 8,
            p_full  AS CHECKBOX DEFAULT ' ',
            p_close AS CHECKBOX DEFAULT ' ',
            p_per   TYPE i DEFAULT 0,
            p_orig  AS CHECKBOX DEFAULT 'X',
            p_dry   AS CHECKBOX DEFAULT ' '.

TYPES gty_amount TYPE p LENGTH 13 DECIMALS 2.

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
  gtt_loc TYPE STANDARD TABLE OF gty_loc WITH EMPTY KEY,
  BEGIN OF gty_asset,
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
    plant           TYPE string,
    location        TYPE string,
    changed_at      TYPE string,
  END OF gty_asset,
  gtt_asset TYPE STANDARD TABLE OF gty_asset WITH EMPTY KEY,
  BEGIN OF gty_akey,
    bukrs TYPE bukrs,
    anln1 TYPE anln1,
    anln2 TYPE anln2,
    ts    TYPE timestamp,
  END OF gty_akey,
  gtt_akey TYPE SORTED TABLE OF gty_akey WITH UNIQUE KEY bukrs anln1 anln2,
  BEGIN OF gty_origin,
    source_type  TYPE string,
    po_no        TYPE string,
    po_item      TYPE string,
    vendor_code  TYPE string,
    vendor_name  TYPE string,
    po_date      TYPE string,
    auc_asset_no TYPE string,
    auc_sub_no   TYPE string,
  END OF gty_origin,
  gtt_origin TYPE STANDARD TABLE OF gty_origin WITH EMPTY KEY,
  BEGIN OF gty_value,
    company_code        TYPE string,
    asset_no            TYPE string,
    sub_no              TYPE string,
    fiscal_year         TYPE i,
    period              TYPE i,
    dep_area            TYPE string,
    acquisition_value   TYPE p LENGTH 13 DECIMALS 2,
    accum_depreciation  TYPE p LENGTH 13 DECIMALS 2,
    net_book_value      TYPE p LENGTH 13 DECIMALS 2,
    useful_life_years   TYPE i,
    useful_life_periods TYPE i,
    dep_key             TYPE string,
    origins             TYPE gtt_origin,
  END OF gty_value,
  gtt_value TYPE STANDARD TABLE OF gty_value WITH EMPTY KEY.

CLASS lcl_run DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run.

  PRIVATE SECTION.
    TYPES gtt_bukrs TYPE STANDARD TABLE OF bukrs WITH EMPTY KEY.

    DATA mt_bukrs TYPE gtt_bukrs.
    DATA mr_kokrs TYPE RANGE OF kokrs.
    DATA mv_stamp TYPE string.
    DATA mv_ts TYPE timestamp.
    DATA mv_if TYPE c LENGTH 10.
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
                it_records TYPE STANDARD TABLE
                iv_path    TYPE csequence DEFAULT '/sap/master-data'
                iv_head    TYPE csequence OPTIONAL
                iv_chunked TYPE abap_bool DEFAULT abap_false
                iv_compress TYPE abap_bool DEFAULT abap_true.
    METHODS one_company_aa01
      IMPORTING iv_bukrs TYPE bukrs.
    METHODS one_company_aa02
      IMPORTING iv_bukrs TYPE bukrs.
    METHODS sel_values
      IMPORTING iv_bukrs        TYPE bukrs
      RETURNING VALUE(rt_value) TYPE gtt_value.
    METHODS fill_origins
      IMPORTING iv_bukrs TYPE bukrs
      CHANGING  ct_value TYPE gtt_value.
    METHODS anlc_val
      IMPORTING is_anlc       TYPE any
                iv_field      TYPE csequence
      RETURNING VALUE(rv_val) TYPE gty_amount.
    METHODS save_log.
    METHODS finish.
    METHODS sel_assets
      IMPORTING iv_bukrs        TYPE bukrs
                iv_full         TYPE abap_bool
                iv_date         TYPE d
                iv_time         TYPE t
      RETURNING VALUE(rt_asset) TYPE gtt_asset.
    METHODS to_utc
      IMPORTING iv_date      TYPE d
                iv_time      TYPE t DEFAULT '000000'
      RETURNING VALUE(rv_ts) TYPE timestamp.

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
    mv_ts = lv_ts.
    mv_stamp = |{ lv_ts }|.
    mv_if = SWITCH #( p_var WHEN 'AA01' THEN gc_if_aa WHEN 'AA02' THEN gc_if_av ELSE gc_if_md ).

    targets( ).
    IF mt_bukrs IS INITIAL.
      MESSAGE '대상 회사코드가 없습니다. S_BUKRS를 넣거나 ZALM_IF_CONFIG에서 BUKRS를 등록하세요' TYPE 'E'.
    ENDIF.

    IF p_dry = abap_false AND lock( ) = abap_false.
      MESSAGE |{ mv_if }이(가) 이미 실행 중입니다(잠금). 끝난 뒤 다시 실행하세요| TYPE 'E'.
    ENDIF.

    LOOP AT mt_bukrs INTO DATA(lv_bukrs).
      IF p_var = 'AA01'.
        one_company_aa01( lv_bukrs ).
      ELSEIF p_var = 'AA02'.
        one_company_aa02( lv_bukrs ).
      ELSE.
        one_company( iv_bukrs = lv_bukrs iv_first = xsdbool( sy-tabix = 1 ) ).
      ENDIF.
    ENDLOOP.

    unlock( ).
    finish( ).
  ENDMETHOD.


  METHOD lock.
    " VARKEY는 RSTABLE-VARKEY 유형이어야 한다(상수를 그대로 넘기면 CALL_FUNCTION_CONFLICT_TYPE)
    DATA lv_varkey TYPE rstable-varkey.
    lv_varkey = mv_if.
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
      lv_varkey = mv_if.
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
      SORT mt_bukrs BY table_line.
      DELETE ADJACENT DUPLICATES FROM mt_bukrs COMPARING table_line.
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

    mo_log = NEW #( iv_if_id = gc_if_md iv_batch_id = mv_batch iv_bukrs = iv_bukrs ).
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

    save_log( ).
  ENDMETHOD.


  METHOD save_log.
    IF p_dry = abap_false.
      DATA(lt_warn) = VALUE zcl_alm_log=>tt_msg( FOR m IN mo_log->mt_msg WHERE ( type CA 'EW' ) ( m ) ).
      " MSG_JSON(길이 한도)을 넘지 않게 앞 50건만. 전체는 SLG1에 있다
      IF lines( lt_warn ) > 50.
        DELETE lt_warn FROM 51.
      ENDIF.
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
    " 분할 상한: 마스터 5,000건, 자산 1,000건(08 4.3)
    DATA(lv_chunk) = COND i( WHEN iv_path = '/sap/master-data' THEN p_chunk ELSE nmin( val1 = p_chunk val2 = 1000 ) ).
    DO 2 TIMES.
      DATA(lv_try) = sy-index.
      CLEAR: lt_chunks, lv_retry.
      TRY.
          IF iv_path = '/sap/master-data'.
            lt_chunks = mo_api->send_records( iv_path       = iv_path
                                              iv_batch_id   = lv_batch
                                              iv_type       = iv_type
                                              it_records    = it_records
                                              iv_chunk_size = lv_chunk ).
          ELSE.
            " 자산·금액: type 없이 {batchId, <head>, [chunkNo, isLast,] records}. 금액은 0·빈 값도 보내야 해 compress를 끈다
            lt_chunks = mo_api->send_records( iv_path       = iv_path
                                              iv_batch_id   = lv_batch
                                              iv_head       = iv_head
                                              iv_chunked    = iv_chunked
                                              it_records    = it_records
                                              iv_chunk_size = lv_chunk
                                              iv_compress   = iv_compress ).
          ENDIF.
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

    DATA(lv_skip) = 0.
    DATA(lv_fail) = 0.
    LOOP AT lt_chunks INTO DATA(ls_chunk).
      mv_sent = mv_sent + ls_chunk-records.
      mv_http = ls_chunk-response-status.
      CASE ls_chunk-response-status.
        WHEN 200 OR 202 OR 207.
          mv_err = mv_err + ls_chunk-result-failed.
          lv_fail = lv_fail + ls_chunk-result-failed.
          LOOP AT ls_chunk-result-results INTO DATA(ls_item) WHERE status = 'ERROR'.
            mo_log->add( iv_type = 'W' iv_text = |{ iv_type } { ls_item-key }: { ls_item-code } { ls_item-message }| ).
          ENDLOOP.
          " 응답에는 ERROR·SKIPPED만 있다. SKIPPED(값이 같아 변경 없음)는 건수만 세고, 사유가 있는 건만 남긴다
          LOOP AT ls_chunk-result-results INTO ls_item WHERE status = 'SKIPPED'.
            lv_skip = lv_skip + 1.
            IF ls_item-message IS NOT INITIAL.
              mo_log->add( iv_type = 'I' iv_text = |{ iv_type } { ls_item-key }: { ls_item-message }| ).
            ENDIF.
          ENDLOOP.
        WHEN OTHERS.
          DATA(ls_problem) = zcl_alm_http_client=>parse_problem( ls_chunk-response-body ).
          mo_log->add( iv_type = 'E' iv_text = |{ iv_type } 분할 { ls_chunk-chunk_no } HTTP { ls_chunk-response-status } { ls_problem-code }: {
                                                COND string( WHEN ls_problem-detail IS NOT INITIAL THEN ls_problem-detail ELSE ls_chunk-response-body ) }| ).
          mv_failed = abap_true.
      ENDCASE.
    ENDLOOP.
    mo_log->add( iv_type = COND #( WHEN mv_failed = abap_true THEN 'E' ELSE 'S' )
                 iv_text = |{ iv_type }: { lv_count }건, 분할 { lines( lt_chunks ) }개 — 반영 { nmax( val1 = lv_count - lv_skip - lv_fail val2 = 0 ) } / 변경 없음 { lv_skip } / 오류 { lv_fail }| ).
  ENDMETHOD.


  METHOD finish.
    IF mv_any_failed = abap_true.
      IF sy-batch = abap_true.
        MESSAGE |{ mv_if } 실패가 있습니다. SLG1(객체 ZALM)과 ZALM_IF_LOG를 확인하세요| TYPE 'E'.
      ELSE.
        MESSAGE |{ mv_if } 실패가 있습니다. SLG1(객체 ZALM)과 ZALM_IF_LOG를 확인하세요| TYPE 'S' DISPLAY LIKE 'E'.
      ENDIF.
    ELSE.
      MESSAGE |{ mv_if } 완료| TYPE 'S'.
    ENDIF.
  ENDMETHOD.


  METHOD one_company_aa01.
    DATA lv_d TYPE d.
    DATA lv_t TYPE t.
    DATA lv_init TYPE abap_bool.

    DATA(lv_req) = COND string( WHEN p_req IS NOT INITIAL THEN |-REQ{ p_req }| ).
    mv_batch = |AA01-{ mv_stamp(12) }-{ iv_bukrs }{ lv_req }|.
    CLEAR: mv_failed, mv_sent, mv_err, mv_http.

    mo_log = NEW #( iv_if_id = gc_if_aa iv_batch_id = mv_batch iv_bukrs = iv_bukrs ).
    mo_api = NEW #( iv_bukrs = iv_bukrs iv_dest_api = p_api iv_dest_token = p_tok ).
    DATA(lv_param) = |LAST_AA01_{ iv_bukrs }|.
    zcl_alm_cfg=>delta_from( EXPORTING iv_param = lv_param
                             IMPORTING ev_date = lv_d ev_time = lv_t ev_initial = lv_init ).
    DATA(lv_full) = xsdbool( lv_init = abap_true OR p_full = abap_true ).
    mo_log->add( |IF-AA-01 { COND string( WHEN p_dry = abap_true THEN `시험 실행(보내지 않음)` ELSE `송신` ) }: 회사코드 { iv_bukrs }, 배치 { mv_batch }, SAP 시스템 { mo_api->system_id( ) }| ).
    mo_log->add( COND string( WHEN lv_full = abap_true THEN |선택: 전체(isFull){ COND string( WHEN lv_init = abap_true THEN `, 최초 실행` ELSE `, 화면에서 전체 지정` ) }|
                              ELSE |선택: 델타 — { lv_d DATE = ISO } { lv_t TIME = ISO } (시스템 시간) 이후| ) ).

    DATA(lt_asset) = sel_assets( iv_bukrs = iv_bukrs iv_full = lv_full iv_date = lv_d iv_time = lv_t ).
    IF lt_asset IS INITIAL.
      mo_log->add( 'ASSET: 보낼 자산이 없습니다(변경 없음)' ).
    ELSE.
      send( iv_type = 'ASSET' it_records = lt_asset iv_path = '/sap/assets:upsert' iv_chunked = abap_true
            iv_head = COND #( WHEN lv_full = abap_true THEN `"isFull":true` ) ).
    ENDIF.

    IF mv_failed = abap_true.
      mv_any_failed = abap_true.
    ELSEIF p_dry = abap_false.
      " 성공하면 잡 시작 시각을 저장한다(실패하면 그대로 둬서 다음 실행이 다시 보낸다)
      zcl_alm_cfg=>set_timestamp( iv_param = lv_param iv_ts = mv_ts ).
    ENDIF.
    save_log( ).
  ENDMETHOD.


  METHOD to_utc.
    " 시스템 시간(CT 등)의 날짜·시각 → UTC 타임스탬프
    SELECT SINGLE tzonesys FROM ttzcu INTO @DATA(lv_tz).
    IF lv_tz IS INITIAL.
      lv_tz = sy-zonlo.
    ENDIF.
    CONVERT DATE iv_date TIME iv_time INTO TIME STAMP rv_ts TIME ZONE lv_tz.
  ENDMETHOD.


  METHOD sel_assets.
    DATA lt_key TYPE gtt_akey.
    DATA lv_ts TYPE timestamp.

    " 1) 대상 자산 키 모으기 ------------------------------------------------
    IF iv_full = abap_true.
      SELECT bukrs, anln1, anln2 FROM anla
        WHERE bukrs = @iv_bukrs AND xloev = @space
        INTO TABLE @DATA(lt_all).
      LOOP AT lt_all INTO DATA(ls_all).
        INSERT VALUE #( bukrs = ls_all-bukrs anln1 = ls_all-anln1 anln2 = ls_all-anln2 ) INTO TABLE lt_key.
      ENDLOOP.
      mo_log->add( |대상 키: 전체 { lines( lt_key ) }건| ).
    ELSE.
      DATA(lv_like) = |{ sy-mandt }{ iv_bukrs }%|.
      " ① 변경 문서(D-07 ANLA). OBJECTID = 클라이언트(3) + BUKRS(4) + ANLN1(12) + ANLN2(4)
      SELECT objectid, udate, utime FROM cdhdr
        WHERE objectclas = 'ANLA' AND objectid LIKE @lv_like
          AND ( udate > @iv_date OR ( udate = @iv_date AND utime >= @iv_time ) )
        INTO TABLE @DATA(lt_cd).
      LOOP AT lt_cd INTO DATA(ls_cd).
        DATA(ls_key) = VALUE gty_akey( bukrs = ls_cd-objectid+3(4) anln1 = ls_cd-objectid+7(12) anln2 = ls_cd-objectid+19(4)
                                       ts = to_utc( iv_date = ls_cd-udate iv_time = ls_cd-utime ) ).
        ASSIGN lt_key[ bukrs = ls_key-bukrs anln1 = ls_key-anln1 anln2 = ls_key-anln2 ] TO FIELD-SYMBOL(<ls_k>).
        IF sy-subrc = 0.
          IF ls_key-ts > <ls_k>-ts.
            <ls_k>-ts = ls_key-ts.
          ENDIF.
        ELSE.
          INSERT ls_key INTO TABLE lt_key.
        ENDIF.
      ENDLOOP.
      DATA(lv_n_cd) = lines( lt_key ).
      " ② 그 날짜 이후 생성된 자산
      SELECT bukrs, anln1, anln2, erdat FROM anla
        WHERE bukrs = @iv_bukrs AND erdat >= @iv_date AND xloev = @space
        INTO TABLE @DATA(lt_new).
      LOOP AT lt_new INTO DATA(ls_new).
        IF NOT line_exists( lt_key[ bukrs = ls_new-bukrs anln1 = ls_new-anln1 anln2 = ls_new-anln2 ] ).
          INSERT VALUE #( bukrs = ls_new-bukrs anln1 = ls_new-anln1 anln2 = ls_new-anln2 ts = to_utc( ls_new-erdat ) ) INTO TABLE lt_key.
        ENDIF.
      ENDLOOP.
      DATA(lv_n_new) = lines( lt_key ) - lv_n_cd.
      " ②-1 시간종속 행의 효력일(ADATU)이 지난 실행 이후 오늘까지 도래한 자산(미리 바꿔 둔 코스트센터·룸 변경)
      SELECT bukrs, anln1, anln2, adatu FROM anlz
        WHERE bukrs = @iv_bukrs AND adatu > @iv_date AND adatu <= @sy-datum
        INTO TABLE @DATA(lt_eff).
      LOOP AT lt_eff INTO DATA(ls_eff).
        IF NOT line_exists( lt_key[ bukrs = ls_eff-bukrs anln1 = ls_eff-anln1 anln2 = ls_eff-anln2 ] ).
          INSERT VALUE #( bukrs = ls_eff-bukrs anln1 = ls_eff-anln1 anln2 = ls_eff-anln2 ts = to_utc( ls_eff-adatu ) ) INTO TABLE lt_key.
        ENDIF.
      ENDLOOP.
      mo_log->add( |대상 키: 변경 문서 { lv_n_cd }건, 신규 { lv_n_new }건, 효력일 도래 포함 합계 { lines( lt_key ) }건| ).
    ENDIF.
    IF lt_key IS INITIAL.
      RETURN.
    ENDIF.

    " 2) 마스터·시간종속 읽기 ---------------------------------------------
    DATA lt_k2 TYPE STANDARD TABLE OF gty_akey WITH EMPTY KEY.
    lt_k2 = lt_key.
    SELECT bukrs, anln1, anln2, anlkl, txt50, sernr, invnr, aktiv, deakt, ivdat, invzu, erdat
      FROM anla
      FOR ALL ENTRIES IN @lt_k2
      WHERE bukrs = @lt_k2-bukrs AND anln1 = @lt_k2-anln1 AND anln2 = @lt_k2-anln2 AND xloev = @space
      INTO TABLE @DATA(lt_anla).
    SORT lt_anla BY bukrs anln1 anln2.
    SELECT bukrs, anln1, anln2, kostl, werks, stort
      FROM anlz
      FOR ALL ENTRIES IN @lt_k2
      WHERE bukrs = @lt_k2-bukrs AND anln1 = @lt_k2-anln1 AND anln2 = @lt_k2-anln2
        AND adatu <= @sy-datum AND bdatu >= @sy-datum
      INTO TABLE @DATA(lt_anlz).
    SORT lt_anlz BY bukrs anln1 anln2.

    DATA lv_now TYPE timestamp.
    GET TIME STAMP FIELD lv_now.
    LOOP AT lt_anla INTO DATA(ls_a).
      DATA(lv_id) = |{ ls_a-bukrs }/{ ls_a-anln1 }/{ ls_a-anln2 }|.
      READ TABLE lt_anlz INTO DATA(ls_z) WITH KEY bukrs = ls_a-bukrs anln1 = ls_a-anln1 anln2 = ls_a-anln2 BINARY SEARCH.
      IF sy-subrc <> 0.
        CLEAR ls_z.
      ENDIF.
      " 송신 전 검증(08 4.3): API 필수 필드가 빈 자산은 빼고 경고
      IF ls_a-txt50 IS INITIAL OR ls_a-anlkl IS INITIAL OR ls_z-kostl IS INITIAL.
        mo_log->add( iv_type = 'W' iv_text = |ASSET { lv_id }: 설명·자산클래스·코스트센터 중 빈 값이 있어 보내지 않음| ).
        mv_err = mv_err + 1.
        CONTINUE.
      ENDIF.
      lv_ts = lt_key[ bukrs = ls_a-bukrs anln1 = ls_a-anln1 anln2 = ls_a-anln2 ]-ts.
      IF lv_ts IS INITIAL.
        lv_ts = COND #( WHEN ls_a-erdat IS NOT INITIAL THEN to_utc( ls_a-erdat ) ELSE lv_now ).
      ENDIF.
      DATA(ls_rec) = VALUE gty_asset(
        company_code = ls_a-bukrs asset_no = ls_a-anln1 sub_no = ls_a-anln2
        asset_class = ls_a-anlkl description = condense( ls_a-txt50 )
        serial_no = condense( ls_a-sernr ) inventory_no = condense( ls_a-invnr )
        inventory_note = condense( ls_a-invzu )
        cost_center = ls_z-kostl plant = ls_z-werks location = condense( ls_z-stort )
        changed_at = |{ lv_ts TIMESTAMP = ISO }Z| ).
      IF ls_a-aktiv IS NOT INITIAL.
        ls_rec-cap_date = |{ ls_a-aktiv DATE = ISO }|.
      ENDIF.
      IF ls_a-deakt IS NOT INITIAL.
        ls_rec-deact_date = |{ ls_a-deakt DATE = ISO }|.
      ENDIF.
      IF ls_a-ivdat IS NOT INITIAL.
        ls_rec-last_count_date = |{ ls_a-ivdat DATE = ISO }|.
      ENDIF.
      APPEND ls_rec TO rt_asset.
    ENDLOOP.
    mo_log->add( |ASSET: 송신 대상 { lines( rt_asset ) }건| ).
  ENDMETHOD.


  METHOD one_company_aa02.
    DATA(lv_req) = COND string( WHEN p_req IS NOT INITIAL THEN |-REQ{ p_req }| ).
    mv_batch = |AA02-{ mv_stamp(12) }-{ iv_bukrs }{ lv_req }|.
    CLEAR: mv_failed, mv_sent, mv_err, mv_http.

    mo_log = NEW #( iv_if_id = gc_if_av iv_batch_id = mv_batch iv_bukrs = iv_bukrs ).
    mo_api = NEW #( iv_bukrs = iv_bukrs iv_dest_api = p_api iv_dest_token = p_tok ).
    mo_log->add( |IF-AA-02 { COND string( WHEN p_dry = abap_true THEN `시험 실행(보내지 않음)` ELSE `송신` ) }: 회사코드 { iv_bukrs }, 배치 { mv_batch }, SAP 시스템 { mo_api->system_id( ) }{
                 COND string( WHEN p_close = abap_true THEN `, 마감 실행(isClosing)` ) }| ).

    DATA(lt_value) = sel_values( iv_bukrs ).
    IF lt_value IS INITIAL.
      mo_log->add( 'VALUE: 보낼 자산이 없습니다' ).
    ELSE.
      IF p_orig = abap_true.
        fill_origins( EXPORTING iv_bukrs = iv_bukrs CHANGING ct_value = lt_value ).
      ENDIF.
      send( iv_type = 'VALUE' it_records = lt_value iv_path = '/sap/asset-values' iv_chunked = abap_false iv_compress = abap_false
            iv_head = COND #( WHEN p_close = abap_true THEN `"isClosing":true` ) ).
    ENDIF.

    IF mv_failed = abap_true.
      mv_any_failed = abap_true.
    ENDIF.
    save_log( ).
  ENDMETHOD.


  METHOD fill_origins.
    " 취득 출처: PO(EKKN 계정지정이 자산) + AuC 정산 원천. 회사코드 단위로 한 번에 읽어 메모리에서 붙인다
    TYPES: BEGIN OF lty_po,
             anln1 TYPE anln1,
             anln2 TYPE anln2,
             ebeln TYPE ebeln,
             ebelp TYPE ebelp,
             lifnr TYPE lifnr,
             name1 TYPE lfa1-name1,
             bedat TYPE ekko-bedat,
           END OF lty_po,
           BEGIN OF lty_key,
             anln1 TYPE anln1,
             anln2 TYPE anln2,
           END OF lty_key,
           BEGIN OF lty_doc,
             gjahr TYPE gjahr,
             belnr TYPE anek-belnr,
             anln1 TYPE anln1,
             anln2 TYPE anln2,
           END OF lty_doc,
           BEGIN OF lty_src,
             anln1 TYPE anln1,
             anln2 TYPE anln2,
             auc1  TYPE anln1,
             auc2  TYPE anln2,
           END OF lty_src.
    DATA lt_po TYPE SORTED TABLE OF lty_po WITH NON-UNIQUE KEY anln1 anln2.
    DATA lt_src TYPE SORTED TABLE OF lty_src WITH UNIQUE KEY anln1 anln2 auc1 auc2.
    DATA lt_auc TYPE SORTED TABLE OF lty_key WITH UNIQUE KEY anln1 anln2.
    DATA lt_adoc TYPE STANDARD TABLE OF lty_doc WITH EMPTY KEY.
    DATA lt_rdoc TYPE STANDARD TABLE OF lty_doc WITH EMPTY KEY.
    DATA lr_aucc TYPE RANGE OF anlkl.

    SELECT DISTINCT n~anln1, n~anln2, n~ebeln, n~ebelp, h~lifnr, v~name1, h~bedat
      FROM ekkn AS n
      INNER JOIN ekpo AS p ON p~ebeln = n~ebeln AND p~ebelp = n~ebelp
      INNER JOIN ekko AS h ON h~ebeln = n~ebeln
      LEFT OUTER JOIN lfa1 AS v ON v~lifnr = h~lifnr
      WHERE h~bukrs = @iv_bukrs AND n~anln1 <> @space AND p~loekz = @space AND n~loekz = @space
      INTO CORRESPONDING FIELDS OF TABLE @lt_po.
    mo_log->add( |ORIGIN: 자산에 걸린 PO 계정지정 { lines( lt_po ) }건| ).

    " AuC 정산 원천: AuC 자산이 올라간 전표(ANEK-BELNR)에 같이 올라간 일반 자산 = 정산 받은 자산
    DATA(lt_aucc) = zcl_alm_cfg=>get_list( 'AUC_CLASS' ).
    IF lt_aucc IS INITIAL.
      mo_log->add( iv_type = 'W' iv_text = 'ZALM_CFG AUC_CLASS가 비어 있어 AuC 정산 출처(AUC)는 찾지 않습니다' ).
    ELSE.
      lr_aucc = VALUE #( FOR c IN lt_aucc ( sign = 'I' option = 'EQ' low = CONV anlkl( |{ c ALPHA = IN }| ) ) ).
      SELECT anln1, anln2 FROM anla
        WHERE bukrs = @iv_bukrs AND anlkl IN @lr_aucc
        INTO CORRESPONDING FIELDS OF TABLE @lt_auc.
      IF lt_auc IS NOT INITIAL.
        SELECT DISTINCT gjahr, belnr, anln1, anln2 FROM anek
          FOR ALL ENTRIES IN @lt_auc
          WHERE bukrs = @iv_bukrs AND anln1 = @lt_auc-anln1 AND anln2 = @lt_auc-anln2 AND belnr <> @space
          INTO CORRESPONDING FIELDS OF TABLE @lt_adoc.
      ENDIF.
      IF lt_adoc IS NOT INITIAL.
        SELECT DISTINCT gjahr, belnr, anln1, anln2 FROM anek
          FOR ALL ENTRIES IN @lt_adoc
          WHERE bukrs = @iv_bukrs AND gjahr = @lt_adoc-gjahr AND belnr = @lt_adoc-belnr
          INTO CORRESPONDING FIELDS OF TABLE @lt_rdoc.
        LOOP AT lt_rdoc INTO DATA(ls_r).
          READ TABLE lt_auc WITH TABLE KEY anln1 = ls_r-anln1 anln2 = ls_r-anln2 TRANSPORTING NO FIELDS.
          IF sy-subrc = 0.
            CONTINUE.   " 받는 쪽이 AuC면 정산 받은 자산이 아님
          ENDIF.
          LOOP AT lt_adoc INTO DATA(ls_a) WHERE gjahr = ls_r-gjahr AND belnr = ls_r-belnr.
            INSERT VALUE lty_src( anln1 = ls_r-anln1 anln2 = ls_r-anln2 auc1 = ls_a-anln1 auc2 = ls_a-anln2 ) INTO TABLE lt_src.
          ENDLOOP.
        ENDLOOP.
      ENDIF.
      mo_log->add( |ORIGIN: AuC 자산 { lines( lt_auc ) }개, AuC 정산으로 취득한 자산 { lines( lt_src ) }건(AUC_CLASS { concat_lines_of( table = lt_aucc sep = ` ` ) })| ).
    ENDIF.

    DATA(lv_with) = 0.
    DATA(lv_shown) = 0.
    LOOP AT ct_value ASSIGNING FIELD-SYMBOL(<ls_v>).
      DATA(lv_a1) = CONV anln1( <ls_v>-asset_no ).
      DATA(lv_a2) = CONV anln2( <ls_v>-sub_no ).
      LOOP AT lt_po INTO DATA(ls_po) WHERE anln1 = lv_a1 AND anln2 = lv_a2.
        APPEND VALUE #( source_type = 'DIRECT' po_no = ls_po-ebeln po_item = ls_po-ebelp vendor_code = ls_po-lifnr vendor_name = ls_po-name1
                        po_date = COND #( WHEN ls_po-bedat IS NOT INITIAL THEN |{ ls_po-bedat DATE = ISO }| ) ) TO <ls_v>-origins.
      ENDLOOP.
      LOOP AT lt_src INTO DATA(ls_s) WHERE anln1 = lv_a1 AND anln2 = lv_a2.
        DATA(lv_found) = abap_false.
        LOOP AT lt_po INTO ls_po WHERE anln1 = ls_s-auc1 AND anln2 = ls_s-auc2.
          lv_found = abap_true.
          APPEND VALUE #( source_type = 'AUC' po_no = ls_po-ebeln po_item = ls_po-ebelp vendor_code = ls_po-lifnr vendor_name = ls_po-name1
                          po_date = COND #( WHEN ls_po-bedat IS NOT INITIAL THEN |{ ls_po-bedat DATE = ISO }| )
                          auc_asset_no = ls_s-auc1 auc_sub_no = ls_s-auc2 ) TO <ls_v>-origins.
        ENDLOOP.
        IF lv_found = abap_false.
          APPEND VALUE #( source_type = 'AUC' auc_asset_no = ls_s-auc1 auc_sub_no = ls_s-auc2 ) TO <ls_v>-origins.
        ENDIF.
      ENDLOOP.
      IF lines( <ls_v>-origins ) > 50.
        DELETE <ls_v>-origins FROM 51.
        mo_log->add( iv_type = 'W' iv_text = |{ lv_a1 }-{ lv_a2 }: 출처가 50건을 넘어 앞 50건만 보냅니다| ).
      ENDIF.
      IF <ls_v>-origins IS NOT INITIAL.
        lv_with = lv_with + 1.
        IF p_dry = abap_true AND lv_shown < 10.
          lv_shown = lv_shown + 1.
          DATA(lv_txt) = VALUE string( ).
          LOOP AT <ls_v>-origins INTO DATA(ls_o).
            lv_txt = |{ lv_txt }{ COND string( WHEN lv_txt IS NOT INITIAL THEN `, ` ) }{ ls_o-source_type }{
                     COND string( WHEN ls_o-auc_asset_no IS NOT INITIAL THEN | AuC { ls_o-auc_asset_no }| ) } PO { ls_o-po_no }/{ ls_o-po_item }|.
          ENDLOOP.
          mo_log->add( |  { lv_a1 }-{ lv_a2 } 출처: { lv_txt }| ).
        ENDIF.
      ENDIF.
    ENDLOOP.
    mo_log->add( |ORIGIN: 출처가 있는 자산 { lv_with }건 / 송신 대상 { lines( ct_value ) }건| ).
  ENDMETHOD.


  METHOD anlc_val.
    " ANLC 필드명으로 금액·숫자를 읽는다. 없는 필드는 0
    FIELD-SYMBOLS <lv_val> TYPE any.
    ASSIGN COMPONENT iv_field OF STRUCTURE is_anlc TO <lv_val>.
    IF sy-subrc = 0.
      rv_val = <lv_val>.
    ENDIF.
  ENDMETHOD.


  METHOD sel_values.
    " 올해 회계연도·현재 기간(회사코드의 회계연도 변형 기준). 함수 파라미터 이름이 릴리스마다 달라 동적으로 부르고, 안 되면 달력 연도
    DATA lv_curry TYPE gjahr.
    DATA lv_currp TYPE poper.
    DATA lv_periv TYPE t001-periv.
    DATA lv_date TYPE d.
    lv_date = sy-datum.
    SELECT SINGLE periv FROM t001 WHERE bukrs = @iv_bukrs INTO @lv_periv.
    TRY.
        DATA(lt_ptab) = VALUE abap_func_parmbind_tab(
          ( name = 'I_DATE'  kind = abap_func_exporting value = REF #( lv_date ) )
          ( name = 'I_PERIV' kind = abap_func_exporting value = REF #( lv_periv ) )
          ( name = 'E_GJAHR' kind = abap_func_importing value = REF #( lv_curry ) )
          ( name = 'E_BUPER' kind = abap_func_importing value = REF #( lv_currp ) ) ).
        DATA(lt_etab) = VALUE abap_func_excpbind_tab( ( name = 'OTHERS' value = 1 ) ).
        CALL FUNCTION 'DATE_TO_PERIOD_CONVERT'
          PARAMETER-TABLE lt_ptab
          EXCEPTION-TABLE lt_etab.
        IF sy-subrc <> 0.
          CLEAR: lv_curry, lv_currp.
        ENDIF.
      CATCH cx_sy_dyn_call_error.
        CLEAR: lv_curry, lv_currp.
    ENDTRY.
    IF lv_curry IS INITIAL.
      lv_curry = sy-datum(4).
      lv_currp = sy-datum+4(2).
      mo_log->add( iv_type = 'W' iv_text = |회계연도 변형({ lv_periv })으로 기간을 구하지 못해 달력 연도·월을 씁니다| ).
    ENDIF.

    mo_log->add( |회계연도 { lv_curry }, 현재 전기 기간 { lv_currp }, 상각영역 01, 보낼 기간: { COND string( WHEN p_per > 0 THEN |화면 지정 { p_per }| ELSE `ANLC-PERAF(없으면 현재 전기 기간)` ) }| ).

    SELECT bukrs, anln1, anln2 FROM anla
      WHERE bukrs = @iv_bukrs AND xloev = @space
      ORDER BY bukrs, anln1, anln2
      INTO TABLE @DATA(lt_anla).
    IF lt_anla IS INITIAL.
      RETURN.
    ENDIF.
    SELECT * FROM anlc
      WHERE bukrs = @iv_bukrs AND gjahr = @lv_curry AND afabe = '01'
      INTO TABLE @DATA(lt_anlc).
    SORT lt_anlc BY bukrs anln1 anln2.
    " 현재 유효한 상각 조건: 오늘 이후까지 유효한 행 중 가장 이른 것
    SELECT bukrs, anln1, anln2, bdatu, ndjar, ndper, afasl FROM anlb
      WHERE bukrs = @iv_bukrs AND afabe = '01' AND bdatu >= @sy-datum
      INTO TABLE @DATA(lt_anlb).
    SORT lt_anlb BY bukrs anln1 anln2 bdatu.

    DATA(lt_extra) = zcl_alm_cfg=>get_list( 'AA02_DEP_EXTRA' ).
    DATA(lv_no_row) = 0.
    DATA(lv_shown) = 0.

    LOOP AT lt_anla INTO DATA(ls_a).
      DATA(ls_rec) = VALUE gty_value( company_code = ls_a-bukrs asset_no = ls_a-anln1 sub_no = ls_a-anln2
                                      fiscal_year = lv_curry period = 1 dep_area = '01' ).
      READ TABLE lt_anlc INTO DATA(ls_c) WITH KEY bukrs = ls_a-bukrs anln1 = ls_a-anln1 anln2 = ls_a-anln2 BINARY SEARCH.
      IF sy-subrc = 0.
        DATA(lv_extra) = CONV decfloat34( 0 ).
        LOOP AT lt_extra INTO DATA(lv_f).
          lv_extra = lv_extra + anlc_val( is_anlc = ls_c iv_field = lv_f ).
        ENDLOOP.
        DATA(lv_kansw) = anlc_val( is_anlc = ls_c iv_field = 'KANSW' ).
        DATA(lv_answl) = anlc_val( is_anlc = ls_c iv_field = 'ANSWL' ).
        DATA(lv_knafa) = anlc_val( is_anlc = ls_c iv_field = 'KNAFA' ).
        DATA(lv_nafag) = anlc_val( is_anlc = ls_c iv_field = 'NAFAG' ).
        IF p_per > 0.
          ls_rec-period = p_per.
        ELSE.
          DATA(lv_peraf) = CONV i( anlc_val( is_anlc = ls_c iv_field = 'PERAF' ) ).
          ls_rec-period = COND #( WHEN lv_peraf > 0 THEN lv_peraf ELSE nmax( val1 = CONV i( lv_currp ) val2 = 1 ) ).
        ENDIF.
        ls_rec-acquisition_value = lv_kansw + lv_answl.
        ls_rec-accum_depreciation = lv_knafa + lv_nafag + lv_extra.
        IF p_dry = abap_true AND lv_shown < 10.
          lv_shown = lv_shown + 1.
          mo_log->add( |  { ls_a-anln1 }-{ ls_a-anln2 } 기간 { ls_rec-period }: KANSW { lv_kansw } + ANSWL { lv_answl } = { ls_rec-acquisition_value } / KNAFA { lv_knafa } + NAFAG { lv_nafag }{
                       COND string( WHEN lt_extra IS NOT INITIAL THEN | + 추가 { lv_extra }| ) } = { ls_rec-accum_depreciation }| ).
        ENDIF.
      ELSE.
        " ANLC 행이 없는 자산(신규·연초 상각 전): 금액 0을 명시해 보낸다(T30)
        lv_no_row = lv_no_row + 1.
      ENDIF.
      ls_rec-net_book_value = ls_rec-acquisition_value + ls_rec-accum_depreciation.
      READ TABLE lt_anlb INTO DATA(ls_b) WITH KEY bukrs = ls_a-bukrs anln1 = ls_a-anln1 anln2 = ls_a-anln2 BINARY SEARCH.
      IF sy-subrc = 0.
        ls_rec-useful_life_years = ls_b-ndjar.
        ls_rec-useful_life_periods = ls_b-ndper.
        ls_rec-dep_key = ls_b-afasl.
      ENDIF.
      APPEND ls_rec TO rt_value.
    ENDLOOP.
    mo_log->add( |VALUE: 송신 대상 { lines( rt_value ) }건(ANLC 행이 없어 금액 0으로 보내는 자산 { lv_no_row }건)| ).
    IF lt_extra IS NOT INITIAL.
      mo_log->add( |합산에 추가한 ANLC 필드(ZALM_CFG AA02_DEP_EXTRA): { concat_lines_of( table = lt_extra sep = ` ` ) }| ).
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
  IF p_var <> 'MD01' AND p_var <> 'AA01' AND p_var <> 'AA02'.
    MESSAGE '변형은 MD01(조직·코드 마스터), AA01(자산 마스터 델타), AA02(자산 금액)입니다. MM01은 이어서 추가합니다' TYPE 'E'.
  ENDIF.
  IF p_per < 0 OR p_per > 16.
    MESSAGE '기간은 0(자동) 또는 1~16입니다' TYPE 'E'.
  ENDIF.
  IF p_close = abap_true AND p_var <> 'AA02'.
    MESSAGE '마감 실행(isClosing)은 AA02에서만 씁니다' TYPE 'E'.
  ENDIF.
  IF p_chunk < 1 OR p_chunk > 5000.
    MESSAGE '분할 크기는 1~5000입니다(자산 AA01·금액 AA02는 1,000건으로 제한)' TYPE 'E'.
  ENDIF.

START-OF-SELECTION.
  NEW lcl_run( )->run( ).

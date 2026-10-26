*&---------------------------------------------------------------------*
*& ZALM_IF_RUNREQ - IF-OP-01 수동 실행 요청 처리(WBS 7.9, 08 6.7)
*&   15분 잡(ZALM_POSTING_15M)의 1단계. ALM 화면 ALM-310에서 요청한 송신을 SAP이 가져가 즉시 잡으로 띄운다
*&   1. GET /sap/run-requests (응답한 요청은 ALM에서 PICKED가 된다) → 2. 요청마다 잡 ZALM_RUN_<변형>을 열고
*&   ZALM_IF_MASTER_SEND를 SUBMIT(변형 MD01·AA01·AA02·RC01, 요청 id 앞 8자리를 P_REQ로, RC01은 P_CAMP, AA02 마감은 P_CLOSE)
*&   → 3. 즉시 시작. 송신 로그의 batchId에 -REQ<id 앞 8자리>가 붙어 ALM이 요청을 DONE으로 바꾼다
*&   - 같은 잡 안에서 송신하지 않고 별도 잡으로 띄워 긴 송신이 15분 전기 잡을 밀지 않게 한다
*&   - 지원하지 않는 IF(IF-MM-01 등 보류)는 경고만 남긴다(ALM에서는 PICKED로 남으므로 화면에서 취소)
*&   - 이 프로그램을 실행하면 요청이 PICKED가 되므로 시험 실행 옵션은 없다. 확인만 하려면 ALM-310 화면을 본다
*&   - 요청 확인이 실패해도 잡은 정상 종료한다(다음 스텝 전기가 계속 돌도록). 실패는 로그·운영 모니터에 나온다
*&   - 실행 결과는 ZALM_IF_LOG(IF-OP-01)에 매번 1행(요청이 없어도 남김): 운영 모니터가 이 행으로 15분 잡이 도는지 본다
*&---------------------------------------------------------------------*
REPORT zalm_if_runreq.

CONSTANTS gc_if TYPE c LENGTH 10 VALUE 'IF-OP-01'.

DATA gv_bukrs_sel TYPE bukrs.

SELECT-OPTIONS s_bukrs FOR gv_bukrs_sel NO INTERVALS.
PARAMETERS: p_api  TYPE rfcdest DEFAULT 'ZALM_API' OBLIGATORY,
            p_tok  TYPE rfcdest DEFAULT 'ZALM_TOKEN' OBLIGATORY,
            p_prog TYPE progname DEFAULT 'ZALM_IF_MASTER_SEND' OBLIGATORY.

TYPES:
  BEGIN OF gty_req,
    id            TYPE string,
    interface_id  TYPE string,
    run_type      TYPE string,
    campaign_code TYPE string,
    is_closing    TYPE abap_bool,
  END OF gty_req,
  gtt_req TYPE STANDARD TABLE OF gty_req WITH EMPTY KEY,
  BEGIN OF gty_list,
    items TYPE gtt_req,
  END OF gty_list.

CLASS lcl_run DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS run.

  PRIVATE SECTION.
    TYPES gtt_bukrs TYPE STANDARD TABLE OF bukrs WITH EMPTY KEY.
    DATA mt_bukrs TYPE gtt_bukrs.
    DATA mv_stamp TYPE string.
    DATA mo_log TYPE REF TO zcl_alm_log.
    DATA mv_failed TYPE abap_bool.
    DATA mv_any_failed TYPE abap_bool.

    METHODS targets.
    METHODS one_company IMPORTING iv_bukrs TYPE bukrs.
    METHODS launch
      IMPORTING iv_bukrs     TYPE bukrs
                is_req       TYPE gty_req
      RETURNING VALUE(rv_ok) TYPE abap_bool.
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

    LOOP AT mt_bukrs INTO DATA(lv_bukrs).
      one_company( lv_bukrs ).
    ENDLOOP.

    IF mv_any_failed = abap_true.
      " 잡을 취소(E)하지 않는다: 같은 잡의 다음 스텝(ZALM_IF_POSTING 전기)이 요청 확인 실패 때문에 멈추면 안 된다. 실패는 ZALM_IF_LOG·모니터에서 본다
      MESSAGE 'IF-OP-01 실패가 있습니다. SLG1(객체 ZALM)과 ZALM_IF_LOG를 확인하세요' TYPE 'S' DISPLAY LIKE 'E'.
    ELSE.
      MESSAGE 'IF-OP-01 완료' TYPE 'S'.
    ENDIF.
  ENDMETHOD.


  METHOD targets.
    IF s_bukrs[] IS NOT INITIAL.
      SELECT bukrs FROM t001 WHERE bukrs IN @s_bukrs ORDER BY bukrs INTO TABLE @mt_bukrs.
    ELSE.
      DATA(lt_cfg) = zcl_alm_cfg=>get_list( zcl_alm_cfg=>c_bukrs ).
      LOOP AT lt_cfg INTO DATA(lv_cfg).
        APPEND CONV bukrs( lv_cfg ) TO mt_bukrs.
      ENDLOOP.
      SORT mt_bukrs BY table_line.
      DELETE ADJACENT DUPLICATES FROM mt_bukrs COMPARING table_line.
    ENDIF.
  ENDMETHOD.


  METHOD one_company.
    DATA ls_list TYPE gty_list.
    DATA lv_started TYPE i.
    DATA lv_bad TYPE i.

    CLEAR mv_failed.
    mo_log = NEW #( iv_if_id = gc_if iv_batch_id = |OP01-{ mv_stamp(12) }-{ iv_bukrs }| iv_bukrs = iv_bukrs ).
    DATA(lo_api) = NEW zcl_alm_http_client( iv_bukrs = iv_bukrs iv_dest_api = p_api iv_dest_token = p_tok ).
    DATA(lv_http) = 0.

    TRY.
        DATA(ls_resp) = lo_api->get( '/sap/run-requests' ).
        lv_http = ls_resp-status.
        IF ls_resp-status <> 200.
          DATA(ls_problem) = zcl_alm_http_client=>parse_problem( ls_resp-body ).
          mo_log->add( iv_type = 'E' iv_text = |GET /sap/run-requests HTTP { ls_resp-status } { ls_problem-code } { ls_problem-detail }| ).
          mv_failed = abap_true.
        ELSE.
          /ui2/cl_json=>deserialize( EXPORTING json = ls_resp-body pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                     CHANGING data = ls_list ).
        ENDIF.
      CATCH zcx_alm INTO DATA(lx).
        lv_http = lx->mv_http_status.
        mo_log->add( iv_type = 'E' iv_text = |GET /sap/run-requests: { lx->get_text( ) }| ).
        mv_failed = abap_true.
    ENDTRY.

    IF mv_failed = abap_false.
      mo_log->add( |IF-OP-01: 회사코드 { iv_bukrs }, SAP 시스템 { lo_api->system_id( ) }, 요청 { lines( ls_list-items ) }건| ).
      LOOP AT ls_list-items INTO DATA(ls_req).
        IF launch( iv_bukrs = iv_bukrs is_req = ls_req ) = abap_true.
          lv_started = lv_started + 1.
        ELSE.
          lv_bad = lv_bad + 1.
        ENDIF.
      ENDLOOP.
      IF ls_list-items IS NOT INITIAL.
        mo_log->add( iv_type = COND #( WHEN lv_bad > 0 THEN 'W' ELSE 'S' )
                     iv_text = |잡 시작 { lv_started }건 / 시작 못함 { lv_bad }건| ).
      ENDIF.
    ENDIF.

    IF mv_failed = abap_true.
      mv_any_failed = abap_true.
    ENDIF.
    mo_log->set_result(
      iv_status  = COND #( WHEN mv_failed = abap_true THEN zcl_alm_log=>c_failed
                           WHEN lv_bad > 0 THEN zcl_alm_log=>c_partial
                           ELSE zcl_alm_log=>c_success )
      iv_http    = lv_http
      iv_rec_cnt = lines( ls_list-items )
      iv_err_cnt = lv_bad + COND i( WHEN mv_failed = abap_true THEN 1 ELSE 0 ) ).
    mo_log->save( iv_commit = abap_true ).
  ENDMETHOD.


  METHOD launch.
    DATA lv_jobcount TYPE tbtcjob-jobcount.
    DATA lv_var TYPE c LENGTH 4.
    DATA lv_req TYPE c LENGTH 8.
    DATA lv_camp TYPE c LENGTH 6.
    DATA lv_close TYPE c LENGTH 1.
    DATA lt_bukrs TYPE RANGE OF bukrs.

    lv_var = SWITCH #( is_req-interface_id
                       WHEN 'IF-MD-01' THEN 'MD01'
                       WHEN 'IF-AA-01' THEN 'AA01'
                       WHEN 'IF-AA-02' THEN 'AA02'
                       WHEN 'IF-RC-01' THEN 'RC01' ).
    IF lv_var IS INITIAL OR strlen( is_req-id ) < 8.
      mo_log->add( iv_type = 'W' iv_text = |요청 { is_req-id } { is_req-interface_id }: 지원하지 않는 IF라 건너뜁니다(ALM-310에서 취소하세요)| ).
      RETURN.
    ENDIF.
    lv_req = is_req-id(8).
    IF lv_var = 'RC01' AND is_req-run_type = 'CAMPAIGN'.
      lv_camp = is_req-campaign_code.
    ENDIF.
    IF lv_var = 'AA02' AND is_req-is_closing = abap_true.
      lv_close = abap_true.
    ENDIF.
    lt_bukrs = VALUE #( ( sign = 'I' option = 'EQ' low = iv_bukrs ) ).
    DATA(lv_job) = CONV tbtcjob-jobname( |ZALM_RUN_{ lv_var }| ).

    CALL FUNCTION 'JOB_OPEN'
      EXPORTING
        jobname          = lv_job
      IMPORTING
        jobcount         = lv_jobcount
      EXCEPTIONS
        cant_create_job  = 1
        invalid_job_data = 2
        jobname_missing  = 3
        OTHERS           = 4.
    IF sy-subrc <> 0.
      mo_log->add( iv_type = 'E' iv_text = |요청 { lv_req } { lv_job }: JOB_OPEN 실패(sy-subrc { sy-subrc }). S_BTCH_JOB 권한 확인| ).
      RETURN.
    ENDIF.

    TRY.
        SUBMIT (p_prog)
          WITH p_var = lv_var
          WITH s_bukrs IN lt_bukrs
          WITH p_api = p_api
          WITH p_tok = p_tok
          WITH p_req = lv_req
          WITH p_camp = lv_camp
          WITH p_close = lv_close
          VIA JOB lv_job NUMBER lv_jobcount AND RETURN.
      CATCH cx_root INTO DATA(lx_sub).
        mo_log->add( iv_type = 'E' iv_text = |요청 { lv_req } { lv_job }: SUBMIT 실패 { lx_sub->get_text( ) }| ).
        CALL FUNCTION 'BP_JOB_DELETE'
          EXPORTING
            jobcount                 = lv_jobcount
            jobname                  = lv_job
          EXCEPTIONS
            OTHERS                   = 1.
        RETURN.
    ENDTRY.

    CALL FUNCTION 'JOB_CLOSE'
      EXPORTING
        jobcount             = lv_jobcount
        jobname              = lv_job
        strtimmed            = abap_true
      EXCEPTIONS
        cant_start_immediate = 1
        invalid_startdate    = 2
        jobname_missing      = 3
        job_close_failed     = 4
        job_nosteps          = 5
        job_notex            = 6
        lock_failed          = 7
        OTHERS               = 8.
    IF sy-subrc <> 0.
      mo_log->add( iv_type = 'E' iv_text = |요청 { lv_req } { lv_job }: JOB_CLOSE 실패(sy-subrc { sy-subrc }). S_BTCH_JOB JOBACTION RELE 권한 확인| ).
      RETURN.
    ENDIF.

    mo_log->add( iv_type = 'S' iv_text = |요청 { lv_req } { is_req-interface_id }: 잡 { lv_job }({ lv_jobcount }) 시작{
                 COND string( WHEN lv_camp IS NOT INITIAL THEN |, 캠페인 { lv_camp }| ) }{
                 COND string( WHEN lv_close IS NOT INITIAL THEN `, 마감 실행` ) }| ).
    rv_ok = abap_true.
  ENDMETHOD.

ENDCLASS.


START-OF-SELECTION.
  NEW lcl_run( )->run( ).

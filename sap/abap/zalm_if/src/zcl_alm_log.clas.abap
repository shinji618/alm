"! ALM 인터페이스 로그. 08 명세서 7장·8장
"! - ZALM_IF_LOG: 실행(배치)·전기 건마다 한 행. 10년 보관
"! - 응용 로그(SLG1): 객체 ZALM, 하위 객체 = IF ID(예: IF-AA-01). SLG0에 객체가 없으면 SLG1만 건너뛴다
"! - 배치 잡이면 잡 로그(SM37)에도 남긴다
"! save( )는 COMMIT하지 않는다(전기 건은 BAPI와 같은 LUW에서 확정, 08 4.2-5). 실행 로그는 iv_commit = abap_true
CLASS zcl_alm_log DEFINITION
  PUBLIC
  CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES:
      BEGIN OF ty_msg,
        type TYPE symsgty,
        text TYPE string,
      END OF ty_msg,
      tt_msg TYPE STANDARD TABLE OF ty_msg WITH EMPTY KEY.

    CONSTANTS:
      c_success TYPE zalm_if_log-status VALUE 'SUCCESS',
      c_partial TYPE zalm_if_log-status VALUE 'PARTIAL',
      c_failed  TYPE zalm_if_log-status VALUE 'FAILED',
      c_posted  TYPE zalm_if_log-status VALUE 'POSTED',
      c_running TYPE zalm_if_log-status VALUE 'RUNNING'.

    DATA ms_row TYPE zalm_if_log READ-ONLY.
    DATA mt_msg TYPE tt_msg READ-ONLY.

    "! iv_echo: 대화 실행이면 메시지를 화면(WRITE)에도 출력
    METHODS constructor
      IMPORTING
        iv_if_id      TYPE csequence
        iv_batch_id   TYPE csequence OPTIONAL
        iv_posting_id TYPE csequence OPTIONAL
        iv_bukrs      TYPE bukrs OPTIONAL
        iv_corr_id    TYPE csequence OPTIONAL
        iv_echo       TYPE abap_bool DEFAULT abap_true.

    "! 메시지(I·S·W·E·A). SLG1·잡 로그·화면
    METHODS add
      IMPORTING
        iv_type TYPE symsgty DEFAULT 'I'
        iv_text TYPE csequence.

    METHODS set_result
      IMPORTING
        iv_status   TYPE csequence
        iv_http     TYPE i OPTIONAL
        iv_rec_cnt  TYPE i OPTIONAL
        iv_err_cnt  TYPE i OPTIONAL
        iv_msg_json TYPE string OPTIONAL.

    "! 전기 결과(08 4.2-5). 전표번호는 커밋 뒤 BKPF(AWTYP·AWKEY)로 찾아 다시 넣는다
    METHODS set_posting
      IMPORTING
        iv_belnr    TYPE belnr_d OPTIONAL
        iv_gjahr    TYPE gjahr OPTIONAL
        iv_anln1    TYPE anln1 OPTIONAL
        iv_anln2    TYPE anln2 OPTIONAL
        iv_ebeln    TYPE ebeln OPTIONAL
        iv_obj_type TYPE awtyp OPTIONAL
        iv_obj_key  TYPE awkey OPTIONAL.

    METHODS set_corr_id
      IMPORTING
        iv_corr_id TYPE csequence.

    "! ZALM_IF_LOG(MODIFY)와 SLG1 저장. iv_commit이면 COMMIT WORK
    METHODS save
      IMPORTING
        iv_commit TYPE abap_bool DEFAULT abap_false.

    "! 오류 개수(E·A)
    METHODS error_count
      RETURNING
        VALUE(rv_count) TYPE i.

    "! 같은 전기 건의 마지막 로그(중복 전기 확인, 08 4.2-2)
    CLASS-METHODS find_posting
      IMPORTING
        iv_posting_id TYPE csequence
      RETURNING
        VALUE(rs_row) TYPE zalm_if_log.

    "! 메시지 목록 → JSON([{"type":"E","text":"…"}])
    CLASS-METHODS messages_json
      IMPORTING
        it_msg         TYPE tt_msg
      RETURNING
        VALUE(rv_json) TYPE string.

  PRIVATE SECTION.
    DATA mv_bal_handle TYPE balloghndl.
    DATA mv_bal_ok TYPE abap_bool.
    DATA mv_echo TYPE abap_bool.

    METHODS bal_open.
ENDCLASS.



CLASS zcl_alm_log IMPLEMENTATION.

  METHOD constructor.
    TRY.
        ms_row-log_id = cl_system_uuid=>create_uuid_x16_static( ).
      CATCH cx_uuid_error.
        CLEAR ms_row-log_id.
    ENDTRY.
    ms_row-if_id = iv_if_id.
    ms_row-batch_id = iv_batch_id.
    ms_row-posting_id = iv_posting_id.
    ms_row-bukrs = iv_bukrs.
    ms_row-corr_id = iv_corr_id.
    ms_row-status = c_running.
    ms_row-uname = sy-uname.
    GET TIME STAMP FIELD ms_row-start_ts.
    mv_echo = xsdbool( iv_echo = abap_true AND sy-batch = abap_false ).
    bal_open( ).
  ENDMETHOD.


  METHOD bal_open.
    DATA ls_log TYPE bal_s_log.
    ls_log-object = 'ZALM'.
    ls_log-subobject = ms_row-if_id.
    ls_log-extnumber = COND #( WHEN ms_row-posting_id IS NOT INITIAL THEN ms_row-posting_id ELSE ms_row-batch_id ).
    ls_log-aluser = sy-uname.
    ls_log-alprog = sy-cprog.
    CALL FUNCTION 'BAL_LOG_CREATE'
      EXPORTING
        i_s_log      = ls_log
      IMPORTING
        e_log_handle = mv_bal_handle
      EXCEPTIONS
        OTHERS       = 1.
    IF sy-subrc <> 0.
      " SLG0에 하위 객체(IF ID)가 없으면 객체 ZALM만으로
      CLEAR ls_log-subobject.
      CALL FUNCTION 'BAL_LOG_CREATE'
        EXPORTING
          i_s_log      = ls_log
        IMPORTING
          e_log_handle = mv_bal_handle
        EXCEPTIONS
          OTHERS       = 1.
    ENDIF.
    mv_bal_ok = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.


  METHOD add.
    DATA lv_text TYPE c LENGTH 200.
    DATA lv_line TYPE string.

    APPEND VALUE #( type = iv_type text = iv_text ) TO mt_msg.
    lv_line = iv_text.

    IF mv_bal_ok = abap_true.
      lv_text = lv_line.
      CALL FUNCTION 'BAL_LOG_MSG_ADD_FREE_TEXT'
        EXPORTING
          i_log_handle = mv_bal_handle
          i_msgty      = iv_type
          i_text       = lv_text
        EXCEPTIONS
          OTHERS       = 1.
      IF sy-subrc <> 0.
        mv_bal_ok = abap_false.
      ENDIF.
    ENDIF.

    IF sy-batch = abap_true.
      " 잡 로그(SM37). 오류도 S로 남겨 잡을 멈추지 않는다
      MESSAGE lv_line TYPE 'S'.
    ELSEIF mv_echo = abap_true.
      WRITE / |{ iv_type } { lv_line }|.
    ENDIF.
  ENDMETHOD.


  METHOD set_result.
    ms_row-status = iv_status.
    IF iv_http IS SUPPLIED.
      ms_row-http_status = iv_http.
    ENDIF.
    IF iv_rec_cnt IS SUPPLIED.
      ms_row-rec_cnt = iv_rec_cnt.
    ENDIF.
    IF iv_err_cnt IS SUPPLIED.
      ms_row-err_cnt = iv_err_cnt.
    ENDIF.
    IF iv_msg_json IS SUPPLIED.
      ms_row-msg_json = iv_msg_json.
    ENDIF.
  ENDMETHOD.


  METHOD set_posting.
    IF iv_belnr IS SUPPLIED.
      ms_row-belnr = iv_belnr.
    ENDIF.
    IF iv_gjahr IS SUPPLIED.
      ms_row-gjahr = iv_gjahr.
    ENDIF.
    IF iv_anln1 IS SUPPLIED.
      ms_row-anln1 = iv_anln1.
    ENDIF.
    IF iv_anln2 IS SUPPLIED.
      ms_row-anln2 = iv_anln2.
    ENDIF.
    IF iv_ebeln IS SUPPLIED.
      ms_row-ebeln = iv_ebeln.
    ENDIF.
    IF iv_obj_type IS SUPPLIED.
      ms_row-obj_type = iv_obj_type.
    ENDIF.
    IF iv_obj_key IS SUPPLIED.
      ms_row-obj_key = iv_obj_key.
    ENDIF.
  ENDMETHOD.


  METHOD set_corr_id.
    ms_row-corr_id = iv_corr_id.
  ENDMETHOD.


  METHOD save.
    DATA lt_handles TYPE bal_t_logh.

    GET TIME STAMP FIELD ms_row-end_ts.
    IF ms_row-msg_json IS INITIAL AND mt_msg IS NOT INITIAL.
      ms_row-msg_json = messages_json( mt_msg ).
    ENDIF.
    MODIFY zalm_if_log FROM ms_row.

    IF mv_bal_ok = abap_true.
      APPEND mv_bal_handle TO lt_handles.
      CALL FUNCTION 'BAL_DB_SAVE'
        EXPORTING
          i_t_log_handle = lt_handles
        EXCEPTIONS
          OTHERS         = 1.
      IF sy-subrc <> 0.
        mv_bal_ok = abap_false.
      ENDIF.
    ENDIF.

    IF iv_commit = abap_true.
      COMMIT WORK.
    ENDIF.
  ENDMETHOD.


  METHOD error_count.
    LOOP AT mt_msg TRANSPORTING NO FIELDS WHERE type = 'E' OR type = 'A'.
      rv_count = rv_count + 1.
    ENDLOOP.
  ENDMETHOD.


  METHOD find_posting.
    DATA lv_id TYPE zalm_if_log-posting_id.
    lv_id = iv_posting_id.
    SELECT * FROM zalm_if_log INTO TABLE @DATA(lt_rows)
      WHERE posting_id = @lv_id
      ORDER BY start_ts DESCENDING.
    READ TABLE lt_rows INTO rs_row INDEX 1.
  ENDMETHOD.


  METHOD messages_json.
    rv_json = /ui2/cl_json=>serialize( data = it_msg pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
  ENDMETHOD.

ENDCLASS.

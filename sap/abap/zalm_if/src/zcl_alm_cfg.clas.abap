"! ALM 인터페이스 설정(ZALM_CFG)과 값 매핑(ZALM_MAP). 08 명세서 7장
"! - 한 값: PARAM + LOW = 공백 (예: POST_BLOCK, RETRY_WAIT_SEC)
"! - 여러 값: PARAM + LOW = 값 (예: BUKRS 1000, BUKRS 2000)
"! - 마지막 성공 시각(LAST_AA01 등): VAL에 UTC 타임스탬프(YYYYMMDDhhmmss)
"! 쓰기(set*)는 COMMIT하지 않는다. 호출한 프로그램이 업무 LUW와 함께 커밋한다
CLASS zcl_alm_cfg DEFINITION
  PUBLIC
  FINAL
  CREATE PRIVATE.

  PUBLIC SECTION.
    TYPES tt_value TYPE STANDARD TABLE OF string WITH EMPTY KEY.

    CONSTANTS:
      c_bukrs          TYPE zalm_cfg-param VALUE 'BUKRS',
      c_kokrs          TYPE zalm_cfg-param VALUE 'KOKRS',
      c_post_block     TYPE zalm_cfg-param VALUE 'POST_BLOCK',
      c_retry_wait_sec TYPE zalm_cfg-param VALUE 'RETRY_WAIT_SEC',
      c_mail_dl        TYPE zalm_cfg-param VALUE 'MAIL_DL'.

    "! 한 값(LOW 공백) 또는 PARAM·LOW의 값. 없으면 iv_default
    CLASS-METHODS get
      IMPORTING
        iv_param        TYPE csequence
        iv_low          TYPE csequence OPTIONAL
        iv_default      TYPE csequence OPTIONAL
      RETURNING
        VALUE(rv_value) TYPE string.

    "! 정수 값(재시도 대기 초 등). 숫자가 아니면 iv_default
    CLASS-METHODS get_int
      IMPORTING
        iv_param        TYPE csequence
        iv_default      TYPE i
      RETURNING
        VALUE(rv_value) TYPE i.

    "! 여러 값(LOW 목록). 예: 대상 회사코드
    CLASS-METHODS get_list
      IMPORTING
        iv_param         TYPE csequence
      RETURNING
        VALUE(rt_values) TYPE tt_value.

    CLASS-METHODS is_set
      IMPORTING
        iv_param      TYPE csequence
      RETURNING
        VALUE(rv_set) TYPE abap_bool.

    CLASS-METHODS set
      IMPORTING
        iv_param TYPE csequence
        iv_low   TYPE csequence OPTIONAL
        iv_value TYPE csequence
        iv_descr TYPE csequence OPTIONAL.

    CLASS-METHODS delete
      IMPORTING
        iv_param TYPE csequence
        iv_low   TYPE csequence OPTIONAL.

    "! 마지막 성공 시각(UTC). 없으면 0(최초 실행)
    CLASS-METHODS get_timestamp
      IMPORTING
        iv_param     TYPE csequence
      RETURNING
        VALUE(rv_ts) TYPE timestamp.

    CLASS-METHODS set_timestamp
      IMPORTING
        iv_param TYPE csequence
        iv_ts    TYPE timestamp.

    "! 델타 선택 시작점: (마지막 성공 − 겹침 분)을 시스템 시간대 날짜·시각으로.
    "! 직전 성공 시각과 지금의 UTC 오프셋이 다르면(서머타임 해제 등) 1시간 더 앞당긴다(08 7장 ZALM_CFG)
    CLASS-METHODS delta_from
      IMPORTING
        iv_param       TYPE csequence
        iv_overlap_min TYPE i DEFAULT 10
      EXPORTING
        ev_date        TYPE d
        ev_time        TYPE t
        ev_initial     TYPE abap_bool.

    "! 값 매핑(ZALM_MAP). 예: map( iv_type = 'RETIRE_TT' iv_alm = 'SCRAP' ) → 거래유형
    CLASS-METHODS map
      IMPORTING
        iv_type         TYPE csequence
        iv_alm          TYPE csequence
      RETURNING
        VALUE(rv_value) TYPE string.

    CLASS-METHODS set_map
      IMPORTING
        iv_type  TYPE csequence
        iv_alm   TYPE csequence
        iv_sap   TYPE csequence
        iv_descr TYPE csequence OPTIONAL.

    "! 현재 UTC 타임스탬프
    CLASS-METHODS now
      RETURNING
        VALUE(rv_ts) TYPE timestamp.

    "! 시스템 시간대(TTZCU-TZONESYS, 없으면 sy-zonlo)
    CLASS-METHODS system_tz
      RETURNING
        VALUE(rv_tz) TYPE timezone.
ENDCLASS.



CLASS zcl_alm_cfg IMPLEMENTATION.

  METHOD get.
    DATA lv_param TYPE zalm_cfg-param.
    DATA lv_low TYPE zalm_cfg-low.
    lv_param = iv_param.
    lv_low = iv_low.
    SELECT SINGLE val FROM zalm_cfg INTO @DATA(lv_val)
      WHERE param = @lv_param AND low = @lv_low.
    IF sy-subrc = 0 AND lv_val IS NOT INITIAL.
      rv_value = condense( lv_val ).
    ELSE.
      rv_value = iv_default.
    ENDIF.
  ENDMETHOD.


  METHOD get_int.
    DATA(lv_text) = get( iv_param = iv_param ).
    IF lv_text IS NOT INITIAL AND lv_text CO '0123456789'.
      rv_value = lv_text.
    ELSE.
      rv_value = iv_default.
    ENDIF.
  ENDMETHOD.


  METHOD get_list.
    " 한 열만 읽을 때 INTO TABLE @DATA( )는 릴리스에 따라 구조(LOW 필드) 행이 되므로 행 유형을 명시한다
    DATA lv_param TYPE zalm_cfg-param.
    DATA lt_low TYPE STANDARD TABLE OF zalm_cfg-low WITH EMPTY KEY.
    lv_param = iv_param.
    SELECT low FROM zalm_cfg INTO TABLE @lt_low
      WHERE param = @lv_param AND low <> @space
      ORDER BY low.
    LOOP AT lt_low INTO DATA(lv_low).
      APPEND condense( lv_low ) TO rt_values.
    ENDLOOP.
  ENDMETHOD.


  METHOD is_set.
    DATA(lv_val) = get( iv_param = iv_param ).
    rv_set = xsdbool( lv_val = 'X' OR lv_val = 'x' ).
  ENDMETHOD.


  METHOD set.
    DATA ls_row TYPE zalm_cfg.
    ls_row-param = iv_param.
    ls_row-low = iv_low.
    ls_row-val = iv_value.
    IF iv_descr IS SUPPLIED.
      ls_row-descr = iv_descr.
    ELSE.
      SELECT SINGLE descr FROM zalm_cfg INTO @ls_row-descr
        WHERE param = @ls_row-param AND low = @ls_row-low.
    ENDIF.
    ls_row-changed_by = sy-uname.
    ls_row-changed_at = now( ).
    MODIFY zalm_cfg FROM ls_row.
  ENDMETHOD.


  METHOD delete.
    DATA lv_param TYPE zalm_cfg-param.
    DATA lv_low TYPE zalm_cfg-low.
    lv_param = iv_param.
    lv_low = iv_low.
    DELETE FROM zalm_cfg WHERE param = lv_param AND low = lv_low.
  ENDMETHOD.


  METHOD get_timestamp.
    DATA(lv_val) = get( iv_param = iv_param ).
    IF strlen( lv_val ) = 14 AND lv_val CO '0123456789'.
      rv_ts = lv_val.
    ENDIF.
  ENDMETHOD.


  METHOD set_timestamp.
    DATA lv_text TYPE c LENGTH 14.
    lv_text = iv_ts.
    set( iv_param = iv_param iv_value = lv_text ).
  ENDMETHOD.


  METHOD delta_from.
    DATA lv_from TYPE timestamp.
    DATA lv_tz TYPE timezone.
    DATA lv_d_now TYPE d.
    DATA lv_t_now TYPE t.
    DATA lv_d_last TYPE d.
    DATA lv_t_last TYPE t.
    DATA lv_utc_d TYPE d.
    DATA lv_utc_t TYPE t.
    DATA lv_off_last TYPE i.
    DATA lv_off_now TYPE i.

    CLEAR: ev_date, ev_time.
    DATA(lv_last) = get_timestamp( iv_param ).
    IF lv_last IS INITIAL.
      ev_initial = abap_true.
      RETURN.
    ENDIF.
    ev_initial = abap_false.
    lv_tz = system_tz( ).
    lv_from = cl_abap_tstmp=>subtractsecs( tstmp = lv_last secs = iv_overlap_min * 60 ).

    " 서머타임: 직전 성공 시각과 지금의 UTC 오프셋 비교
    CONVERT TIME STAMP lv_last TIME ZONE lv_tz INTO DATE lv_d_last TIME lv_t_last.
    CONVERT TIME STAMP lv_last TIME ZONE 'UTC' INTO DATE lv_utc_d TIME lv_utc_t.
    lv_off_last = ( lv_d_last - lv_utc_d ) * 86400 + ( lv_t_last - lv_utc_t ).
    DATA(lv_now) = now( ).
    CONVERT TIME STAMP lv_now TIME ZONE lv_tz INTO DATE lv_d_now TIME lv_t_now.
    CONVERT TIME STAMP lv_now TIME ZONE 'UTC' INTO DATE lv_utc_d TIME lv_utc_t.
    lv_off_now = ( lv_d_now - lv_utc_d ) * 86400 + ( lv_t_now - lv_utc_t ).
    IF lv_off_last <> lv_off_now.
      lv_from = cl_abap_tstmp=>subtractsecs( tstmp = lv_from secs = 3600 ).
    ENDIF.

    CONVERT TIME STAMP lv_from TIME ZONE lv_tz INTO DATE ev_date TIME ev_time.
  ENDMETHOD.


  METHOD map.
    DATA lv_type TYPE zalm_map-map_type.
    DATA lv_alm TYPE zalm_map-alm_value.
    lv_type = iv_type.
    lv_alm = iv_alm.
    SELECT SINGLE sap_value FROM zalm_map INTO @DATA(lv_sap)
      WHERE map_type = @lv_type AND alm_value = @lv_alm.
    IF sy-subrc = 0.
      rv_value = condense( lv_sap ).
    ENDIF.
  ENDMETHOD.


  METHOD set_map.
    DATA ls_row TYPE zalm_map.
    ls_row-map_type = iv_type.
    ls_row-alm_value = iv_alm.
    ls_row-sap_value = iv_sap.
    ls_row-descr = iv_descr.
    MODIFY zalm_map FROM ls_row.
  ENDMETHOD.


  METHOD now.
    GET TIME STAMP FIELD rv_ts.
  ENDMETHOD.


  METHOD system_tz.
    SELECT SINGLE tzonesys FROM ttzcu INTO @rv_tz.
    IF rv_tz IS INITIAL.
      rv_tz = sy-zonlo.
    ENDIF.
  ENDMETHOD.

ENDCLASS.

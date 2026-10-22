*&---------------------------------------------------------------------*
*& ZALM_IF_CONFIG - ALM 인터페이스 설정(ZALM_CFG)·값 매핑(ZALM_MAP) 조회·변경(WBS 7.3)
*&   보기: 전체 목록. 저장·삭제: 한 행. 기본값: 처음 설치할 때 한 번(이미 있는 값은 그대로)
*&   ZALM_CFG 주요 PARAM(08 7장)
*&     BUKRS(여러 행, LOW = 회사코드) · KOKRS · POST_BLOCK(X = 전기 중지) · RETRY_WAIT_SEC(첫 재시도 대기 초, 기본 60)
*&     LAST_AA01·LAST_MM01·LAST_MM03(마지막 성공 UTC 타임스탬프 - 잡이 쓴다) · PO_DOC_TYPE·PO_PLANT·PO_MATL_GROUP·PO_UNIT · MAIL_DL
*&   ZALM_MAP: RETIRE_TT(SCRAP·SALE·LOSS → 거래유형), TRANSFER_TT
*&---------------------------------------------------------------------*
REPORT zalm_if_config.

PARAMETERS: rb_show RADIOBUTTON GROUP act DEFAULT 'X',
            rb_save RADIOBUTTON GROUP act,
            rb_del  RADIOBUTTON GROUP act,
            rb_init RADIOBUTTON GROUP act.
SELECTION-SCREEN SKIP.
PARAMETERS: rb_cfg RADIOBUTTON GROUP tab DEFAULT 'X',
            rb_map RADIOBUTTON GROUP tab.
SELECTION-SCREEN SKIP.
PARAMETERS: p_key1  TYPE char20,
            p_key2  TYPE char40 LOWER CASE,
            p_val   TYPE char255 LOWER CASE,
            p_descr TYPE char60 LOWER CASE.

START-OF-SELECTION.
  CASE abap_true.
    WHEN rb_init.
      PERFORM defaults.
    WHEN rb_save.
      IF p_key1 IS INITIAL.
        MESSAGE 'PARAM(또는 매핑 유형)을 넣으세요' TYPE 'E'.
      ENDIF.
      IF rb_cfg = abap_true.
        zcl_alm_cfg=>set( iv_param = to_upper( p_key1 ) iv_low = p_key2 iv_value = p_val iv_descr = p_descr ).
      ELSE.
        zcl_alm_cfg=>set_map( iv_type = to_upper( p_key1 ) iv_alm = to_upper( p_key2 ) iv_sap = p_val iv_descr = p_descr ).
      ENDIF.
      COMMIT WORK.
      WRITE / |저장: { p_key1 } / { p_key2 } = { p_val }|.
    WHEN rb_del.
      IF rb_cfg = abap_true.
        zcl_alm_cfg=>delete( iv_param = to_upper( p_key1 ) iv_low = p_key2 ).
      ELSE.
        DATA lv_type TYPE zalm_map-map_type.
        DATA lv_alm TYPE zalm_map-alm_value.
        lv_type = to_upper( p_key1 ).
        lv_alm = to_upper( p_key2 ).
        DELETE FROM zalm_map WHERE map_type = lv_type AND alm_value = lv_alm.
      ENDIF.
      COMMIT WORK.
      WRITE / |삭제: { p_key1 } / { p_key2 }|.
  ENDCASE.
  PERFORM show.

FORM show.
  SKIP.
  WRITE / 'ZALM_CFG' COLOR COL_HEADING.
  SELECT * FROM zalm_cfg INTO TABLE @DATA(lt_cfg) ORDER BY param, low.
  LOOP AT lt_cfg INTO DATA(ls_cfg).
    WRITE: / ls_cfg-param, ls_cfg-low(20), ls_cfg-val(60), ls_cfg-descr(40).
  ENDLOOP.
  SKIP.
  WRITE / 'ZALM_MAP' COLOR COL_HEADING.
  SELECT * FROM zalm_map INTO TABLE @DATA(lt_map) ORDER BY map_type, alm_value.
  LOOP AT lt_map INTO DATA(ls_map).
    WRITE: / ls_map-map_type, ls_map-alm_value(20), ls_map-sap_value(20), ls_map-descr(40).
  ENDLOOP.
ENDFORM.

" 기본값: 없을 때만 넣는다. 거래유형은 DEV에서 확인한 값(폐기 200)만 - 매각·이관은 D-04 확정 후 넣는다
FORM defaults.
  PERFORM default_cfg USING 'BUKRS' '1000' 'X' 'Target company code'.
  PERFORM default_cfg USING 'RETRY_WAIT_SEC' '' '60' 'First retry wait (seconds), doubles each retry'.
  PERFORM default_cfg USING 'POST_BLOCK' '' '' 'X = skip postings (month-end close)'.
  PERFORM default_cfg USING 'PO_DOC_TYPE' '' 'NB' 'PO document type for IF-MM-02'.
  SELECT SINGLE @abap_true FROM zalm_map INTO @DATA(lv_has) WHERE map_type = 'RETIRE_TT' AND alm_value = 'SCRAP'.
  IF lv_has = abap_false.
    zcl_alm_cfg=>set_map( iv_type = 'RETIRE_TT' iv_alm = 'SCRAP' iv_sap = '200' iv_descr = 'Scrapping (verified in DEV)' ).
  ENDIF.
  COMMIT WORK.
  WRITE / '기본값을 넣었습니다(이미 있던 값은 그대로).'.
ENDFORM.

FORM default_cfg USING iv_param TYPE csequence iv_low TYPE csequence iv_val TYPE csequence iv_descr TYPE csequence.
  DATA lv_param TYPE zalm_cfg-param.
  DATA lv_low TYPE zalm_cfg-low.
  lv_param = iv_param.
  lv_low = iv_low.
  SELECT SINGLE @abap_true FROM zalm_cfg INTO @DATA(lv_has) WHERE param = @lv_param AND low = @lv_low.
  IF lv_has = abap_false.
    zcl_alm_cfg=>set( iv_param = iv_param iv_low = iv_low iv_value = iv_val iv_descr = iv_descr ).
  ENDIF.
ENDFORM.

*&---------------------------------------------------------------------*
*& ZALM_IF_PING - ALM 연결 시험(08 10장 T01·T02, WBS 7.3)
*&   ① 토큰: SM59 ZALM_TOKEN(기본 인증 = ALM 연결 별칭·비밀) → POST /oauth/token
*&   ② GET /sap/ping(Bearer, X-SAP-System = <SID>-<클라이언트>, X-Company-Code)
*&   결과를 ZALM_IF_LOG(IF_ID = PING)·SLG1(객체 ZALM)에 남긴다.
*&   P_MANUAL: SM59 ZALM_TOKEN을 아직 만들지 않았을 때만 - clientId·비밀을 화면에 넣어 시험(운영 금지)
*&---------------------------------------------------------------------*
REPORT zalm_if_ping.

PARAMETERS: p_bukrs  TYPE bukrs OBLIGATORY,
            p_api    TYPE rfcdest DEFAULT 'ZALM_API' OBLIGATORY,
            p_tok    TYPE rfcdest DEFAULT 'ZALM_TOKEN' OBLIGATORY,
            p_twice  AS CHECKBOX DEFAULT 'X'.
SELECTION-SCREEN SKIP.
PARAMETERS: p_manual AS CHECKBOX DEFAULT ' ' USER-COMMAND man,
            p_cid    TYPE char64 LOWER CASE MODIF ID man,
            p_sec    TYPE char128 LOWER CASE MODIF ID man.

INITIALIZATION.
  DATA(gt_bukrs) = zcl_alm_cfg=>get_list( zcl_alm_cfg=>c_bukrs ).
  READ TABLE gt_bukrs INTO DATA(gv_bukrs) INDEX 1.
  IF sy-subrc = 0.
    p_bukrs = gv_bukrs.
  ELSE.
    p_bukrs = '1000'.
  ENDIF.

AT SELECTION-SCREEN OUTPUT.
  LOOP AT SCREEN.
    IF screen-group1 = 'MAN'.
      screen-active = COND #( WHEN p_manual = abap_true THEN '1' ELSE '0' ).
      IF screen-name CS 'P_SEC'.
        screen-invisible = '1'.   " 비밀은 화면에 보이지 않게
      ENDIF.
      MODIFY SCREEN.
    ENDIF.
  ENDLOOP.

START-OF-SELECTION.
  DATA(go_log) = NEW zcl_alm_log( iv_if_id = 'PING' iv_batch_id = |PING-{ sy-datum }-{ sy-uzeit }| iv_bukrs = p_bukrs ).
  DATA(go_api) = NEW zcl_alm_http_client( iv_bukrs = p_bukrs iv_dest_api = p_api iv_dest_token = p_tok iv_retry_wait = 0 iv_max_retry = 0 ).
  IF p_manual = abap_true.
    IF p_cid IS INITIAL OR p_sec IS INITIAL.
      MESSAGE 'P_MANUAL: clientId와 비밀을 넣으세요' TYPE 'E'.
    ENDIF.
    go_api->set_credentials( iv_client_id = p_cid iv_secret = p_sec ).
    go_log->add( iv_type = 'W' iv_text = '시험 모드: 화면에 넣은 clientId·비밀로 토큰 요청(운영은 SM59 ZALM_TOKEN)' ).
  ENDIF.

  go_log->add( |SAP 시스템 { go_api->system_id( ) }, 회사코드 { p_bukrs }, ZALM_API = { p_api }, ZALM_TOKEN = { p_tok }| ).
  TRY.
      DATA(gv_token) = go_api->token( ).
      go_log->add( iv_type = 'S' iv_text = |① 토큰 발급 성공({ strlen( gv_token ) }자)| ).

      DATA(gs_ping) = go_api->get( '/sap/ping' ).
      go_log->set_corr_id( gs_ping-corr_id ).
      IF gs_ping-status = 200.
        go_log->add( iv_type = 'S' iv_text = |② GET /sap/ping HTTP 200: { gs_ping-body }| ).
      ELSE.
        DATA(gs_problem) = zcl_alm_http_client=>parse_problem( gs_ping-body ).
        go_log->add( iv_type = 'E' iv_text = |② GET /sap/ping HTTP { gs_ping-status } { gs_problem-code }: {
                                              COND string( WHEN gs_problem-detail IS NOT INITIAL THEN gs_problem-detail ELSE gs_ping-body ) }| ).
      ENDIF.

      " 두 번째 호출은 저장된 토큰을 다시 쓰는지 확인(토큰 요청 없이)
      IF p_twice = abap_true AND gs_ping-status = 200.
        DATA(gs_ping2) = go_api->get( '/sap/ping' ).
        go_log->add( iv_type = COND #( WHEN gs_ping2-status = 200 THEN 'S' ELSE 'E' )
                     iv_text = |③ 다시 호출(저장된 토큰) HTTP { gs_ping2-status }| ).
      ENDIF.
      go_log->set_result( iv_status = COND #( WHEN gs_ping-status = 200 THEN zcl_alm_log=>c_success ELSE zcl_alm_log=>c_failed )
                          iv_http = gs_ping-status iv_rec_cnt = 0 iv_err_cnt = go_log->error_count( ) ).
    CATCH zcx_alm INTO DATA(gx).
      go_log->add( iv_type = 'E' iv_text = gx->get_text( ) ).
      go_log->set_result( iv_status = zcl_alm_log=>c_failed iv_http = gx->mv_http_status iv_err_cnt = 1 ).
  ENDTRY.
  go_log->save( iv_commit = abap_true ).
  WRITE: / |로그: SE16 ZALM_IF_LOG, SLG1 객체 ZALM(하위 객체 PING)|.

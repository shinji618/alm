*&---------------------------------------------------------------------*
*& ZALM_IF_MONITOR - ALM 인터페이스 운영 모니터(WBS 7.9, 08 8장)
*&   읽기 전용. SM37·SLG1을 열기 전에 먼저 보는 한 장짜리 현황
*&   1. IF별 현황: 마지막 성공 시각, 최근 P_DAYS일 성공·부분·실패 건수, 지연 경고
*&      지연 기준: IF-MD-01·AA-01·AA-02 25시간, IF-RC-01 8일, IF-OP-01(15분 잡 심장박동) P_STALE분. 전기 IF(AA-03~07)는 건이 있을 때만 로그가 생겨 지연을 보지 않는다
*&   2. 최근 실패·부분 실패 목록(ZALM_IF_LOG, 최대 100건)
*&   3. ZALM 잡 상태(TBTCO): 최근 P_DAYS일 실행 이력(취소 A는 빨강), 필수 잡 5개(ZALM_POSTING_15M, ZALM_MD01_DAILY, ZALM_AA01_DAILY, ZALM_AA02_DAILY, ZALM_RECON_WEEKLY)가 예약돼 있는지
*&   시각은 로그온 사용자의 시간대(SY-ZONLO)로 보여 준다
*&---------------------------------------------------------------------*
REPORT zalm_if_monitor.

PARAMETERS: p_days  TYPE i DEFAULT 1 OBLIGATORY,
            p_stale TYPE i DEFAULT 60 OBLIGATORY.

TYPES:
  BEGIN OF gty_if,
    if_id   TYPE zalm_if_log-if_id,
    max_min TYPE i,
    last_ok TYPE timestampl,
    n_ok    TYPE i,
    n_part  TYPE i,
    n_fail  TYPE i,
  END OF gty_if,
  gtt_if TYPE SORTED TABLE OF gty_if WITH UNIQUE KEY if_id.

DATA gt_if TYPE gtt_if.
DATA gv_from TYPE timestampl.
DATA gv_now TYPE timestampl.


FORM ts_text USING iv_ts TYPE timestampl CHANGING cv_text TYPE string.
  DATA lv_d TYPE d.
  DATA lv_t TYPE t.
  IF iv_ts IS INITIAL.
    cv_text = '-'.
    RETURN.
  ENDIF.
  CONVERT TIME STAMP iv_ts TIME ZONE sy-zonlo INTO DATE lv_d TIME lv_t.
  cv_text = |{ lv_d DATE = ISO } { lv_t TIME = ISO }|.
ENDFORM.

START-OF-SELECTION.
  GET TIME STAMP FIELD gv_now.
  gv_from = cl_abap_tstmp=>subtractsecs( tstmp = gv_now secs = p_days * 86400 ).

  gt_if = VALUE #( ( if_id = 'IF-OP-01' max_min = p_stale )
                   ( if_id = 'IF-MD-01' max_min = 1500 )
                   ( if_id = 'IF-AA-01' max_min = 1500 )
                   ( if_id = 'IF-AA-02' max_min = 1500 )
                   ( if_id = 'IF-RC-01' max_min = 11520 ) ).

  "---------------- 1. IF별 현황 ----------------
  SELECT if_id, MAX( start_ts ) AS last_ts FROM zalm_if_log
    WHERE status = @zcl_alm_log=>c_success GROUP BY if_id INTO TABLE @DATA(lt_last).
  SELECT if_id, status, COUNT(*) AS cnt FROM zalm_if_log
    WHERE start_ts >= @gv_from GROUP BY if_id, status INTO TABLE @DATA(lt_cnt).

  LOOP AT lt_last INTO DATA(ls_last).
    READ TABLE gt_if ASSIGNING FIELD-SYMBOL(<if>) WITH TABLE KEY if_id = ls_last-if_id.
    IF sy-subrc <> 0.
      INSERT VALUE #( if_id = ls_last-if_id ) INTO TABLE gt_if ASSIGNING <if>.
    ENDIF.
    <if>-last_ok = ls_last-last_ts.
  ENDLOOP.
  LOOP AT lt_cnt INTO DATA(ls_cnt).
    READ TABLE gt_if ASSIGNING <if> WITH TABLE KEY if_id = ls_cnt-if_id.
    IF sy-subrc <> 0.
      INSERT VALUE #( if_id = ls_cnt-if_id ) INTO TABLE gt_if ASSIGNING <if>.
    ENDIF.
    CASE ls_cnt-status.
      WHEN zcl_alm_log=>c_success. <if>-n_ok = ls_cnt-cnt.
      WHEN zcl_alm_log=>c_partial. <if>-n_part = ls_cnt-cnt.
      WHEN zcl_alm_log=>c_failed.  <if>-n_fail = ls_cnt-cnt.
    ENDCASE.
  ENDLOOP.

  WRITE: / '■ 1. 인터페이스 현황', 40 |(최근 { p_days }일, 기준 시각 { sy-datum DATE = ISO } { sy-uzeit TIME = ISO })|.
  ULINE.
  WRITE: / 'IF', 14 '마지막 성공', 36 '성공', 46 '부분', 56 '실패', 66 '판정'.
  ULINE.
  LOOP AT gt_if INTO DATA(ls_if).
    DATA lv_txt TYPE string.
    PERFORM ts_text USING ls_if-last_ok CHANGING lv_txt.
    DATA(lv_verdict) = ``.
    DATA(lv_bad) = abap_false.
    IF ls_if-max_min > 0.
      IF ls_if-last_ok IS INITIAL.
        lv_verdict = '성공 이력 없음'.
        lv_bad = abap_true.
      ELSEIF cl_abap_tstmp=>subtract( tstmp1 = gv_now tstmp2 = ls_if-last_ok ) > ls_if-max_min * 60.
        lv_verdict = |지연(마지막 성공 후 { ls_if-max_min }분 초과)|.
        lv_bad = abap_true.
      ENDIF.
    ENDIF.
    IF ls_if-n_fail > 0.
      lv_verdict = |{ lv_verdict } 실패 { ls_if-n_fail }건|.
      lv_bad = abap_true.
    ENDIF.
    IF lv_verdict IS INITIAL.
      lv_verdict = '정상'.
    ENDIF.
    WRITE: / ls_if-if_id, 14 lv_txt, 36 ls_if-n_ok, 46 ls_if-n_part, 56 ls_if-n_fail.
    IF lv_bad = abap_true.
      WRITE: 66 lv_verdict COLOR COL_NEGATIVE.
    ELSE.
      WRITE: 66 lv_verdict COLOR COL_POSITIVE.
    ENDIF.
  ENDLOOP.

  "---------------- 2. 최근 실패·부분 실패 ----------------
  SELECT if_id, batch_id, posting_id, bukrs, status, http_status, rec_cnt, err_cnt, start_ts
    FROM zalm_if_log
    WHERE start_ts >= @gv_from AND status IN ( @zcl_alm_log=>c_failed, @zcl_alm_log=>c_partial )
    ORDER BY start_ts DESCENDING
    INTO TABLE @DATA(lt_fail) UP TO 100 ROWS.
  SKIP.
  WRITE: / '■ 2. 최근 실패·부분 실패', 40 |({ lines( lt_fail ) }건, 최대 100건)|.
  ULINE.
  IF lt_fail IS INITIAL.
    WRITE: / '없음' COLOR COL_POSITIVE.
  ELSE.
    WRITE: / '시각', 22 'IF', 32 '상태', 42 'HTTP', 49 '건수/오류', 62 '회사', 68 '배치 / 전기 ID'.
    LOOP AT lt_fail INTO DATA(ls_fail).
      PERFORM ts_text USING ls_fail-start_ts CHANGING lv_txt.
      WRITE: / lv_txt, 22 ls_fail-if_id, 32 ls_fail-status, 42 ls_fail-http_status,
               49 |{ ls_fail-rec_cnt }/{ ls_fail-err_cnt }|, 62 ls_fail-bukrs,
               68 COND string( WHEN ls_fail-posting_id IS NOT INITIAL THEN |{ ls_fail-posting_id }| ELSE |{ ls_fail-batch_id }| ).
    ENDLOOP.
    WRITE: / '상세: SLG1(객체 ZALM) 또는 SE16 ZALM_IF_LOG'.
  ENDIF.

  "---------------- 3. 잡 상태 ----------------
  DATA(lv_dfrom) = CONV d( sy-datum - p_days ).
  SELECT jobname, jobcount, status, strtdate, strttime, enddate, endtime, periodic
    FROM tbtco
    WHERE jobname LIKE 'ZALM%' AND ( strtdate >= @lv_dfrom OR status IN ( 'R', 'A' ) )
    ORDER BY strtdate DESCENDING, strttime DESCENDING
    INTO TABLE @DATA(lt_job) UP TO 200 ROWS.
  SKIP.
  WRITE: / '■ 3. ZALM 잡 상태', 40 |({ lines( lt_job ) }건, 최대 200건)|.
  ULINE.
  WRITE: / '잡 이름', 36 '시작', 58 '종료', 80 '상태'.
  LOOP AT lt_job INTO DATA(ls_job).
    DATA(lv_st) = SWITCH string( ls_job-status
                    WHEN 'F' THEN '완료' WHEN 'A' THEN '취소(오류)' WHEN 'R' THEN '실행 중' WHEN 'S' THEN '릴리스(대기)'
                    WHEN 'P' THEN '예약' WHEN 'Y' THEN '준비' ELSE ls_job-status ).
    WRITE: / ls_job-jobname, 36 |{ ls_job-strtdate DATE = ISO } { ls_job-strttime TIME = ISO }|,
             58 |{ ls_job-enddate DATE = ISO } { ls_job-endtime TIME = ISO }|.
    IF ls_job-status = 'A'.
      WRITE: 80 lv_st COLOR COL_NEGATIVE.
    ELSE.
      WRITE: 80 lv_st.
    ENDIF.
  ENDLOOP.
  IF lt_job IS INITIAL.
    WRITE: / '해당 기간 실행 이력 없음'.
  ENDIF.

  SKIP.
  WRITE: / '필수 잡 예약 확인(릴리스·예약·준비·실행 중 상태)'.
  LOOP AT VALUE string_table( ( `ZALM_POSTING_15M` ) ( `ZALM_MD01_DAILY` ) ( `ZALM_AA01_DAILY` ) ( `ZALM_AA02_DAILY` ) ( `ZALM_RECON_WEEKLY` ) ) INTO DATA(lv_name).
    DATA(lv_jn) = CONV tbtco-jobname( lv_name ).
    SELECT SINGLE jobname FROM tbtco WHERE jobname = @lv_jn AND status IN ( 'S', 'P', 'Y', 'R' ) INTO @DATA(lv_found).
    IF sy-subrc = 0.
      WRITE: / lv_name, 36 '예약됨' COLOR COL_POSITIVE.
    ELSE.
      WRITE: / lv_name, 36 '예약 없음 → SM36에서 등록(런북 참고)' COLOR COL_NEGATIVE.
    ENDIF.
  ENDLOOP.

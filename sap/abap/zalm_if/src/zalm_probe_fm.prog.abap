*&---------------------------------------------------------------------*
*& ZALM_PROBE_FM  이관 전기(IF-AA-05) BAPI 후보 조사용 (읽기 전용, 데이터 변경 없음)
*& 사용: SE38에서 새 프로그램으로 만들고 실행. 결과(목록)를 복사해서 보내 주세요.
*&---------------------------------------------------------------------*
REPORT zalm_probe_fm.

PARAMETERS p_like1 TYPE c LENGTH 30 DEFAULT 'BAPI_ASSET%'.
PARAMETERS p_like2 TYPE c LENGTH 30 DEFAULT '%ASSET%TRANSF%'.
PARAMETERS p_like3 TYPE c LENGTH 30 DEFAULT 'BAPI_FIXEDASSET%'.

START-OF-SELECTION.
  DATA lt_fm TYPE SORTED TABLE OF tfdir-funcname WITH UNIQUE KEY table_line.

  SELECT funcname FROM tfdir
    WHERE funcname LIKE @p_like1 OR funcname LIKE @p_like2 OR funcname LIKE @p_like3
    INTO TABLE @DATA(lt_found).
  LOOP AT lt_found INTO DATA(ls_f).
    INSERT ls_f-funcname INTO TABLE lt_fm.
  ENDLOOP.

  WRITE: / '=== 후보 함수 ===', lines( lt_fm ).
  LOOP AT lt_fm INTO DATA(lv_fm).
    DATA(lv_txt) = ||.
    SELECT SINGLE stext FROM tftit WHERE funcname = @lv_fm AND spras = @sy-langu INTO @lv_txt.
    IF sy-subrc <> 0.
      SELECT SINGLE stext FROM tftit WHERE funcname = @lv_fm AND spras = 'E' INTO @lv_txt.
    ENDIF.
    WRITE: / lv_fm, lv_txt.
  ENDLOOP.

  " 이관 가능성이 높은 이름의 인터페이스(FUPARAREF)를 함께 보여 준다
  SKIP.
  WRITE: / '=== 인터페이스(이름에 TRANSF가 들어간 함수) ==='.
  LOOP AT lt_fm INTO lv_fm WHERE table_line CS 'TRANSF'.
    WRITE: / '--', lv_fm.
    SELECT parameter, paramtype, structure FROM fupararef
      WHERE funcname = @lv_fm AND r3state = 'A'
      INTO TABLE @DATA(lt_par).
    LOOP AT lt_par INTO DATA(ls_p).
      WRITE: / '   ', ls_p-parameter, ls_p-paramtype, ls_p-structure.
    ENDLOOP.
  ENDLOOP.

  " 이관 거래유형(300번대)과 회사코드 1000의 문서 분할 사용 여부
  SKIP.
  WRITE: / '=== 거래유형 300번대(이관) ==='.
  SELECT bwasl, txt50 FROM tabwt
    WHERE spras = 'E' AND bwasl LIKE '3%'
    INTO TABLE @DATA(lt_tt).
  LOOP AT lt_tt INTO DATA(ls_tt).
    WRITE: / ls_tt-bwasl, ls_tt-txt50.
  ENDLOOP.

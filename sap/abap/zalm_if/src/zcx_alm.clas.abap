"! ALM 인터페이스 예외(통신·인증·설정 오류). 메시지는 mv_text, HTTP 상태는 mv_http_status
CLASS zcx_alm DEFINITION
  PUBLIC
  INHERITING FROM cx_static_check
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    DATA mv_text TYPE string READ-ONLY.
    DATA mv_http_status TYPE i READ-ONLY.

    METHODS constructor
      IMPORTING
        textid         LIKE textid OPTIONAL
        previous       LIKE previous OPTIONAL
        iv_text        TYPE string OPTIONAL
        iv_http_status TYPE i OPTIONAL.

    METHODS get_text REDEFINITION.

    "! 예외를 만들어 던진다(짧게 쓰기용)
    CLASS-METHODS raise
      IMPORTING
        iv_text        TYPE csequence
        iv_http_status TYPE i OPTIONAL
      RAISING
        zcx_alm.
ENDCLASS.



CLASS zcx_alm IMPLEMENTATION.

  METHOD constructor ##ADT_SUPPRESS_GENERATION.
    super->constructor( textid = textid previous = previous ).
    mv_text = iv_text.
    mv_http_status = iv_http_status.
  ENDMETHOD.


  METHOD get_text.
    IF mv_text IS NOT INITIAL.
      result = mv_text.
    ELSE.
      result = super->get_text( ).
    ENDIF.
  ENDMETHOD.


  METHOD raise.
    DATA lv_text TYPE string.
    lv_text = iv_text.
    RAISE EXCEPTION TYPE zcx_alm
      EXPORTING
        iv_text        = lv_text
        iv_http_status = iv_http_status.
  ENDMETHOD.

ENDCLASS.

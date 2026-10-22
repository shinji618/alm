"""ZALM_IF DDIC(abapGit XML) 생성기. 표 정의를 여기서 고치고 다시 실행한다: python3 gen_ddic.py
   - 데이터 요소(ROLLNAME)가 있으면 표준 데이터 요소, 없으면 기본 타입(CHAR·INT4·STRG·DEC)"""
import os
from xml.sax.saxutils import escape as x

OUT = os.path.join(os.path.dirname(__file__), '..', 'zalm_if', 'src')
HEAD = '<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0" serializer="LCL_OBJECT_{0}" serializer_version="v1.0.0">\n <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">\n  <asx:values>\n'
TAIL = '  </asx:values>\n </asx:abap>\n</abapGit>\n'

def predefined(t, leng, dec=0):
    # (INTTYPE, INTLEN, DATATYPE, LENG, MASK)
    if t == 'CHAR': return ('C', leng * 2, 'CHAR', leng, '  CHAR')
    if t == 'INT4': return ('X', 4, 'INT4', 10, '  INT4')
    if t == 'STRG': return ('g', 8, 'STRG', 0, '  STRG')
    if t == 'DEC': return ('P', leng // 2 + 1, 'DEC', leng, '  DEC')
    raise ValueError(t)

def field(f):
    name, key, typ, text = f
    o = ['    <DD03P>', f'     <FIELDNAME>{name}</FIELDNAME>']
    if key: o.append('     <KEYFLAG>X</KEYFLAG>')
    if isinstance(typ, str):
        o += [f'     <ROLLNAME>{typ}</ROLLNAME>', '     <ADMINFIELD>0</ADMINFIELD>']
        if key: o.append('     <NOTNULL>X</NOTNULL>')
        o.append('     <COMPTYPE>E</COMPTYPE>')
    else:
        it, il, dt, ln, mask = predefined(*typ)
        o += ['     <ADMINFIELD>0</ADMINFIELD>', f'     <INTTYPE>{it}</INTTYPE>', f'     <INTLEN>{il:06d}</INTLEN>']
        if key: o.append('     <NOTNULL>X</NOTNULL>')
        o += [f'     <DATATYPE>{dt}</DATATYPE>', f'     <LENG>{ln:06d}</LENG>']
        if dt == 'DEC' and len(typ) > 2: o.append(f'     <DECIMALS>{typ[2]:06d}</DECIMALS>')
        o += [f'     <MASK>{mask}</MASK>', f'     <DDTEXT>{x(text)}</DDTEXT>']
    o.append('    </DD03P>')
    return '\n'.join(o)

def table(name, text, contflag, tabart, tabkat, mainflag, fields, indexes=()):
    s = HEAD.format('TABL')
    s += f'   <DD02V>\n    <TABNAME>{name}</TABNAME>\n    <DDLANGUAGE>E</DDLANGUAGE>\n    <TABCLASS>TRANSP</TABCLASS>\n    <CLIDEP>X</CLIDEP>\n'
    s += f'    <DDTEXT>{x(text)}</DDTEXT>\n'
    if mainflag: s += f'    <MAINFLAG>{mainflag}</MAINFLAG>\n'
    s += f'    <CONTFLAG>{contflag}</CONTFLAG>\n    <EXCLASS>1</EXCLASS>\n   </DD02V>\n'
    s += f'   <DD09L>\n    <TABNAME>{name}</TABNAME>\n    <AS4LOCAL>A</AS4LOCAL>\n    <TABKAT>{tabkat}</TABKAT>\n    <TABART>{tabart}</TABART>\n    <BUFALLOW>N</BUFALLOW>\n   </DD09L>\n'
    s += '   <DD03P_TABLE>\n' + '\n'.join(field(f) for f in fields) + '\n   </DD03P_TABLE>\n'
    if indexes:
        s += '   <DD12V>\n'
        for iname, itext, _ in indexes:
            s += f'    <DD12V>\n     <SQLTAB>{name}</SQLTAB>\n     <INDEXNAME>{iname}</INDEXNAME>\n     <AS4LOCAL>A</AS4LOCAL>\n     <DDLANGUAGE>E</DDLANGUAGE>\n     <DDTEXT>{x(itext)}</DDTEXT>\n    </DD12V>\n'
        s += '   </DD12V>\n   <DD17V>\n'
        for iname, _, cols in indexes:
            for i, col in enumerate(cols, 1):
                s += f'    <DD17V>\n     <SQLTAB>{name}</SQLTAB>\n     <INDEXNAME>{iname}</INDEXNAME>\n     <POSITION>{i:04d}</POSITION>\n     <AS4LOCAL>A</AS4LOCAL>\n     <FIELDNAME>{col}</FIELDNAME>\n    </DD17V>\n'
        s += '   </DD17V>\n'
    s += TAIL
    open(os.path.join(OUT, f'{name.lower()}.tabl.xml'), 'w').write(s)

# 08 명세서 7장 ZALM_IF_LOG: 실행·건별 결과(10년 보관)
table('ZALM_IF_LOG', 'ALM interface run and posting log', 'A', 'APPL1', 2, '', [
    ('MANDT', True, 'MANDT', ''),
    ('LOG_ID', True, 'SYSUUID_X16', ''),
    ('IF_ID', False, ('CHAR', 10), 'Interface ID (IF-AA-01 etc.)'),
    ('BATCH_ID', False, ('CHAR', 40), 'Batch ID'),
    ('POSTING_ID', False, ('CHAR', 12), 'ALM posting ID'),
    ('CORR_ID', False, ('CHAR', 36), 'Correlation ID'),
    ('BUKRS', False, 'BUKRS', ''),
    ('STATUS', False, ('CHAR', 10), 'SUCCESS/PARTIAL/FAILED/POSTED'),
    ('HTTP_STATUS', False, ('INT4', 10), 'HTTP status code'),
    ('REC_CNT', False, ('INT4', 10), 'Records sent'),
    ('ERR_CNT', False, ('INT4', 10), 'Records with errors'),
    ('BELNR', False, 'BELNR_D', ''),
    ('GJAHR', False, 'GJAHR', ''),
    ('ANLN1', False, 'ANLN1', ''),
    ('ANLN2', False, 'ANLN2', ''),
    ('EBELN', False, 'EBELN', ''),
    ('OBJ_TYPE', False, 'AWTYP', ''),
    ('OBJ_KEY', False, 'AWKEY', ''),
    ('UNAME', False, 'XUBNAME', ''),
    ('START_TS', False, 'TIMESTAMPL', ''),
    ('END_TS', False, 'TIMESTAMPL', ''),
    ('MSG_JSON', False, ('STRG', 0), 'Messages / error response (JSON)'),
], indexes=[('Z01', 'Posting ID (duplicate check)', ['MANDT', 'POSTING_ID']),
            ('Z02', 'Interface and start time', ['MANDT', 'IF_ID', 'START_TS']),
            ('Z03', 'Status and HTTP status (resend)', ['MANDT', 'STATUS', 'HTTP_STATUS'])])

# ZALM_CFG: 설정값(대상 회사코드, 마지막 성공 시각, 기본값, 마감 차단). 여러 값(BUKRS 등)은 LOW로 구분
table('ZALM_CFG', 'ALM interface settings', 'A', 'APPL2', 0, 'X', [
    ('MANDT', True, 'MANDT', ''),
    ('PARAM', True, ('CHAR', 20), 'Parameter'),
    ('LOW', True, ('CHAR', 40), 'Key / list value'),
    ('VAL', False, ('CHAR', 255), 'Value'),
    ('DESCR', False, ('CHAR', 60), 'Description'),
    ('CHANGED_BY', False, 'XUBNAME', ''),
    ('CHANGED_AT', False, 'TIMESTAMP', ''),
])

# ZALM_MAP: 값 매핑(거래유형, 룸 약어 등). 거래유형의 유일한 기준(08 6.4)
table('ZALM_MAP', 'ALM interface value mapping', 'C', 'APPL2', 0, 'X', [
    ('MANDT', True, 'MANDT', ''),
    ('MAP_TYPE', True, ('CHAR', 20), 'Mapping type (RETIRE_TT etc.)'),
    ('ALM_VALUE', True, ('CHAR', 40), 'ALM value'),
    ('SAP_VALUE', False, ('CHAR', 40), 'SAP value'),
    ('DESCR', False, ('CHAR', 60), 'Description'),
])

# 메시지 클래스 ZALM: 001~099 통신, 100~199 데이터, 200~299 전기
MSGS = [
    ('000', '&1&2&3&4'),
    ('001', 'SM59 destination &1 cannot be opened'),
    ('002', 'Token request failed: HTTP &1 &2'),
    ('003', 'HTTP &1 &2 (attempt &3)'),
    ('004', 'Connection to ALM failed after &1 attempts: &2'),
    ('100', 'Record &1 skipped: required field &2 is empty'),
    ('200', 'Posting &1: &2'),
]
s = HEAD.format('MSAG') + '   <T100A>\n    <ARBGB>ZALM</ARBGB>\n    <MASTERLANG>E</MASTERLANG>\n    <STEXT>ALM interface</STEXT>\n   </T100A>\n   <T100>\n'
for no, t in MSGS:
    s += f'    <T100>\n     <SPRSL>E</SPRSL>\n     <ARBGB>ZALM</ARBGB>\n     <MSGNR>{no}</MSGNR>\n     <TEXT>{x(t)}</TEXT>\n    </T100>\n'
s += '   </T100>\n' + TAIL
open(os.path.join(OUT, 'zalm.msag.xml'), 'w').write(s)
print('ok')

import re, yaml, json
from spec_api import S, E, ERRORS
import spec_web  # registers web endpoints

def tschema(t):
    t = t.strip()
    if t.startswith('[') and t.endswith(']'):
        return {'type': 'array', 'items': tschema(t[1:-1])}
    m = re.fullmatch(r'string\((\d+)\)', t)
    if m: return {'type': 'string', 'maxLength': int(m.group(1))}
    m = re.fullmatch(r'enum\((.*)\)', t)
    if m: return {'type': 'string', 'enum': [x.strip() for x in m.group(1).split(',')]}
    base = {'string': {'type': 'string'}, 'int': {'type': 'integer'}, 'number': {'type': 'number'},
            'bool': {'type': 'boolean'}, 'date': {'type': 'string', 'format': 'date'},
            'datetime': {'type': 'string', 'format': 'date-time'}, 'uuid': {'type': 'string', 'format': 'uuid'},
            'object': {'type': 'object', 'additionalProperties': True}}
    if t in base: return dict(base[t])
    assert t in S, t
    return {'$ref': f'#/components/schemas/{t}'}

def comp_schemas():
    out = {}
    for name, (desc, fields) in S.items():
        props, req = {}, []
        for f, t, r, d in fields:
            p = tschema(t)
            if '$ref' in p: p = {'allOf': [p], 'description': d}
            else: p['description'] = d
            props[f] = p
            if r == 'Y': req.append(f)
        sc = {'type': 'object', 'description': desc, 'properties': props}
        if req: sc['required'] = req
        out[name] = sc
    # polymorphic spots
    out['MasterDataRequest']['properties']['records']['items'] = {'oneOf': [{'$ref': f'#/components/schemas/{n}'} for n in
        ['MdCompany', 'MdPlant', 'MdCostCenter', 'MdProfitCenter', 'MdAssetClass', 'MdLocation']]}
    out['PostingEnvelope']['properties']['payload'] = {'description': 'type별 payload', 'oneOf': [{'$ref': f'#/components/schemas/{n}'} for n in
        ['AssetCreatePayload', 'AssetChangePayload', 'AssetTransferPayload', 'AssetRetirePayload', 'CountResultPayload', 'PoCreatePayload']]}
    return out

def build_openapi():
    paths = {}
    for e in E:
        params = [{'$ref': '#/components/parameters/CorrelationId'}]
        if e['group'] == 'sap' and e['op'] != 'sapToken':
            params += [{'$ref': '#/components/parameters/SapSystem'}, {'$ref': '#/components/parameters/CompanyCode'}]
        if 'Idempotency-Key' in e['idem']:
            params.append({'$ref': '#/components/parameters/IdempotencyKey'})
        for n, where, t, r, d in e['params']:
            params.append({'name': n, 'in': where, 'required': r == 'Y', 'description': d, 'schema': tschema(t)})
        op = {'operationId': e['op'], 'summary': e['summary'], 'tags': [e['group'].upper()],
              'description': f"{e['ref']} · 테이블: {e['tables']}\n\n" + '\n'.join('- ' + x for x in e['rules']),
              'parameters': params, 'responses': {}}
        if e['op'] == 'sapToken':
            op['security'] = []
            op['requestBody'] = {'required': True, 'content': {'application/x-www-form-urlencoded': {'schema': {
                'type': 'object', 'required': ['grant_type'],
                'properties': {'grant_type': {'type': 'string', 'enum': ['client_credentials']}, 'client_id': {'type': 'string'},
                               'client_secret': {'type': 'string'}, 'scope': {'type': 'string', 'default': 'sap.api'}}}}}}
        else:
            op['security'] = {'pda': [{'pdaAuth': ['pda']}], 'sap': [{'sapAuth': ['sap.api']}], 'web': [{'webAuth': ['web']}]}[e['group']]
            if e['req']:
                op['requestBody'] = {'required': True, 'content': {'application/json': {'schema': {'$ref': f"#/components/schemas/{e['req']}"}}}}
        codes = [c.strip() for c in e['codes'].split(',')] + ['429', '500']
        for c in codes:
            if c == '204':
                op['responses'][c] = {'description': '성공(본문 없음)'}
            elif c in ('200', '201', '202', '207'):
                op['responses'][c] = {'description': {'200': '성공', '201': '생성', '202': '접수(비동기 처리)', '207': '일부 성공(건별 결과 확인)'}[c],
                                      'content': {'application/json': {'schema': {'$ref': f"#/components/schemas/{e['resp']}"}}}}
            elif c == '304':
                op['responses'][c] = {'description': '변경 없음(ETag 일치)'}
            else:
                op['responses'][c] = {'$ref': f'#/components/responses/E{c}'}
        paths.setdefault(e['path'], {})[e['method'].lower()] = op
    err_desc = {'400': '형식 오류', '401': '인증 실패', '403': '권한 없음', '404': '대상 없음', '409': '충돌', '410': '동기화 토큰 만료',
                '413': '파일 크기 초과', '422': '업무 규칙 위반', '502': '외부 장치 연결 실패', '429': '호출 제한', '500': '서버 오류'}
    doc = {
        'openapi': '3.1.0',
        'info': {'title': 'ALM API — Web · PDA · SAP', 'version': '0.2.0', 'license': {'name': 'Proprietary — BSG America', 'identifier': 'LicenseRef-BSG-Proprietary'},
                 'description': 'BSG America Asset Lifecycle Manager. WBS 2.6 — 웹 화면, PDA, SAP.'},
        'servers': [{'url': 'https://alm.{domain}/api/v1', 'variables': {'domain': {'default': 'example.com'}}}],
        'tags': [{'name': 'PDA', 'description': 'PDA 실사 앱 (Zebra TC58)'}, {'name': 'SAP', 'description': 'SAP S/4HANA 배치 잡(아웃바운드 호출)'}, {'name': 'WEB', 'description': '웹 화면(React SPA)'}],
        'paths': paths,
        'components': {
            'securitySchemes': {
                'webAuth': {'type': 'oauth2', 'description': 'Cognito 호스티드 UI + 고객사 SSO(SAML/OIDC). Authorization Code + PKCE. 액세스 60분, 리프레시 8시간(근무일 기준)',
                            'flows': {'authorizationCode': {'authorizationUrl': 'https://auth.{domain}/oauth2/authorize',
                                                            'tokenUrl': 'https://auth.{domain}/oauth2/token', 'scopes': {'web': '웹 화면'}}}},
                'pdaAuth': {'type': 'oauth2', 'description': 'Cognito 호스티드 UI + 고객사 SSO. Authorization Code + PKCE. 액세스 60분, 리프레시 24시간',
                            'flows': {'authorizationCode': {'authorizationUrl': 'https://auth.{domain}/oauth2/authorize',
                                                            'tokenUrl': 'https://auth.{domain}/oauth2/token', 'scopes': {'pda': 'PDA 실사'}}}},
                'sapAuth': {'type': 'oauth2', 'description': 'Client Credentials. 토큰 60분',
                            'flows': {'clientCredentials': {'tokenUrl': '/oauth/token', 'scopes': {'sap.api': 'SAP 연계'}}}}},
            'parameters': {
                'SapSystem': {'name': 'X-SAP-System', 'in': 'header', 'required': False, 'schema': {'type': 'string', 'maxLength': 10},
                              'description': 'SAP 시스템ID-클라이언트 (예: PRD-100). 로그 기록용. sap_connection과 다르면 403'},
                'CompanyCode': {'name': 'X-Company-Code', 'in': 'header', 'required': False, 'schema': {'type': 'string', 'maxLength': 4},
                              'description': '회사코드. 토큰에 허용된 회사코드가 아니면 403'},
                'CorrelationId': {'name': 'X-Correlation-Id', 'in': 'header', 'required': False, 'schema': {'type': 'string', 'format': 'uuid'},
                                  'description': '요청 추적 ID. 없으면 서버가 만들어 응답 헤더로 돌려줌'},
                'IdempotencyKey': {'name': 'Idempotency-Key', 'in': 'header', 'required': True, 'schema': {'type': 'string', 'maxLength': 80},
                                   'description': '24시간 안의 같은 키는 저장된 응답을 그대로 반환'}},
            'responses': {f'E{c}': {'description': d, 'content': {'application/problem+json': {'schema': {'$ref': '#/components/schemas/Problem'}}}}
                          for c, d in err_desc.items()},
            'schemas': comp_schemas()}}
    return doc

def md_fields(name):
    desc, fields = S[name]
    lines = [f'**{name}** — {desc}', '', '| 필드 | 타입 | 필수 | 설명 |', '| --- | --- | --- | --- |']
    for f, t, r, d in fields:
        t2 = t.replace('|', '/')
        lines.append(f'| {f} | {t2} | {"Y" if r == "Y" else ""} | {d} |')
    return '\n'.join(lines)

def refs_of(name, seen=None):
    seen = seen if seen is not None else []
    if name in seen: return seen
    seen.append(name)
    for f, t, r, d in S[name][1]:
        for m in re.findall(r'[A-Z][A-Za-z]+', t.replace('enum', '')):
            if m in S and m not in seen and not t.startswith('enum'):
                refs_of(m, seen)
    return seen

def md_endpoint(e, num):
    out = [f"### {num} {e['method']} {e['path']}", '', f"{e['summary']}. {e['ref']}.", '',
           '| 항목 | 값 |', '| --- | --- |',
           f"| operationId | {e['op']} |", f"| 인증 | {e['auth']} |", f"| 멱등성 | {e['idem']} |",
           f"| 응답 코드 | {e['codes']} |", f"| 테이블 | {e['tables']} |", '']
    if e['params']:
        out += ['| 파라미터 | 위치 | 타입 | 필수 | 설명 |', '| --- | --- | --- | --- | --- |']
        out += [f'| {n} | {w} | {t} | {"Y" if r == "Y" else ""} | {d} |' for n, w, t, r, d in e['params']] + ['']
    out += ['**처리 규칙**', ''] + [f'- {x}' for x in e['rules']] + ['']
    shown = []
    for nm, label in ((e['req'], '요청'), (e['resp'], '응답')):
        if not nm: continue
        out += [f'**{label}**', '']
        for s in refs_of(nm):
            if s in ('ItemResult', 'BatchResult') and nm == 'BatchResult' and s != nm: pass
            if s in SHOWN or s in shown:
                out += [f'- `{s}`: 위에서 정의', '']
                continue
            shown.append(s)
            out += [md_fields(s), '']
    SHOWN.update(shown)
    return '\n'.join(out)

SHOWN = set()

if __name__ == '__main__':
    doc = build_openapi()
    open('out/openapi.yaml', 'w').write(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, width=200))
    secs = {}
    SHOWN.update({'Problem', 'FieldError'})
    for g in ('pda', 'sap'):
        eps = [e for e in E if e['group'] == g]
        idx = 3 if g == 'pda' else 4
        table = ['| # | 메서드 | 경로 | 용도 | 화면·IF |', '| --- | --- | --- | --- | --- |']
        table += [f"| {idx}.{i+3} | {e['method']} | `{e['path']}` | {e['summary']} | {e['ref']} |" for i, e in enumerate(eps)]
        body = [md_endpoint(e, f'{idx}.{i+3}') for i, e in enumerate(eps)]
        if g == 'sap':
            extra = ['**전기 payload (type별)**', ''] + [md_fields(n) + '\n' for n in
                     ['AssetCreatePayload', 'AssetChangePayload', 'AssetTransferPayload', 'AssetRetirePayload', 'CountResultPayload', 'PoCreatePayload', 'PoCreateItem']]
            extra += ['**마스터 레코드 (type별)**', ''] + [md_fields(n) + '\n' for n in
                      ['MdCompany', 'MdPlant', 'MdCostCenter', 'MdProfitCenter', 'MdAssetClass', 'MdLocation']]
            SHOWN.update(['AssetCreatePayload', 'AssetChangePayload', 'AssetTransferPayload', 'AssetRetirePayload', 'CountResultPayload', 'PoCreatePayload', 'PoCreateItem',
                          'MdCompany', 'MdPlant', 'MdCostCenter', 'MdProfitCenter', 'MdAssetClass', 'MdLocation'])
            secs['sap_extra'] = '\n'.join(extra)
        secs[g + '_table'] = '\n'.join(table)
        secs[g + '_body'] = '\n\n'.join(body)
    err = ['| 코드 | HTTP·위치 | 이름 | 발생 조건 |', '| --- | --- | --- | --- |'] + [f'| {a} | {b} | {c} | {d} |' for a, b, c, d in ERRORS]
    secs['errors'] = '\n'.join(err)
    secs['problem'] = md_fields('Problem') + '\n\n' + md_fields('FieldError')
    json.dump(secs, open('out/md_parts.json', 'w'), ensure_ascii=False, indent=1)
    print(len(E), 'endpoints', len(S), 'schemas')

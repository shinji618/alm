# ALM permission catalog (WBS 2.8) — single source for:
#   openapi.yaml x-permission / x-scope, 06·07 "권한" column, 09 권한 매트릭스, backend guard map
# Scope kinds:
#   ALL  = 테넌트 전체. user_role에 회사코드·사이트가 있으면 그 범위로 줄어듦
#   CC   = user_role.cost_center_id (부서 관리자)
#   OWN  = 본인(할당 자산·내가 낸 요청)
#   TASK = 배정된 실사 작업(룸)
#   -    = 범위 없음(설정·시스템)

ROLES = [
    ('SYS_ADMIN', '시스템 관리자', '사용자·역할, 코드·설정, SAP 연결, Discovery 설정. 업무 데이터는 조회만'),
    ('ASSET_MANAGER', '자산 관리자', '자산 대장, 할당, 라이선스·계약, 실사 기획, 라벨, ALM 마스터'),
    ('DEPT_MANAGER', '부서 관리자', '담당 코스트센터의 자산·요청 조회와 승인'),
    ('ASSET_ACCOUNTANT', '자산회계', '금액, 최종 승인, SAP 전기·재처리·대사, 감사 로그'),
    ('COUNTER', '실사 담당', 'PDA 실사(배정된 룸만). 웹 화면 없음'),
    ('EMPLOYEE', '일반 사용자', '내 자산 조회, 요청 제출. 감사인을 뺀 모든 활성 사용자에게 자동 부여'),
    ('AUDITOR', '감사인', '전체 조회(금액·감사 로그 포함), 변경 불가. 유효기간 필수, 다른 역할과 함께 가질 수 없음'),
]

# key: (area, description)
PERMS = {
    'auth':            ('공통', '로그인한 활성 사용자(역할 무관)'),
    'dashboard.read':  ('대시보드', '대시보드 조회'),
    'asset.read':      ('자산', '자산·이력·할당·연결 정보 조회'),
    'asset.write':     ('자산', '자산 등록·수정'),
    'asset.assign':    ('자산', '할당·반납·수리 이동'),
    'amount.read':     ('자산', '금액 필드(취득가·누계액·NBV·단가·계약 금액) 보기. 없으면 null'),
    'discovery.read':  ('Discovery', '수집 작업·결과 조회'),
    'discovery.write': ('Discovery', '수집 작업 설정·실행'),
    'discovery.resolve': ('Discovery', '수집 결과 처리(자산 등록·갱신으로 이어짐)'),
    'cmdb.read':       ('CMDB', 'CI·관계 조회'),
    'cmdb.write':      ('CMDB', 'CI·관계 등록·수정'),
    'license.read':    ('라이선스', '라이선스·설치 소프트웨어 조회'),
    'license.write':   ('라이선스', '라이선스 등록·좌석 할당·회수'),
    'contract.read':   ('계약', '계약 조회'),
    'contract.write':  ('계약', '계약 등록·수정·갱신'),
    'po.read':         ('구매', 'PO·입고 조회'),
    'purchase.read':   ('구매', '구매요청 조회'),
    'purchase.request':('구매', '구매요청 작성·제출·취소(본인)'),
    'request.read':    ('요청·승인', '자산 요청 조회'),
    'request.create':  ('요청·승인', '자산 요청 작성·제출·취소(본인)'),
    'approval.decide': ('요청·승인', '승인·반려. 승인 단계의 역할과 범위가 맞아야 함. 승인 대상의 금액은 승인자에게 보임'),
    'count.read':      ('실사', '캠페인·결과 조회'),
    'count.manage':    ('실사', '캠페인 기획·배정·차이 처리·종료'),
    'count.post':      ('실사', '실사 결과 SAP 전기'),
    'count.scan':      ('실사', 'PDA 실사(스캔·미등록·작업 완료)'),
    'label.read':      ('라벨', '템플릿·프린터·출력 이력 조회'),
    'label.print':     ('라벨', '라벨 출력'),
    'label.config':    ('라벨', '템플릿·프린터 설정'),
    'sap.status':      ('SAP 연계', '연계 상태 요약'),
    'sap.monitor':     ('SAP 연계', '실행 로그·전기 큐·대사 결과 조회'),
    'sap.operate':     ('SAP 연계', '전기 재처리, 수동 실행 요청'),
    'sap.finance':     ('SAP 연계', '전기 취소, 대사 차이 처리, 전기 오류 요청 보정, 마감 실행(isClosing)'),
    'sap.config':      ('SAP 연계', 'SAP 연결·비밀 교체·필드 매핑'),
    'master.read':     ('관리', 'ALM 마스터 조회'),
    'master.write':    ('관리', 'ALM 마스터(사이트·룸·카테고리·모델·공급사) 등록·수정'),
    'admin.user':      ('관리', '사용자·역할 관리, 직무 충돌 점검'),
    'admin.config':    ('관리', '공통 코드·설정'),
    'audit.read':      ('관리', '감사 로그·보안 이벤트 조회'),
    'sap.api':         ('SAP 머신', 'SAP 배치 잡 전용(Client Credentials). 사람 역할에는 없음'),
}

R_ALL = ['dashboard.read', 'asset.read', 'amount.read', 'discovery.read', 'cmdb.read', 'license.read', 'contract.read',
         'po.read', 'purchase.read', 'request.read', 'count.read', 'label.read', 'sap.status', 'sap.monitor', 'master.read']

# role -> {perm: scope}
GRANTS = {
    'SYS_ADMIN': {**{p: 'ALL' for p in R_ALL},
                  'discovery.write': 'ALL', 'cmdb.write': 'ALL', 'label.config': '-', 'sap.operate': 'ALL', 'sap.config': '-',
                  'master.write': 'ALL', 'admin.user': '-', 'admin.config': '-', 'audit.read': 'ALL'},
    'ASSET_MANAGER': {**{p: 'ALL' for p in R_ALL if p != 'sap.monitor'},
                      'asset.write': 'ALL', 'asset.assign': 'ALL', 'discovery.write': 'ALL', 'discovery.resolve': 'ALL', 'cmdb.write': 'ALL',
                      'license.write': 'ALL', 'contract.write': 'ALL', 'count.manage': 'ALL',
                      'label.print': 'ALL', 'master.write': 'ALL'},
    'DEPT_MANAGER': {'dashboard.read': 'CC', 'asset.read': 'CC', 'purchase.read': 'CC', 'request.read': 'CC', 'approval.decide': 'CC'},
    'ASSET_ACCOUNTANT': {**{p: 'ALL' for p in ['dashboard.read', 'asset.read', 'amount.read', 'license.read', 'contract.read', 'po.read',
                                                'purchase.read', 'request.read', 'count.read', 'sap.status', 'sap.monitor', 'master.read']},
                         'approval.decide': 'ALL', 'count.post': 'ALL', 'sap.operate': 'ALL', 'sap.finance': 'ALL', 'audit.read': 'ALL'},
    'COUNTER': {'count.scan': 'TASK'},
    'EMPLOYEE': {'asset.read': 'OWN', 'purchase.read': 'OWN', 'purchase.request': 'OWN', 'request.read': 'OWN', 'request.create': 'OWN'},
    'AUDITOR': {**{p: 'ALL' for p in R_ALL}, 'audit.read': 'ALL'},
}

# EMPLOYEE is implicit for every active user except these roles
IMPLICIT_ROLE = 'EMPLOYEE'
IMPLICIT_EXCLUDED_IF = ['AUDITOR']
EXCLUSIVE_ROLES = ['AUDITOR']   # cannot be combined with any other role (H-05)

# operationId -> permission (str) or any-of list. Data-level rules (요청자 본인, 승인 단계 역할) are in each endpoint's rules. Data-level rules (요청자 본인, 승인 단계 역할) are in each endpoint's rules.
OPS = {
    # auth & common
    'authLogin': None, 'authCallback': None, 'authRefresh': None, 'authLogout': None,
    'getMe': 'auth', 'patchMe': 'auth', 'getLookups': 'auth', 'search': 'auth', 'listNotifications': 'auth', 'readNotification': 'auth',
    'presignAttachment': 'auth', 'downloadAttachment': 'auth', 'createExport': 'auth', 'getExport': 'auth',
    'getDashboard': 'dashboard.read',
    # assets
    'listAssets': 'asset.read', 'getAsset': 'asset.read', 'listAssetHistory': 'asset.read', 'listAssetAssignments': 'asset.read',
    'listAssetContracts': 'asset.read', 'listAssetSoftware': 'asset.read', 'listAssetTickets': 'asset.read', 'listAssetAttachments': 'asset.read',
    'listAssetValues': 'amount.read', 'createAsset': 'asset.write', 'patchAsset': 'asset.write',
    'checkOutAsset': 'asset.assign', 'checkInAsset': 'asset.assign', 'moveRepair': 'asset.assign',
    # discovery & cmdb
    'listDiscoveryJobs': 'discovery.read', 'listDiscoveryRuns': 'discovery.read', 'listDiscoveryItems': 'discovery.read',
    'createDiscoveryJob': 'discovery.write', 'patchDiscoveryJob': 'discovery.write', 'runDiscoveryJob': 'discovery.write', 'resolveDiscoveryItems': 'discovery.resolve',
    'listCis': 'cmdb.read', 'getCiGraph': 'cmdb.read', 'listTickets': 'asset.read',
    'createCi': 'cmdb.write', 'patchCi': 'cmdb.write', 'createCiRelation': 'cmdb.write', 'deleteCiRelation': 'cmdb.write',
    # license & contract
    'listSoftwareProducts': 'license.read', 'listLicenses': 'license.read', 'getLicenseUsage': 'license.read', 'listUnauthorized': 'license.read',
    'createSoftwareProduct': 'license.write', 'patchSoftwareProduct': 'license.write', 'createLicense': 'license.write', 'patchLicense': 'license.write',
    'assignSeat': 'license.write', 'releaseSeat': 'license.write', 'reclaimSeats': 'license.write', 'requestLicensePurchase': 'license.write',
    'listContracts': 'contract.read', 'getContract': 'contract.read', 'getRenewalCalendar': 'contract.read',
    'createContract': 'contract.write', 'patchContract': 'contract.write', 'addContractAssets': 'contract.write',
    'removeContractAsset': 'contract.write', 'renewContract': 'contract.write',
    # purchase
    'listPurchaseRequests': 'purchase.read', 'getPurchaseRequest': 'purchase.read',
    'createPurchaseRequest': 'purchase.request', 'patchPurchaseRequest': 'purchase.request', 'submitPurchaseRequest': 'purchase.request',
    'cancelPurchaseRequest': ['purchase.request', 'asset.write'], 'listPoItems': 'po.read', 'getPoItem': 'po.read',
    # requests & approvals
    'listAssetRequests': 'request.read', 'getAssetRequest': 'request.read',
    'createAssetRequest': 'request.create', 'patchAssetRequest': 'request.create', 'submitAssetRequest': 'request.create',
    'cancelAssetRequest': ['request.create', 'asset.write'], 'fixAssetRequest': 'sap.finance',
    'listApprovalInbox': 'approval.decide', 'approve': 'approval.decide', 'reject': 'approval.decide',
    # count
    'listCampaigns': 'count.read', 'getCampaign': 'count.read', 'listCampaignTasks': 'count.read', 'listCountItems': 'count.read',
    'listUnregistered': 'count.read',
    'createCampaign': 'count.manage', 'patchCampaign': 'count.manage', 'previewScope': 'count.manage', 'startCampaign': 'count.manage',
    'assignCountTask': 'count.manage', 'closeCounting': 'count.manage', 'resolveVariances': 'count.manage',
    'resolveUnregistered': 'count.manage', 'closeCampaign': 'count.manage', 'postCountResults': 'count.post',
    # label
    'listLabelTemplates': 'label.read', 'listPrinters': 'label.read', 'listLabelJobs': 'label.read', 'previewZpl': 'label.read',
    'createLabelTemplate': 'label.config', 'patchLabelTemplate': 'label.config', 'createPrinter': 'label.config', 'patchPrinter': 'label.config',
    'getTestLabel': 'label.print', 'createLabelJobs': 'label.print', 'renderLabelJobs': 'label.print', 'reportLabelJobs': 'label.print',
    # sap (web)
    'getSapStatus': 'sap.status', 'listSapRuns': 'sap.monitor', 'listSapRunMessages': 'sap.monitor', 'listPostings': 'sap.monitor',
    'getPosting': 'sap.monitor', 'listReconRuns': 'sap.monitor', 'listReconDiffs': 'sap.monitor', 'listFieldMappings': 'sap.monitor',
    'retryPosting': 'sap.operate', 'createRunRequest': 'sap.operate',
    'cancelPosting': 'sap.finance', 'resolveReconDiffs': 'sap.finance',
    'patchFieldMapping': 'sap.config', 'listSapConnections': 'sap.config', 'createSapConnection': 'sap.config', 'rotateSapSecret': 'sap.config',
    # admin
    'listUsers': 'admin.user', 'createUser': 'admin.user', 'patchUser': 'admin.user', 'putUserRoles': 'admin.user', 'listSodConflicts': 'admin.user',
    'listMasters': 'master.read', 'createMaster': 'master.write', 'patchMaster': 'master.write',
    'listCodes': 'admin.config', 'putCodeGroup': 'admin.config', 'listSettings': 'admin.config', 'putSetting': 'admin.config',
    'listAuditLogs': 'audit.read', 'listSecurityEvents': 'audit.read',
}
# PDA endpoints: count.scan (TASK). SAP endpoints: sap.api. Filled by group in apply().

# Extra data-level conditions shown in docs (operationId -> text)
# parameter-level permission: (operationId, condition) -> permission
PARAM_PERMS = {('createRunRequest', 'isClosing = true'): 'sap.finance'}

COND = {
    'getExport': '요청자 본인', 'search': '엔터티별 조회 권한·범위로 거른 결과만', 'getLookups': 'users는 approval.decide·asset.assign·count.manage·admin.user 중 하나',
    'createRunRequest': 'isClosing = true는 sap.finance', 'fixAssetRequest': 'POST_ERROR, 기술 필드만(회계 필드는 재승인)',
    'authRefresh': '쿠키 alm_rt + X-ALM-CSRF + Origin', 'authLogout': '쿠키 alm_rt + X-ALM-CSRF + Origin', 'presignAttachment': '대상 화면의 쓰기 권한', 'downloadAttachment': '대상 화면의 조회 권한',
    'createExport': '대상 목록의 조회 권한. 금액 열은 amount.read', 'listTickets': '연결된 자산 조회 범위',
    'patchPurchaseRequest': '요청자 본인, DRAFT', 'submitPurchaseRequest': '요청자 본인', 'cancelPurchaseRequest': '요청자 본인 또는 asset.write',
    'patchAssetRequest': '요청자 본인, DRAFT', 'submitAssetRequest': '요청자 본인',
    'cancelAssetRequest': '요청자 본인 또는 asset.write',
    'getPurchaseRequest': '범위 + 요청자·승인자', 'getAssetRequest': '범위 + 요청자·승인자',
    'approve': '승인 단계의 역할·범위, 요청자 본인 아님, 같은 요청의 앞 단계 승인자 아님', 'reject': '승인 단계의 역할·범위',
    'putUserRoles': '자기 자신 제외', 'patchUser': '이메일은 IdP 미연결 사용자만',
}

def scope_of(role, perm):
    return GRANTS.get(role, {}).get(perm)

def roles_with(perm):
    ps = perm if isinstance(perm, list) else [perm]
    return [r for r, _, _ in ROLES if any(p in GRANTS[r] for p in ps)]

def _label(p):
    return ' | '.join(f'`{x}`' for x in p) if isinstance(p, list) else f'`{p}`'

def apply(E):
    """Attach permission info to endpoint dicts; return list of problems."""
    probs = []
    for e in E:
        if e['group'] == 'pda':
            p = 'count.scan'
        elif e['group'] == 'sap':
            p = None if e['op'] == 'sapToken' else 'sap.api'
        else:
            if e['op'] not in OPS:
                probs.append('no mapping: ' + e['op']); continue
            p = OPS[e['op']]
        e['perm'] = p
        if p is None:
            e['auth'] = '없음(공개)' if e['group'] == 'web' else '없음(client_id/secret)'
        elif p == 'auth':
            e['auth'] = '`auth` (로그인 사용자)'
        elif p == 'sap.api':
            e['auth'] = '`sap.api` (SAP 머신 클라이언트)'
        elif p == 'count.scan':
            e['auth'] = '`count.scan` (COUNTER, 배정 작업)'
        else:
            e['auth'] = f"{_label(p)} ({', '.join(roles_with(p))})"
        if e['op'] in COND:
            e['auth'] += ' · ' + COND[e['op']]
    for op in OPS:
        if op not in {e['op'] for e in E}:
            probs.append('stale mapping: ' + op)
    for (op, _), p in PARAM_PERMS.items():
        if op not in OPS: probs.append('stale param perm: ' + op)
    for r, g in GRANTS.items():
        for p in g:
            if p not in PERMS: probs.append(f'unknown perm {p} in {r}')
    for p in PERMS:
        if p not in ('auth', 'sap.api') and not any(p in g for g in GRANTS.values()):
            probs.append('perm granted to nobody: ' + p)
    return probs

def catalog():
    """Machine-readable catalog for backend/frontend (packages/shared)."""
    return {'roles': [{'code': r, 'name': n, 'summary': d} for r, n, d in ROLES],
            'permissions': [{'key': k, 'area': a, 'description': d} for k, (a, d) in PERMS.items()],
            'grants': GRANTS, 'operations': OPS,
            'implicit': {'role': IMPLICIT_ROLE, 'excludedIf': IMPLICIT_EXCLUDED_IF}, 'exclusiveRoles': EXCLUSIVE_ROLES,
            'paramPermissions': [{'operation': o, 'when': c, 'permission': p} for (o, c), p in PARAM_PERMS.items()]}

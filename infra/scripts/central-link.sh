#!/usr/bin/env bash
# ALM ↔ 중앙 ID 서비스 연결(WBS 3.13). 관리 계정(BSG ALM) CloudShell에서 실행한다(SSO 관리자). 두 계정에 AWSControlTowerExecution으로 들어간다.
# 비밀 값은 화면에 출력하지 않는다.
#   bash infra/scripts/central-link.sh dev secrets                         중앙 풀의 alm-web·alm-pda·alm-backend 클라이언트 → ALM 비밀 alm/<env>/central-id
#   bash infra/scripts/central-link.sh dev tenant TEST "Okta 시험" bsgglobal.com   중앙에 테넌트(제품 alm) 등록 + ALM 풀의 테넌트 IdP(T-<코드>) 설정을 중앙 풀로 복사
#   bash infra/scripts/central-link.sh dev migrate [테넌트 코드]            ALM 사용자·역할을 같은 ID로 중앙에 이관(ALM migrate 작업 정의로 RunTask)
#   bash infra/scripts/central-link.sh dev restart                         ALM api·worker 재시작(비밀 반영)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV=${1:?env}; STEP=${2:?step}
Env="$(tr '[:lower:]' '[:upper:]' <<< "${ENV:0:1}")${ENV:1}"
export AWS_REGION=us-east-1
[[ -d node_modules ]] || npm ci --no-audit --no-fund >/dev/null
read -r ID_ACCT ALM_ACCT <<< "$(npx tsx -e "import { ID_ENVS } from './lib/identity/config'; import { ENVS } from './lib/config'; console.log(ID_ENVS['${ENV}'].account, ENVS['${ENV}'].account)")"
creds() { aws sts assume-role --role-arn "arn:aws:iam::$1:role/AWSControlTowerExecution" --role-session-name central-link \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text; }
read -r IAK ISK IST <<< "$(creds "$ID_ACCT")"; read -r AAK ASK AST <<< "$(creds "$ALM_ACCT")"
as_id()  { AWS_ACCESS_KEY_ID=$IAK AWS_SECRET_ACCESS_KEY=$ISK AWS_SESSION_TOKEN=$IST "$@"; }
as_alm() { AWS_ACCESS_KEY_ID=$AAK AWS_SECRET_ACCESS_KEY=$ASK AWS_SESSION_TOKEN=$AST "$@"; }
out() { "$1" aws cloudformation describe-stacks --stack-name "$2" --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue | [0]" --output text; }
ID_POOL=$(out as_id "Id-${Env}-Auth" UserPoolId); ID_FN=$(out as_id "Id-${Env}-Api" FunctionName)
# 중앙 API를 플랫폼 관리자로(함수 직접 호출). 인자: 메서드 경로 [본문 JSON 파일]
central() {
  local body=null; [[ -n "${3:-}" ]] && body=$(cat "$3")
  local payload; payload=$(python3 -c "import json,sys; print(json.dumps({'action':'http','method':sys.argv[1],'path':sys.argv[2],'query':{},'body':json.loads(sys.argv[3])}))" "$1" "$2" "$body")
  local f; f=$(mktemp); as_id aws lambda invoke --function-name "$ID_FN" --cli-binary-format raw-in-base64-out --cli-read-timeout 120 --payload "$payload" "$f" >/dev/null
  cat "$f"; rm -f "$f"
}
umask 077; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

case "$STEP" in
secrets)
  as_id aws cognito-idp list-user-pool-clients --user-pool-id "$ID_POOL" --max-results 60 --output json > "$TMP/clients.json"
  for n in alm-web alm-pda alm-backend; do
    id=$(python3 -c "import json,sys; c=[x for x in json.load(open(sys.argv[1]))['UserPoolClients'] if x['ClientName']==sys.argv[2]]; print(c[0]['ClientId'] if c else '')" "$TMP/clients.json" "$n")
    [[ -n "$id" ]] || { echo "중앙 풀에 $n 클라이언트가 없습니다(제품 등록 먼저: identity-admin.sh POST /v1/products)" >&2; exit 1; }
    as_id aws cognito-idp describe-user-pool-client --user-pool-id "$ID_POOL" --client-id "$id" --output json > "$TMP/$n.json"
    echo "$n: $id"
  done
  python3 - "$TMP" > "$TMP/secret.json" <<'PY'
import json,sys,os
d=sys.argv[1]; c=lambda n: json.load(open(os.path.join(d,f'{n}.json')))['UserPoolClient']
w,p,b=c('alm-web'),c('alm-pda'),c('alm-backend')
print(json.dumps({'webClientId':w['ClientId'],'webClientSecret':w['ClientSecret'],'pdaClientId':p['ClientId'],'backendClientId':b['ClientId'],'backendClientSecret':b['ClientSecret']}))
PY
  as_alm aws secretsmanager put-secret-value --secret-id "alm/${ENV}/central-id" --secret-string "file://$TMP/secret.json" --query VersionId --output text
  echo "비밀 alm/${ENV}/central-id 갱신. ALM api·worker를 재시작해야 반영된다: bash infra/scripts/central-link.sh ${ENV} restart" ;;
tenant)
  CODE=${3:?테넌트 코드}; NAME=${4:?테넌트 이름}; DOMAINS=${5:?도메인(쉼표)}
  ALM_POOL=$(as_alm aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='alm-${ENV}'].Id | [0]" --output text)
  python3 -c "import json,sys; print(json.dumps({'code':sys.argv[1],'name':sys.argv[2],'domains':sys.argv[3].split(','),'products':['alm']}))" "$CODE" "$NAME" "$DOMAINS" > "$TMP/tenant.json"
  r=$(central POST /v1/tenants "$TMP/tenant.json"); echo "테넌트: $(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('status'), d['body'].get('code'), d['body'].get('message',''))" "$r")"
  if as_alm aws cognito-idp describe-identity-provider --user-pool-id "$ALM_POOL" --provider-name "T-${CODE}" --output json > "$TMP/idp.json" 2>/dev/null; then
    python3 - "$TMP/idp.json" > "$TMP/sso.json" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]))['IdentityProvider']; d=p['ProviderDetails']
if p['ProviderType']=='OIDC': print(json.dumps({'type':'OIDC','oidc':{'issuer':d['oidc_issuer'],'clientId':d['client_id'],'clientSecret':d['client_secret']}}))
elif d.get('MetadataURL'): print(json.dumps({'type':'SAML','metadataUrl':d['MetadataURL']}))
else: print(json.dumps({'type':'SAML','metadataXml':d['MetadataFile']}))
PY
    r=$(central PUT "/v1/tenants/${CODE}/sso" "$TMP/sso.json")
    python3 -c "import json,sys; d=json.loads(sys.argv[1]); b=d['body']; print('SSO:', d['status'], b.get('providerName'), b.get('type',''), b.get('message',''), 'ACS/리디렉트:', (b.get('acsUrl') or '').replace('/saml2/idpresponse',''))" "$r"
    echo "고객 IdP에 새 주소를 추가해야 한다: OIDC 리디렉트 URI https://$(out as_id "Id-${Env}-Api" LoginUrl | sed 's#https://##')/oauth2/idpresponse  (SAML은 Entity ID urn:amazon:cognito:sp:${ID_POOL}, ACS https://…/saml2/idpresponse)"
  else echo "ALM 풀에 T-${CODE} IdP가 없다 — SSO는 따로 등록(identity-admin.sh PUT /v1/tenants/${CODE}/sso)"; fi ;;
migrate)
  CLUSTER=$(out as_alm "Alm-${Env}-App" ClusterName); FAMILY=$(out as_alm "Alm-${Env}-App" MigrateFamily)
  SG=$(out as_alm "Alm-${Env}-App" MigrateSecurityGroupId); SUBNETS=$(out as_alm "Alm-${Env}-App" AppSubnetIds)
  cmd='["node","dist/main","identity-migrate"'"${3:+,\"$3\"}"']'
  task=$(as_alm aws ecs run-task --cluster "$CLUSTER" --task-definition "$FAMILY" --launch-type FARGATE --started-by identity-migrate \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG}],assignPublicIp=DISABLED}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"app\",\"command\":${cmd}}]}" --query 'tasks[0].taskArn' --output text)
  echo "task: $task"; as_alm aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
  code=$(as_alm aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
  as_alm aws logs filter-log-events --log-group-name "/alm/${ENV}/migrate" --log-stream-name-prefix "migrate/app/${task##*/}" --query 'events[].message' --output text | tr '\t' '\n' | tail -20
  echo "exit: $code" ;;
restart)
  CLUSTER=$(out as_alm "Alm-${Env}-App" ClusterName)
  for s in $(as_alm aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns' --output text); do
    as_alm aws ecs update-service --cluster "$CLUSTER" --service "$s" --force-new-deployment --query 'service.serviceName' --output text
  done ;;
*) echo "step: secrets | tenant | migrate | restart" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# alm-cognito-admin 호출(WBS 3.3). 관리 계정 CloudShell에서 실행한다(환경 계정은 AWSControlTowerExecution으로 들어간다).
# 백엔드 관리 화면(3.4)이 생기기 전까지 테넌트 IdP·SAP 클라이언트는 이 스크립트로 등록한다. 런북: 13_테넌트_SSO_등록_런북
#
#   bash cognito-admin.sh dev info                                   # 풀 ID, SAML Entity ID·ACS URL, 등록된 IdP
#   bash cognito-admin.sh dev '{"action":"registerIdp","tenantCode":"BSG","type":"SAML","metadataUrl":"https://login.microsoftonline.com/…"}'
#   bash cognito-admin.sh dev '{"action":"syncIdps"}'
#   bash cognito-admin.sh dev '{"action":"createSapClient","tenantCode":"BSG","systemId":"DEV"}'   # 비밀은 이때 한 번만 표시
set -euo pipefail
ENV=${1:?dev|qa|prd}; ARG=${2:?info 또는 JSON}
case "$ENV" in
  dev) acct=236501162716; zone=alm-dev.pasapps.com ;;
  qa)  acct=428477779499; zone=alm-qa.pasapps.com ;;
  prd) acct=482545366457; zone=alm.pasapps.com ;;
  *) echo "env는 dev|qa|prd" >&2; exit 2 ;;
esac
read -r AK SK ST <<< "$(aws sts assume-role --role-arn "arn:aws:iam::${acct}:role/AWSControlTowerExecution" \
  --role-session-name alm-cognito-admin --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
export AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1

if [[ "$ARG" == "info" ]]; then
  pool=$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='alm-${ENV}'].Id | [0]" --output text)
  web=$(aws cognito-idp list-user-pool-clients --user-pool-id "$pool" --query "UserPoolClients[?ClientName=='alm-web'].ClientId | [0]" --output text)
  echo "사용자 풀        : $pool"
  echo "SAML Entity ID   : urn:amazon:cognito:sp:$pool"
  echo "SAML ACS(응답) URL: https://auth.${zone}/saml2/idpresponse"
  echo "로그인 시험 URL   : https://auth.${zone}/oauth2/authorize?identity_provider=T-<테넌트>&client_id=${web}&response_type=code&scope=openid+email+profile&redirect_uri=https://${zone}/api/v1/auth/callback"
  echo "등록된 IdP       : $(aws cognito-idp list-identity-providers --user-pool-id "$pool" --query 'Providers[].ProviderName' --output text)"
  exit 0
fi

out=$(mktemp)
aws lambda invoke --function-name "alm-${ENV}-cognito-admin" --cli-binary-format raw-in-base64-out --payload "$ARG" "$out" >/dev/null
jq . "$out"; rm -f "$out"

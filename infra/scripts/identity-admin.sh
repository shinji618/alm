#!/usr/bin/env bash
# 중앙 ID 서비스 플랫폼 관리 호출(WBS 3.12). 함수를 직접 호출(IAM 허가)해 플랫폼 관리자로 API를 실행한다.
# identity 계정 자격 증명(SSO 관리자 또는 배포 역할)으로 실행한다.
#   bash infra/scripts/identity-admin.sh dev GET /v1/products
#   bash infra/scripts/identity-admin.sh dev POST /v1/products infra/identity/products/alm.dev.json
#   bash infra/scripts/identity-admin.sh dev PUT /v1/tenants/ACME/sso sso.json
# 응답에 클라이언트 비밀이 있으면(제품 등록 첫 회) 화면에만 나온다. 바로 비밀 저장소에 옮기고 화면을 지운다
set -euo pipefail
ENV=${1:?env}; METHOD=${2:?method}; P=${3:?path}; BODY_FILE=${4:-}
Env="$(tr '[:lower:]' '[:upper:]' <<< "${ENV:0:1}")${ENV:1}"
export AWS_REGION=${AWS_REGION:-us-east-1}
fn=$(aws cloudformation describe-stacks --stack-name "Id-${Env}-Api" --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue | [0]" --output text)
path=${P%%\?*}; qs=""; [[ "$P" == *\?* ]] && qs=${P#*\?}
query=$(python3 -c "import json,sys,urllib.parse as u; print(json.dumps(dict(u.parse_qsl(sys.argv[1]))))" "$qs")
body=null; [[ -n "$BODY_FILE" ]] && body=$(cat "$BODY_FILE")
payload=$(python3 -c "import json,sys; print(json.dumps({'action':'http','method':sys.argv[1],'path':sys.argv[2],'query':json.loads(sys.argv[3]),'body':json.loads(sys.argv[4])}))" "$METHOD" "$path" "$query" "$body")
out=$(mktemp)
aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out --cli-read-timeout 120 --payload "$payload" "$out" >/dev/null
python3 -m json.tool --no-ensure-ascii "$out"; rm -f "$out"

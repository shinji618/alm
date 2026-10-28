#!/usr/bin/env bash
# 중앙 ID 서비스 계정 첫 준비(WBS 3.11, 환경마다 1회). 관리 계정(BSG ALM) CloudShell에서 저장소 infra 폴더를 풀어 놓고 실행한다.
#   bash infra/scripts/identity-setup.sh dev
# 1) identity 계정(AWSControlTowerExecution 역할) CDK 부트스트랩
# 2) Id-<Env>-Dns 스택 배포 → 영역 id[-dev|-qa].pasapps.com
# 3) 그 영역의 네임서버를 관리 계정 pasapps.com 영역에 NS로 넣는다(UPSERT, 다시 실행해도 됨)
set -euo pipefail
cd "$(dirname "$0")/.."
PARENT=pasapps.com
ENV=${1:?사용: $0 dev|qa|prd}
case "$ENV" in dev|qa|prd) ;; *) echo "env는 dev|qa|prd" >&2; exit 2 ;; esac
Env="$(tr '[:lower:]' '[:upper:]' <<< "${ENV:0:1}")${ENV:1}"
[[ -d node_modules ]] || npm ci --no-audit --no-fund
read -r ACCT ZONE <<< "$(npx tsx -e "import { ID_ENVS } from './lib/identity/config'; const c = ID_ENVS['${ENV}']; console.log(c.account, c.zoneName)")"
[[ "$ACCT" =~ ^[0-9]{12}$ ]] || { echo "lib/identity/config.ts의 ${ENV} 계정 ID가 아직 자리 값입니다(${ACCT})" >&2; exit 1; }
PZ=$(aws route53 list-hosted-zones-by-name --dns-name "$PARENT" --query "HostedZones[?Name=='${PARENT}.'].Id | [0]" --output text); PZ=${PZ##*/}
[[ "$PZ" == Z* ]] || { echo "관리 계정에 ${PARENT} 호스팅 영역이 없습니다" >&2; exit 1; }

read -r AK SK ST <<< "$(aws sts assume-role --role-arn "arn:aws:iam::${ACCT}:role/AWSControlTowerExecution" \
  --role-session-name id-setup --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
as_id() { AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST AWS_REGION=us-east-1 "$@"; }

echo "=== 1. bootstrap ${ACCT} us-east-1"
# infra 폴더 안에서 실행하면 cdk.json의 앱(bin/app.ts)을 합성하다 "This app contains no stacks"로 멈춘다 → 앱 없는 곳에서 실행
CDK_BIN="$PWD/node_modules/.bin/cdk"
(cd /tmp && as_id "$CDK_BIN" bootstrap "aws://${ACCT}/us-east-1" --tags Project=Identity --tags Owner=BSG)

echo "=== 2. Id-${Env}-Dns → ${ZONE}"
as_id npx cdk -a "npx tsx bin/identity.ts" deploy -c env="$ENV" "Id-${Env}-Dns" --exclusively --require-approval never --progress events
ns=$(as_id aws cloudformation describe-stacks --stack-name "Id-${Env}-Dns" --query "Stacks[0].Outputs[?OutputKey=='NameServers'].OutputValue | [0]" --output text)
echo "네임서버: ${ns}"

echo "=== 3. ${PARENT} 위임"
records=$(tr ',' '\n' <<< "$ns" | sed 's/.*/{"Value":"&."}/' | paste -sd, -)
aws route53 change-resource-record-sets --hosted-zone-id "$PZ" --query ChangeInfo.Status --output text --change-batch "{
  \"Comment\": \"Identity ${ENV} delegation\",
  \"Changes\": [{\"Action\": \"UPSERT\", \"ResourceRecordSet\": {\"Name\": \"${ZONE}.\", \"Type\": \"NS\", \"TTL\": 3600, \"ResourceRecords\": [${records}]}}]}"
echo "준비 완료: 다음은 scripts/identity-deploy.sh ${ENV} (identity 계정 자격 증명으로)"

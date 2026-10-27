#!/usr/bin/env bash
# 환경 호스팅 영역 만들기 + 상위 도메인 위임 (환경 첫 배포 전에 1회)
# 관리 계정(BSG ALM) CloudShell에서 저장소 infra 폴더를 풀어 놓고 실행한다.
#   bash infra/scripts/setup-dns.sh dev        # 여러 개: dev qa prd
# 1) 환경 계정(AWSControlTowerExecution)으로 Alm-<Env>-Dns 스택 배포 → 영역 alm[-qa|-dev].pasapps.com
# 2) 그 영역의 네임서버 4개를 관리 계정의 pasapps.com 영역에 NS 레코드로 넣는다(UPSERT, 다시 실행해도 됨)
set -euo pipefail
cd "$(dirname "$0")/.."
PARENT=pasapps.com
[[ $# -ge 1 ]] || { echo "사용: $0 dev [qa prd]" >&2; exit 2; }
[[ -d node_modules ]] || npm ci --no-audit --no-fund
PZ=$(aws route53 list-hosted-zones-by-name --dns-name "$PARENT" --query "HostedZones[?Name=='${PARENT}.'].Id | [0]" --output text)
PZ=${PZ##*/}
[[ "$PZ" == Z* ]] || { echo "관리 계정에 ${PARENT} 호스팅 영역이 없습니다" >&2; exit 1; }
echo "상위 영역 ${PARENT}: ${PZ}"

for env in "$@"; do
  case "$env" in
    dev) acct=236501162716; zone=alm-dev.$PARENT ;;
    qa)  acct=428477779499; zone=alm-qa.$PARENT ;;
    prd) acct=482545366457; zone=alm.$PARENT ;;
    *) echo "env는 dev|qa|prd" >&2; exit 2 ;;
  esac
  Env="$(tr '[:lower:]' '[:upper:]' <<< "${env:0:1}")${env:1}"
  echo "=== ${env}: Alm-${Env}-Dns → ${zone}"
  read -r AK SK ST <<< "$(aws sts assume-role --role-arn "arn:aws:iam::${acct}:role/AWSControlTowerExecution" \
    --role-session-name alm-dns --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
  ns=$(AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST bash -c "
    npx cdk deploy -c env=${env} Alm-${Env}-Dns --exclusively --require-approval never --progress events 1>&2 &&
    aws cloudformation describe-stacks --region us-east-1 --stack-name Alm-${Env}-Dns \
      --query \"Stacks[0].Outputs[?OutputKey=='NameServers'].OutputValue | [0]\" --output text")
  echo "네임서버: ${ns}"
  records=$(tr ',' '\n' <<< "$ns" | sed 's/.*/{"Value":"&."}/' | paste -sd, -)
  aws route53 change-resource-record-sets --hosted-zone-id "$PZ" --query ChangeInfo.Status --output text --change-batch "{
    \"Comment\": \"ALM ${env} delegation\",
    \"Changes\": [{\"Action\": \"UPSERT\", \"ResourceRecordSet\": {\"Name\": \"${zone}.\", \"Type\": \"NS\", \"TTL\": 3600, \"ResourceRecords\": [${records}]}}]}"
  echo "위임 완료: ${zone}"
done
echo "DNS 설정 완료"

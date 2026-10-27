#!/usr/bin/env bash
# 옛 도메인(bsgapps.com) 흔적 정리 — 도메인 이전(README '도메인 이전') 2단계 배포가 끝난 뒤 1회.
# 관리 계정(BSG ALM) CloudShell에서 실행한다. 기본은 확인만 하고, --apply를 붙여야 실제로 지운다.
#   bash infra/scripts/cleanup-old-domain.sh            # 지울 대상 보기
#   bash infra/scripts/cleanup-old-domain.sh --apply    # 지우기
# 지우는 것
#   1) 환경 계정: 옛 영역 alm[-qa|-dev].bsgapps.com(CloudFormation 관리에서 빠진 것만)과 그 안의 레코드
#   2) 환경 계정: 쓰이지 않는 옛 인증서(*.bsgapps.com, us-east-1)
#   3) 관리 계정: bsgapps.com 영역의 alm[-qa|-dev] NS 위임 레코드
# bsgapps.com 도메인 등록과 그 호스팅 영역 자체는 건드리지 않는다.
set -euo pipefail
OLD=bsgapps.com
APPLY=false; [[ "${1:-}" == "--apply" ]] && APPLY=true
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
run() { if $APPLY; then "$@"; else echo "  (확인만) $*" | cut -c1-200; fi; }

declare -A ACCT=([dev]=236501162716 [qa]=428477779499 [prd]=482545366457)
declare -A ZONE=([dev]=alm-dev.$OLD [qa]=alm-qa.$OLD [prd]=alm.$OLD)

for env in dev qa prd; do
  acct=${ACCT[$env]}; zone=${ZONE[$env]}
  echo "=== ${env} (${acct}) ${zone}"
  read -r AK SK ST <<< "$(aws sts assume-role --role-arn "arn:aws:iam::${acct}:role/AWSControlTowerExecution" \
    --role-session-name alm-cleanup --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
  (
    export AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST
    zid=$(aws route53 list-hosted-zones-by-name --dns-name "$zone" --query "HostedZones[?Name=='${zone}.'].Id | [0]" --output text)
    zid=${zid##*/}
    if [[ "$zid" == Z* ]]; then
      # 아직 CloudFormation 스택이 관리 중이면(2단계 배포 전) 건드리지 않는다
      owner=$(aws cloudformation describe-stack-resources --physical-resource-id "$zid" --query 'StackResources[0].StackName' --output text 2>/dev/null || true)
      if [[ -n "$owner" && "$owner" != "None" ]]; then
        echo "  영역 ${zid}는 아직 스택 ${owner}가 관리 중 → 건너뜀(2단계 배포 먼저)"
      else
        echo "  옛 영역 ${zid} 삭제 대상"
        aws route53 list-resource-record-sets --hosted-zone-id "$zid" --output json \
          | jq -c --arg z "${zone}." '.ResourceRecordSets[] | select(.Type != "SOA" and !(.Type == "NS" and .Name == $z))' \
          | while read -r rr; do
              echo "  레코드 $(jq -r '.Name + " " + .Type' <<< "$rr")"
              run aws route53 change-resource-record-sets --hosted-zone-id "$zid" --query ChangeInfo.Status --output text \
                --change-batch "{\"Changes\":[{\"Action\":\"DELETE\",\"ResourceRecordSet\":${rr}}]}"
            done
        run aws route53 delete-hosted-zone --id "$zid" --query ChangeInfo.Status --output text
      fi
    else
      echo "  옛 영역 없음"
    fi
    for arn in $(aws acm list-certificates --query "CertificateSummaryList[?ends_with(DomainName, '.${OLD}') || DomainName=='${OLD}'].CertificateArn" --output text); do
      d=$(aws acm describe-certificate --certificate-arn "$arn" --query 'Certificate.[DomainName, length(InUseBy)]' --output text)
      if [[ "$(cut -f2 <<< "$d")" != "0" ]]; then echo "  인증서 $(cut -f1 <<< "$d") 아직 사용 중 → 건너뜀(잠시 뒤 다시 실행)"; continue; fi
      echo "  옛 인증서 $(cut -f1 <<< "$d") 삭제 대상"
      run aws acm delete-certificate --certificate-arn "$arn"
    done
  )
done

echo "=== 관리 계정: ${OLD} 영역의 NS 위임"
PZ=$(aws route53 list-hosted-zones-by-name --dns-name "$OLD" --query "HostedZones[?Name=='${OLD}.'].Id | [0]" --output text); PZ=${PZ##*/}
if [[ "$PZ" == Z* ]]; then
  for zone in "${ZONE[@]}"; do
    rr=$(aws route53 list-resource-record-sets --hosted-zone-id "$PZ" --output json \
      | jq -c --arg z "${zone}." '.ResourceRecordSets[] | select(.Name == $z and .Type == "NS")')
    [[ -n "$rr" ]] || continue
    echo "  위임 ${zone} 삭제 대상"
    run aws route53 change-resource-record-sets --hosted-zone-id "$PZ" --query ChangeInfo.Status --output text \
      --change-batch "{\"Changes\":[{\"Action\":\"DELETE\",\"ResourceRecordSet\":${rr}}]}"
  done
else
  echo "  관리 계정에 ${OLD} 영역 없음"
fi
$APPLY && echo "정리 완료" || echo "확인만 했습니다. 지우려면 --apply를 붙여 다시 실행하세요"

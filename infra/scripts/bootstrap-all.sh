#!/usr/bin/env bash
# 모든 계정·리전 CDK 부트스트랩 (체크리스트 5단계)
# 관리 계정(BSG ALM) 콘솔의 CloudShell에서 실행한다. 저장소가 없어도 된다.
# 멤버 계정은 Control Tower가 만든 AWSControlTowerExecution 역할로 들어가 부트스트랩한다.
set -euo pipefail
CDK="npx -y aws-cdk@2.1145.0"
MGMT=740122273988
TARGETS=(
  "740122273988 us-east-1"            # 관리 (Alm-OrgBaseline)
  "085462181410 us-east-1 us-east-2"  # log-archive (+ 복제본)
  "262325793971 us-east-1"            # backup
  "631237958461 us-east-1"            # alm-shared
  "236501162716 us-east-1"            # alm-dev
  "428477779499 us-east-1"            # alm-qa
  "482545366457 us-east-1 us-east-2"  # alm-prd (+ Dr 키)
  "718468742633 us-east-1"            # identity-dev (중앙 ID 서비스, 3.11)
)
for t in "${TARGETS[@]}"; do
  read -r acct regions <<< "$t"
  if [[ "$acct" != "$MGMT" ]]; then
    creds=$(aws sts assume-role --role-arn "arn:aws:iam::${acct}:role/AWSControlTowerExecution" \
      --role-session-name cdk-bootstrap --query "Credentials.[AccessKeyId,SecretAccessKey,SessionToken]" --output text)
    read -r AK SK ST <<< "$creds"
    export AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST
  fi
  for r in $regions; do
    echo "=== bootstrap ${acct} ${r}"
    $CDK bootstrap "aws://${acct}/${r}" --tags Project=ALM --tags Owner=BSG
  done
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
done
echo "모든 부트스트랩 완료"

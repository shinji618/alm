#!/usr/bin/env bash
# 계정 공통 스택 배포 (체크리스트 5단계 후반). 관리 계정(BSG ALM) CloudShell에서 infra 폴더 안에서 실행한다.
# 멤버 계정은 AWSControlTowerExecution 역할로 들어가 배포한다.
#   Alm-OrgBaseline      관리 계정: 추가 SCP 3개, 권한 세트 4개
#   Alm-LogArchive(+Replica) log-archive: 감사 보관(Object Lock 준수 10년), 로그 버킷
#   Alm-BackupVault      backup: 계정 간 백업 볼트(Vault Lock, 3일 뒤 변경 불가)
#   Alm-Shared           alm-shared: ECR, GitHub OIDC, 빌드 역할
#   Alm-<Env>-Ci         dev·qa·prd: GitHub Actions 배포 역할(나머지 환경 스택은 파이프라인이 배포)
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d node_modules ]] || npm ci --no-audit --no-fund
CDK="npx cdk"
ARGS="--require-approval never --progress events"

assume() {
  read -r AK SK ST <<< "$(aws sts assume-role --role-arn "arn:aws:iam::$1:role/AWSControlTowerExecution" \
    --role-session-name alm-deploy-global --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
  export AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST
}
release() { unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; }
step() { echo; echo "================ $*"; }

step "1/5 관리 계정: Alm-OrgBaseline"
$CDK deploy -c env=global Alm-OrgBaseline $ARGS

step "2/5 log-archive: Alm-LogArchiveReplica, Alm-LogArchive"
assume 085462181410; $CDK deploy -c env=global Alm-LogArchiveReplica Alm-LogArchive $ARGS; release

step "3/5 backup: Alm-BackupVault"
assume 262325793971; $CDK deploy -c env=global Alm-BackupVault $ARGS; release

step "4/5 alm-shared: Alm-Shared"
assume 631237958461; $CDK deploy -c env=global Alm-Shared $ARGS; release

step "5/5 환경별 배포 역할: Alm-Dev-Ci, Alm-Qa-Ci, Alm-Prd-Ci"
assume 236501162716; $CDK deploy -c env=dev Alm-Dev-Ci --exclusively $ARGS; release
assume 428477779499; $CDK deploy -c env=qa Alm-Qa-Ci --exclusively $ARGS; release
assume 482545366457; $CDK deploy -c env=prd Alm-Prd-Ci --exclusively $ARGS; release

echo; echo "계정 공통 스택 배포 완료"

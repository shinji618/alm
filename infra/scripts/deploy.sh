#!/usr/bin/env bash
# 환경 배포(10 정의서 11장). GitHub Actions deploy 작업이 배포 역할(alm-deploy-<env>)로 실행한다.
# 사용: infra/scripts/deploy.sh <dev|qa|prd> <이미지 태그> [웹 빌드 폴더(기본 apps/web/dist)]
#
# 순서
#   1. migrate: 현재 migrate 작업 정의를 새 이미지로 등록 → RunTask → 종료 코드 0 확인. 실패하면 중단
#      (환경 첫 배포라 작업 정의가 아직 없으면 2 다음에 실행)
#   2. cdk deploy --all -c imageTag=<태그>: 인프라 변경 + api·worker 새 작업 정의(회로 차단기 자동 롤백)
#   3. SPA를 웹 버킷에 동기화 → CloudFront /index.html 무효화
# DB 변경은 확장 → 전환 → 정리 순서로만 한다(앱을 되돌려도 DB와 맞게).
set -euo pipefail

ENV=${1:?env}; TAG=${2:?image tag}; WEB_DIR=${3:-apps/web/dist}
case "$ENV" in dev|qa|prd) ;; *) echo "env must be dev|qa|prd" >&2; exit 2;; esac
Env="$(tr '[:lower:]' '[:upper:]' <<< "${ENV:0:1}")${ENV:1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export AWS_REGION=${AWS_REGION:-us-east-1} AWS_DEFAULT_REGION=${AWS_REGION:-us-east-1}

out() {  # out <스택> <출력 키>
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text 2>/dev/null || true
}

run_migrate() {
  local app="Alm-${Env}-App" family cluster sg subnets td image newtd arn code
  family=$(out "$app" MigrateFamily); cluster=$(out "$app" ClusterName)
  sg=$(out "$app" MigrateSecurityGroupId); subnets=$(out "$app" AppSubnetIds)
  td=$(aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json)
  image=$(jq -r '.containerDefinitions[] | select(.name=="app") | .image' <<< "$td")
  image="${image%:*}:${TAG}"
  echo "::group::migrate $family → $image"
  newtd=$(jq --arg img "$image" '.containerDefinitions |= map(if .name=="app" then .image=$img else . end)
    | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)' <<< "$td")
  arn=$(aws ecs register-task-definition --cli-input-json "$newtd" --query taskDefinition.taskDefinitionArn --output text)
  local task
  task=$(aws ecs run-task --cluster "$cluster" --task-definition "$arn" --launch-type FARGATE --started-by "deploy-${TAG:0:20}" \
    --network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${sg}],assignPublicIp=DISABLED}" \
    --query 'tasks[0].taskArn' --output text)
  echo "task: $task"
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
  code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --query 'tasks[0].containers[?name==`app`].exitCode | [0]' --output text)
  aws logs filter-log-events --log-group-name "/alm/${ENV}/migrate" --log-stream-name-prefix "migrate/app/${task##*/}" \
    --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' | tail -50 || true
  echo "::endgroup::"
  if [[ "$code" != "0" ]]; then echo "migrate failed (exit code: $code) — 배포 중단" >&2; exit 1; fi
}

cdk_deploy() {
  echo "::group::cdk deploy ($ENV, imageTag=$TAG)"
  (cd "$ROOT/infra" && npx cdk deploy --all -c env="$ENV" -c imageTag="$TAG" --require-approval never --progress events)
  echo "::endgroup::"
  sync_idps
}

# CloudFormation이 웹·PDA 클라이언트를 갱신하면 IdP 목록이 템플릿 값으로 돌아간다 → 테넌트 IdP(T-*)를 다시 붙인다
sync_idps() {
  local out; out=$(mktemp)
  aws lambda invoke --function-name "alm-${ENV}-cognito-admin" --cli-binary-format raw-in-base64-out \
    --payload '{"action":"syncIdps"}' "$out" >/dev/null
  echo "syncIdps: $(cat "$out")"
  if [[ "$(jq -r .ok "$out")" != "true" ]]; then echo "테넌트 IdP 동기화 실패" >&2; exit 1; fi
}

# 현재 migrate 작업 정의에 마스터 비밀(DB_MASTER_PASSWORD)이 없으면(첫 배포, 자리 이미지 시절 정의) 인프라를 먼저 갱신한다
migrate_ready() {
  local fam; fam=$(out "Alm-${Env}-App" MigrateFamily)
  [[ -n "$fam" && "$fam" != "None" ]] || return 1
  aws ecs describe-task-definition --task-definition "$fam" \
    --query "taskDefinition.containerDefinitions[?name=='app'].secrets[].name" --output text 2>/dev/null | grep -qw DB_MASTER_PASSWORD
}
# DB가 꺼져 있으면(DEV 야간 정지 20:05~06:40 ET) migrate가 접속하지 못해 실패한다 → 먼저 알리고 멈춘다.
# 켜지는 중이면 기다린다. 상태를 못 읽으면(권한 등) 그대로 진행한다
check_db() {
  local st
  st=$(aws rds describe-db-instances --db-instance-identifier "alm-${ENV}" --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo unknown)
  case "$st" in
    available) ;;
    unknown|None) echo "::warning::DB alm-${ENV} 상태를 읽지 못했습니다(배포 역할 rds:DescribeDBInstances 필요 — deploy-global.sh로 Alm-${Env}-Ci 갱신). 그대로 진행합니다" ;;
    stopped|stopping)
      echo "::error::DB alm-${ENV}가 ${st} 상태입니다(DEV 야간 정지 20:05~06:40 ET). 07:00 ET 이후 Re-run 하거나, DB를 켠 뒤(aws rds start-db-instance --db-instance-identifier alm-${ENV}) Re-run 하세요" >&2
      exit 1 ;;
    *) echo "DB alm-${ENV} 상태 ${st}: available까지 기다림"; aws rds wait db-instance-available --db-instance-identifier "alm-${ENV}" ;;
  esac
}
check_db

if migrate_ready; then
  run_migrate
  cdk_deploy
else
  echo "migrate 작업 정의 준비 전: 인프라를 먼저 갱신한다"
  cdk_deploy
  run_migrate
fi

if [[ -d "$ROOT/$WEB_DIR" ]]; then
  bucket=$(out "Alm-${Env}-Edge" WebBucketName); dist=$(out "Alm-${Env}-Edge" DistributionId)
  echo "::group::web → s3://$bucket"
  # 해시가 붙은 정적 파일은 1년 캐시, index.html은 캐시하지 않음. 이전 파일은 지우지 않는다(열려 있는 화면이 옛 파일을 계속 받도록)
  aws s3 sync "$ROOT/$WEB_DIR" "s3://$bucket" --exclude index.html --cache-control 'public,max-age=31536000,immutable'
  aws s3 cp "$ROOT/$WEB_DIR/index.html" "s3://$bucket/index.html" --cache-control 'no-cache'
  aws cloudfront create-invalidation --distribution-id "$dist" --paths /index.html --query Invalidation.Id --output text
  echo "::endgroup::"
else
  echo "웹 빌드 폴더 없음($WEB_DIR) — SPA 배포 건너뜀"
fi
echo "deployed $ENV @ $TAG"

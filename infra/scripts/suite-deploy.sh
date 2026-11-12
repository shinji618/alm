#!/usr/bin/env bash
# 공유 플랫폼(suite)에 ALM 배포(통합 WBS 5.4). GitHub Actions deploy-suite가 배포 역할(suite-alm-deploy-<env>)로 실행한다.
#   infra/scripts/suite-deploy.sh dev <이미지 태그> [웹 빌드 폴더(기본 apps/web/dist, VITE_SUITE=1 빌드)]
# 순서
#   0. 첫 배포: 스택을 서비스 0개로 만든다(작업 정의·보안 그룹이 있어야 migrate를 돌릴 수 있고, 스키마 전에는 api를 띄우지 않는다)
#   1. 플랫폼 초기 설정(확장·설정 권한): ALM DB 소유자는 RDS 마스터가 아니라 pgaudit 확장을 만들 수 없다 → 플랫폼 준비 함수가 대신 한다
#   2. migrate: 새 이미지로 1회 실행(소유자 alm_owner, IAM 인증). 실패하면 중단
#   3. 플랫폼 초기 설정(이벤트 트리거): migrate가 만든 함수에 감사 보호 트리거를 건다. 남은 것(pending)이 있으면 중단
#   4. cdk deploy(api·worker 새 작업 정의, 회로 차단기 자동 롤백)
#   5. 화면을 화면 버킷의 alm/ 접두사에 동기화 → CloudFront /alm/index.html 무효화
# 공유 RDS가 꺼진 시간(DEV 매일 00~07시 ET)에는 1에서 멈춘다. 전용 환경 배포(deploy.sh)와는 따로 돈다.
set -euo pipefail
ENV_NAME=${1:?env(dev)}; TAG=${2:?image tag}; WEB_DIR=${3:-apps/web/dist}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/infra"
Env="$(tr '[:lower:]' '[:upper:]' <<< "${ENV_NAME:0:1}")${ENV_NAME:1}"
STACK="Suite-${Env}-Alm"; APP="npx tsx bin/suite.ts"; PRODUCT=alm
export AWS_REGION=${AWS_REGION:-us-east-1} AWS_DEFAULT_REGION=${AWS_REGION:-us-east-1}
want=$(npx tsx -e "import { SUITE_ENVS } from './lib/suite-config'; console.log(SUITE_ENVS['${ENV_NAME}'].account)")
have=$(aws sts get-caller-identity --query Account --output text)
[[ "$want" == "$have" ]] || { echo "자격 증명 계정(${have})이 suite-${ENV_NAME}(${want})가 아닙니다" >&2; exit 1; }
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text; }
param() { aws ssm get-parameter --name "/suite/${ENV_NAME}/$1" --query Parameter.Value --output text; }
cdk_deploy() { echo "::group::cdk deploy $STACK ($*)"; npx cdk -a "$APP" deploy -c env="$ENV_NAME" -c imageTag="$TAG" "$@" "$STACK" --require-approval never --progress events; echo "::endgroup::"; }

# 플랫폼 준비 함수(pas-suite db-bootstrap): 제품 등록부에 선언된 확장·설정 권한·이벤트 트리거만 관리 계정으로 대신 만든다
privileged_setup() {  # privileged_setup <단계 이름> <pending 허용: yes|no>
  local f; f=$(mktemp)
  aws lambda invoke --function-name "suite-${ENV_NAME}-db-bootstrap" --cli-binary-format raw-in-base64-out \
    --payload "{\"action\":\"privileged-setup\",\"product\":\"${PRODUCT}\"}" "$f" >/dev/null
  echo "플랫폼 초기 설정($1): $(cat "$f")"
  [[ "$(jq -r .ok "$f")" == "true" ]] || { echo "플랫폼 초기 설정 실패 — 공유 RDS가 켜져 있는지(DEV 07~24시 ET), pas-suite가 배포돼 있는지 확인" >&2; exit 1; }
  [[ "$(jq -r .declared "$f")" == "true" ]] || { echo "플랫폼 제품 등록부에 ALM의 DB 초기 설정 선언이 없습니다(pas-suite config.ts PRODUCTS[].db)" >&2; exit 1; }
  if [[ "$2" == "no" && "$(jq -r '.eventTriggers.pending | length' "$f")" != "0" ]]; then
    echo "감사 보호 이벤트 트리거가 만들어지지 않았습니다(pending): $(jq -c .eventTriggers.pending "$f")" >&2; exit 1
  fi
  [[ "$(jq -r '.parameterGrants.failed | length' "$f")" == "0" ]] || echo "::warning::설정 권한 일부 실패(감사 기록 범위): $(jq -c .parameterGrants.failed "$f")"
}

run_migrate() {
  local family cluster sg subnets td image newtd arn task code
  family=$(out MigrateFamily); cluster=$(out ClusterName); sg=$(out MigrateSecurityGroupId); subnets=$(out AppSubnetIds)
  td=$(aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json)
  image=$(jq -r '.containerDefinitions[] | select(.name=="app") | .image' <<< "$td"); image="${image%:*}:${TAG}"
  echo "::group::migrate $family → $image"
  newtd=$(jq --arg img "$image" '.containerDefinitions |= map(if .name=="app" then .image=$img else . end)
    | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)' <<< "$td")
  arn=$(aws ecs register-task-definition --cli-input-json "$newtd" --query taskDefinition.taskDefinitionArn --output text)
  task=$(aws ecs run-task --cluster "$cluster" --task-definition "$arn" --launch-type FARGATE --started-by "deploy-${TAG:0:20}" \
    --network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${sg}],assignPublicIp=DISABLED}" --query 'tasks[0].taskArn' --output text)
  echo "task: $task"
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
  code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --query 'tasks[0].containers[?name==`app`].exitCode | [0]' --output text)
  aws logs filter-log-events --log-group-name "/suite/${ENV_NAME}/${PRODUCT}/migrate" --log-stream-name-prefix "migrate/app/${task##*/}" \
    --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' | tail -50 || true
  echo "::endgroup::"
  [[ "$code" == "0" ]] || { echo "migrate 실패(종료 코드 $code) — 배포 중단" >&2; exit 1; }
}

# 0)
if ! aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
  echo "첫 배포: 서비스 0개로 스택 생성"; cdk_deploy -c desired=0
fi
privileged_setup "확장·설정 권한" yes   # 1)
run_migrate                              # 2)
privileged_setup "이벤트 트리거" no      # 3)
cdk_deploy                               # 4)
# 5) 화면: alm/ 접두사에만 쓴다(배포 역할도 이 경로만 허용). 이전 파일은 지우지 않는다(열려 있는 화면이 옛 파일을 계속 받도록)
if [[ -d "$ROOT/$WEB_DIR" ]]; then
  grep -q '/_suite/shell.js' "$ROOT/$WEB_DIR/index.html" || { echo "웹 빌드가 공유 플랫폼용(VITE_SUITE=1)이 아닙니다: $WEB_DIR/index.html" >&2; exit 1; }
  BUCKET=$(param web-bucket); DIST=$(param app-distribution-id)
  echo "::group::web → s3://$BUCKET/${PRODUCT}/"
  aws s3 sync "$ROOT/$WEB_DIR" "s3://${BUCKET}/${PRODUCT}/" --exclude index.html --cache-control 'public,max-age=31536000,immutable'
  aws s3 cp "$ROOT/$WEB_DIR/index.html" "s3://${BUCKET}/${PRODUCT}/index.html" --cache-control 'no-store'
  aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/${PRODUCT}/index.html" --query Invalidation.Id --output text
  echo "::endgroup::"
else
  echo "웹 빌드 폴더 없음($WEB_DIR) — 화면 배포 건너뜀"
fi
echo "배포 완료: https://$(param app-domain)/${PRODUCT}/  (서비스 $(out ApiServiceName)·$(out WorkerServiceName), 이미지 $TAG)"

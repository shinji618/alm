#!/usr/bin/env bash
# 중앙 ID 서비스 배포(WBS 3.11). identity 계정 자격 증명(SSO DevAdmin 또는 GitHub 배포 역할 id-deploy-<env>)으로 실행한다.
#   bash infra/scripts/identity-deploy.sh dev
# 순서: 서비스 의존성 설치(services/identity) → cdk deploy --all(Dns·Data·Auth·Api·Observability·Ci) → 스키마 적용(함수 migrate) → 상태 확인(/health, /health/db)
# CloudShell 연결이 끊겨도 계속 돌게 하려면: nohup bash infra/scripts/identity-deploy.sh dev > deploy.log 2>&1 &  (tail -f deploy.log)
# 첫 배포는 Aurora 생성(약 10분)·인증서 DNS 검증·Cognito 사용자 지정 도메인(CloudFront, 최대 40분) 때문에 오래 걸린다.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV=${1:?사용: $0 dev|qa|prd}
case "$ENV" in dev|qa|prd) ;; *) echo "env는 dev|qa|prd" >&2; exit 2 ;; esac
Env="$(tr '[:lower:]' '[:upper:]' <<< "${ENV:0:1}")${ENV:1}"
export AWS_REGION=${AWS_REGION:-us-east-1}
[[ -d node_modules ]] || npm ci --no-audit --no-fund
(cd ../services/identity && npm ci --no-audit --no-fund)   # 함수 번들(esbuild)용
want=$(npx tsx -e "import { ID_ENVS } from './lib/identity/config'; console.log(ID_ENVS['${ENV}'].account)")
have=$(aws sts get-caller-identity --query Account --output text)
[[ "$want" == "$have" ]] || { echo "자격 증명 계정(${have})이 identity-${ENV}(${want})가 아닙니다" >&2; exit 1; }

npx cdk -a "npx tsx bin/identity.ts" deploy --all -c env="$ENV" --require-approval never --progress events

fn=$(aws cloudformation describe-stacks --stack-name "Id-${Env}-Api" --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue | [0]" --output text)
echo "=== 스키마 적용 (${fn})"
aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out --cli-read-timeout 120 --payload '{"action":"migrate"}' /tmp/id-migrate.json >/dev/null
echo "migrate: $(cat /tmp/id-migrate.json)"
grep -q '"ok":true' /tmp/id-migrate.json || { echo "스키마 적용 실패" >&2; exit 1; }

url=$(aws cloudformation describe-stacks --stack-name "Id-${Env}-Api" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue | [0]" --output text)
echo "=== 상태 확인 ${url}"
for path in /health /health/db; do
  for i in 1 2 3; do
    code=$(curl -s -o /tmp/id-health.json -w '%{http_code}' --max-time 40 "${url}${path}" || true)
    [[ "$code" == 200 ]] && break; sleep 10
  done
  echo "${path}: ${code} $(cat /tmp/id-health.json 2>/dev/null)"
  [[ "$code" == 200 ]] || { echo "상태 확인 실패: ${path}" >&2; exit 1; }
done
echo "배포 완료: ${url}, 로그인 https://auth.$(sed -E 's#https://##' <<< "$url")"

#!/usr/bin/env bash
# 테넌트·도메인·첫 관리자 등록(런북 13 6장). 관리 계정 CloudShell에서 실행한다. migrate 작업 정의(RDS 마스터 접속)로 `node dist/main seed`를 돌린다.
# 다시 실행해도 같은 결과(이미 있으면 갱신). 관리 화면(3.4 2차) 전까지 쓴다.
#
#   bash db-seed.sh dev '{"tenant":{"code":"TEST","name":"Okta 시험","idpType":"OIDC"},"domains":["example.com"],
#                         "users":[{"email":"me@example.com","displayName":"홍길동","roles":["SYS_ADMIN","ASSET_MANAGER"]}]}'
# SAP 연결(시험용, 7.x 연결 관리 화면 전까지):
#   ... ,"companies":[{"code":"1000","name":"BSG US"}],
#   "sapConnections":[{"systemId":"S4D-100","companyCode":"1000","clientId":"<createSapClient의 clientId>","allowedCidrs":["108.79.59.91/32"]}]
set -euo pipefail
ENV=${1:?dev|qa|prd}; JSON=${2:?seed JSON}
case "$ENV" in
  dev) acct=236501162716 ;;
  qa)  acct=428477779499 ;;
  prd) acct=482545366457 ;;
  *) echo "env는 dev|qa|prd" >&2; exit 2 ;;
esac
jq -e . >/dev/null <<< "$JSON" || { echo "JSON 형식이 아니다(작은따옴표로 감쌌는지 확인)" >&2; exit 2; }
read -r AK SK ST <<< "$(aws sts assume-role --role-arn "arn:aws:iam::${acct}:role/AWSControlTowerExecution" \
  --role-session-name alm-db-seed --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
export AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
Env="$(tr '[:lower:]' '[:upper:]' <<< "${ENV:0:1}")${ENV:1}"
out() { aws cloudformation describe-stacks --stack-name "Alm-${Env}-App" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text; }
family=$(out MigrateFamily); cluster=$(out ClusterName); sg=$(out MigrateSecurityGroupId); subnets=$(out AppSubnetIds)
overrides=$(jq -cn --arg j "$JSON" '{containerOverrides:[{name:"app",command:["node","dist/main","seed",$j]}]}')
task=$(aws ecs run-task --cluster "$cluster" --task-definition "$family" --launch-type FARGATE --started-by db-seed \
  --network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${sg}],assignPublicIp=DISABLED}" \
  --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
echo "task: ${task##*/} (1~2분)"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --query 'tasks[0].containers[?name==`app`].exitCode | [0]' --output text)
aws logs filter-log-events --log-group-name "/alm/${ENV}/migrate" --log-stream-name-prefix "migrate/app/${task##*/}" \
  --query 'events[].message' --output text | tr '\t' '\n' | tail -20
[[ "$code" == "0" ]] && echo "seed 완료" || { echo "seed 실패(exit $code)" >&2; exit 1; }

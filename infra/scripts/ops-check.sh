#!/usr/bin/env bash
# WBS 3.6 운영 확인(관리 계정 CloudShell). DEV·QA는 가동 시간(평일 07~20시 ET)에만 의미가 있다.
#
#   bash ops-check.sh dev status            # 읽기만: 경보 상태, 작업 큐, pgaudit → Firehose → 감사 버킷, RDS 백업
#   bash ops-check.sh dev restore-start     # RDS 복원 시험 1/3: 최신 복원 가능 시점으로 alm-<env>-restore-test 생성(10~20분)
#   bash ops-check.sh dev restore-verify    # 2/3: 생성 완료를 기다린 뒤 원본·복원본에서 같은 질의를 돌려 비교, 걸린 시간 출력
#   bash ops-check.sh dev restore-delete    # 3/3: 복원본 삭제(alm-<env>-restore-test만 지운다)
#
# 복원 시험은 CloudShell이 오래 기다리다 끊기지 않게 세 단계로 나눴다. 시험 인스턴스는 야간 정지 대상이 아니므로 그날 지운다.
set -euo pipefail
ENV=${1:?dev|qa|prd}; CMD=${2:-status}
case "$ENV" in
  dev) acct=236501162716 ;;
  qa)  acct=428477779499 ;;
  prd) acct=482545366457 ;;
  *) echo "env는 dev|qa|prd" >&2; exit 2 ;;
esac
LOG_ARCHIVE=085462181410
AUDIT_BUCKET="alm-audit-archive-${LOG_ARCHIVE}"
DB="alm-${ENV}"; TEST_DB="alm-${ENV}-restore-test"
STATE="$HOME/.alm-restore-${ENV}"          # 복원 시작 시각·복원 시점 기록(걸린 시간 계산용)
Env="$(tr '[:lower:]' '[:upper:]' <<< "${ENV:0:1}")${ENV:1}"

assume() {   # $1 계정, $2 세션 이름 → 현재 셸에 자격 증명 설정
  local AK SK ST
  read -r AK SK ST <<< "$(env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
    aws sts assume-role --role-arn "arn:aws:iam::$1:role/AWSControlTowerExecution" \
    --role-session-name "$2" --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
  export AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
}
ms_ago() { echo $(( ($(date +%s) - $1) * 1000 )); }
iso_ago() { date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%SZ; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
h() { printf '\n== %s ==\n' "$1"; }

db_status() { aws rds describe-db-instances --db-instance-identifier "$1" --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo none; }

# ECS migrate 작업 정의(RDS 마스터 접속)로 읽기 질의를 돌린다. $1 = DB 호스트
run_query() {
  local host=$1 out family cluster sg subnets overrides task code js
  out() { aws cloudformation describe-stacks --stack-name "Alm-${Env}-App" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text; }
  family=$(out MigrateFamily); cluster=$(out ClusterName); sg=$(out MigrateSecurityGroupId); subnets=$(out AppSubnetIds)
  js='const {loadConfig}=require("./dist/config");const {ownerClient}=require("./dist/ops/migrate");
(async()=>{const c=await ownerClient(loadConfig("migrate"));
const r=await c.query(`SELECT current_setting($$server_version$$) AS pg, (SELECT max(version) FROM schema_migrations) AS migration,
 (SELECT count(*) FROM tenant)::int AS tenants, (SELECT count(*) FROM app_user)::int AS users, (SELECT count(*) FROM sap_connection)::int AS sap_connections,
 (SELECT count(*) FROM security_event)::int AS security_events, (SELECT count(*) FROM audit_log)::int AS audit_logs,
 (SELECT max(created_at) FROM security_event) AS last_event`);
console.log("RESULT "+JSON.stringify(r.rows[0]));await c.end();})().catch(e=>{console.error("ERROR "+e.message);process.exit(1);});'
  overrides=$(jq -cn --arg js "$js" --arg host "$host" \
    '{containerOverrides:[{name:"app",command:["node","-e",$js],environment:[{name:"DB_HOST",value:$host}]}]}')
  task=$(aws ecs run-task --cluster "$cluster" --task-definition "$family" --launch-type FARGATE --started-by ops-check \
    --network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${sg}],assignPublicIp=DISABLED}" \
    --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
  code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --query 'tasks[0].containers[?name==`app`].exitCode | [0]' --output text)
  aws logs filter-log-events --log-group-name "/alm/${ENV}/migrate" --log-stream-name-prefix "migrate/app/${task##*/}" \
    --query 'events[].message' --output text | tr '\t' '\n' | grep -E '^(RESULT|ERROR)' | sed 's/^RESULT //' || true
  [[ "$code" == "0" ]] || { echo "질의 실패(exit $code)" >&2; return 1; }
}

status() {
  assume "$acct" alm-ops-check
  h "1. 경보 상태 (alm-${ENV}-*)"
  aws cloudwatch describe-alarms --alarm-name-prefix "alm-${ENV}-" \
    --query 'MetricAlarms[].[StateValue,AlarmName]' --output text | sort | awk '{printf "  %-17s %s\n",$1,$2}'
  aws cloudwatch describe-alarms --alarm-name-prefix "alm-${ENV}-" --query 'MetricAlarms[].StateValue' --output text \
    | tr '\t' '\n' | sort | uniq -c | awk '{printf "  합계 %s: %s\n",$2,$1}'

  h "2. 작업 큐 (jobs-age 경보 근거)"
  local q; q=$(aws sqs get-queue-url --queue-name "alm-${ENV}-jobs" --query QueueUrl --output text)
  aws sqs get-queue-attributes --queue-url "$q" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --query 'Attributes' --output text | awk '{printf "  대기 %s건, 처리 중 %s건\n",$1,$2}'
  echo "  가장 오래된 메시지(초, 최근 1시간 최대): $(aws cloudwatch get-metric-statistics --namespace AWS/SQS \
    --metric-name ApproximateAgeOfOldestMessage --dimensions Name=QueueName,Value="alm-${ENV}-jobs" \
    --start-time "$(iso_ago 3600)" --end-time "$(now_iso)" --period 3600 --statistics Maximum --query 'Datapoints[0].Maximum' --output text)"
  local cluster; cluster=$(aws cloudformation describe-stacks --stack-name "Alm-${Env}-App" --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue | [0]" --output text)
  aws ecs describe-services --cluster "$cluster" --services "$(aws ecs list-services --cluster "$cluster" --query 'serviceArns' --output text | tr '\t' '\n' | grep -i worker | head -1)" \
    --query 'services[0].[serviceName,runningCount,desiredCount]' --output text | awk '{printf "  worker 서비스 %s: 실행 %s / 목표 %s\n",$1,$2,$3}'
  echo "  DLQ 대기: $(aws sqs get-queue-attributes --queue-url "$(aws sqs get-queue-url --queue-name "alm-${ENV}-jobs-dlq" --query QueueUrl --output text)" \
    --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages' --output text)건"

  h "3. pgaudit → Firehose → 감사 버킷 (최근 3일)"
  local lg="/aws/rds/instance/${DB}/postgresql" fname
  # 로그 검색(filter-log-events)은 로그가 많으면 오래 걸려 지표로 본다: 구독 필터가 Firehose로 넘긴 건수
  fname=$(aws logs describe-subscription-filters --log-group-name "$lg" --query 'subscriptionFilters[0].filterName' --output text 2>/dev/null || echo None)
  echo "  구독 필터: ${fname} ($(aws logs describe-subscription-filters --log-group-name "$lg" --query 'subscriptionFilters[0].filterPattern' --output text 2>/dev/null || true))"
  [[ "$fname" != None ]] && echo "  구독 필터 전달(ForwardedLogEvents): $(aws cloudwatch get-metric-statistics --namespace AWS/Logs \
    --metric-name ForwardedLogEvents --dimensions Name=LogGroupName,Value="$lg" Name=DestinationType,Value=Firehose Name=FilterName,Value="$fname" \
    --start-time "$(iso_ago 259200)" --end-time "$(now_iso)" --period 86400 --statistics Sum --query 'sum(Datapoints[].Sum)' --output text)건"
  echo "  Firehose 상태: $(aws firehose describe-delivery-stream --delivery-stream-name "alm-${ENV}-pgaudit" --query 'DeliveryStreamDescription.DeliveryStreamStatus' --output text)"
  for m in IncomingRecords DeliveryToS3.Records DeliveryToS3.Success; do
    local st=Sum; [[ $m == DeliveryToS3.Success ]] && st=Average
    printf '  %-22s %s\n' "$m" "$(aws cloudwatch get-metric-statistics --namespace AWS/Firehose --metric-name "$m" \
      --dimensions Name=DeliveryStreamName,Value="alm-${ENV}-pgaudit" --start-time "$(iso_ago 259200)" --end-time "$(now_iso)" \
      --period 86400 --statistics "$st" --query "Datapoints[].${st}" --output text | tr '\t' ' ')"
  done
  echo "  Firehose 오류 로그(3일): $(aws logs filter-log-events --log-group-name "/alm/${ENV}/firehose-pgaudit" --start-time "$(ms_ago 259200)" \
    --max-items 100 --query 'length(events)' --output text 2>/dev/null || echo 0)건"

  h "4. RDS 백업"
  aws rds describe-db-instances --db-instance-identifier "$DB" \
    --query 'DBInstances[0].[DBInstanceStatus,BackupRetentionPeriod,LatestRestorableTime,PreferredBackupWindow,StorageEncrypted]' --output text \
    | awk '{printf "  상태 %s, 보관 %s일, 최신 복원 가능 %s, 백업 창 %s(UTC), 암호화 %s\n",$1,$2,$3,$4,$5}'
  echo "  자동 스냅샷: $(aws rds describe-db-snapshots --db-instance-identifier "$DB" --snapshot-type automated --query 'length(DBSnapshots)' --output text)개"
  echo "  복원 시험 인스턴스: $(db_status "$TEST_DB")"

  # 감사 버킷은 log-archive 계정에 있다 → 마지막에 계정을 바꿔 목록만 본다
  h "5. 감사 버킷 ${AUDIT_BUCKET}/${ENV}/pgaudit/ (log-archive 계정)"
  assume "$LOG_ARCHIVE" alm-ops-check
  aws s3api list-objects-v2 --bucket "$AUDIT_BUCKET" --prefix "${ENV}/pgaudit/" \
    --query '[length(Contents || `[]`), sort_by(Contents || `[]`, &LastModified)[-1].[Key,LastModified,Size]]' --output json | jq -r \
    '"  객체 \(.[0])개" + (if .[1] then ", 최근 \(.[1][0]) (\(.[1][1]), \(.[1][2]) bytes)" else "" end)'
  echo "  오류 접두사(${ENV}/pgaudit-errors/): $(aws s3api list-objects-v2 --bucket "$AUDIT_BUCKET" --prefix "${ENV}/pgaudit-errors/" --query 'length(Contents || `[]`)' --output text)개"
}

restore_start() {
  assume "$acct" alm-restore-test
  [[ "$(db_status "$DB")" == available ]] || { echo "원본 ${DB}가 available이 아니다(야간·주말 정지 중?)" >&2; exit 1; }
  [[ "$(db_status "$TEST_DB")" == none ]] || { echo "${TEST_DB}가 이미 있다 → restore-verify 또는 restore-delete" >&2; exit 1; }
  local src subnet sgs pg cls lrt
  src=$(aws rds describe-db-instances --db-instance-identifier "$DB" --output json)
  subnet=$(jq -r '.DBInstances[0].DBSubnetGroup.DBSubnetGroupName' <<< "$src")
  sgs=$(jq -r '[.DBInstances[0].VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<< "$src")
  pg=$(jq -r '.DBInstances[0].DBParameterGroups[0].DBParameterGroupName' <<< "$src")
  cls=$(jq -r '.DBInstances[0].DBInstanceClass' <<< "$src")
  lrt=$(jq -r '.DBInstances[0].LatestRestorableTime' <<< "$src")
  # shellcheck disable=SC2086
  aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "$DB" --target-db-instance-identifier "$TEST_DB" \
    --use-latest-restorable-time --db-subnet-group-name "$subnet" --vpc-security-group-ids $sgs --db-parameter-group-name "$pg" \
    --db-instance-class "$cls" --no-multi-az --no-publicly-accessible --no-deletion-protection --copy-tags-to-snapshot \
    --tags Key=alm:purpose,Value=restore-test --query 'DBInstance.DBInstanceStatus' --output text >/dev/null
  printf 'started=%s\nrestore_point=%s\n' "$(date +%s)" "$lrt" > "$STATE"
  echo "복원 시작: ${DB} → ${TEST_DB} (복원 시점 ${lrt}, ${cls}). 10~20분 뒤 restore-verify"
}

restore_verify() {
  assume "$acct" alm-restore-test
  local st; st=$(db_status "$TEST_DB")
  [[ "$st" != none ]] || { echo "${TEST_DB}가 없다 → restore-start 먼저" >&2; exit 1; }
  while [[ "$st" != available ]]; do echo "  $(date +%H:%M:%S) 상태: $st (30초마다 확인, Ctrl+C 후 다시 실행해도 됨)"; sleep 30; st=$(db_status "$TEST_DB"); done
  local started=0 point="?"; [[ -f "$STATE" ]] && { started=$(sed -n 's/^started=//p' "$STATE"); point=$(sed -n 's/^restore_point=//p' "$STATE"); }
  local created; created=$(aws rds describe-db-instances --db-instance-identifier "$TEST_DB" --query 'DBInstances[0].InstanceCreateTime' --output text)
  h "복원 결과"
  echo "  복원 시점: ${point}"
  [[ $started -gt 0 ]] && echo "  시작 $(date -u -d "@$started" +%H:%M:%SZ) → 확인 $(now_iso) (경과 $(( ($(date +%s) - started) / 60 ))분, 인스턴스 생성 ${created})"
  local src_host test_host
  src_host=$(aws rds describe-db-instances --db-instance-identifier "$DB" --query 'DBInstances[0].Endpoint.Address' --output text)
  test_host=$(aws rds describe-db-instances --db-instance-identifier "$TEST_DB" --query 'DBInstances[0].Endpoint.Address' --output text)
  echo "  원본  : $(run_query "$src_host")"
  echo "  복원본: $(run_query "$test_host")"
  echo "  → 마이그레이션 번호·테넌트·사용자·SAP 연결 수가 같고 이벤트 수가 원본 이하이면 정상. 다음: restore-delete"
}

restore_delete() {
  assume "$acct" alm-restore-test
  [[ "$TEST_DB" == *-restore-test ]] || exit 1
  [[ "$(db_status "$TEST_DB")" != none ]] || { echo "${TEST_DB}가 없다(이미 삭제됨)"; exit 0; }
  read -r -p "${TEST_DB}를 삭제한다(최종 스냅샷 없음). 계속하려면 ${TEST_DB} 입력: " ans
  [[ "$ans" == "$TEST_DB" ]] || { echo "취소"; exit 1; }
  aws rds delete-db-instance --db-instance-identifier "$TEST_DB" --skip-final-snapshot --delete-automated-backups \
    --query 'DBInstance.DBInstanceStatus' --output text
  rm -f "$STATE"
  echo "삭제 요청 완료(5~10분 뒤 사라짐)"
}

case "$CMD" in
  status) status ;;
  restore-start) restore_start ;;
  restore-verify) restore_verify ;;
  restore-delete) restore_delete ;;
  *) echo "명령: status | restore-start | restore-verify | restore-delete" >&2; exit 2 ;;
esac

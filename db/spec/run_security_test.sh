#!/usr/bin/env bash
# DB 보안 시험(WBS 2.8): 새 DB에 ddl.sql 적용 → test_security.sql 실행 → 기대 결과와 비교
# 사용: PGHOST=... PGPORT=... PGUSER=postgres ./run_security_test.sh   (슈퍼유저, 빈 클러스터 권장)
# 기대 결과 갱신: UPDATE_EXPECTED=1 ./run_security_test.sh
set -euo pipefail
cd "$(dirname "$0")"
DB=${TEST_DB:-alm_security_test}
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f ../ddl.sql > /dev/null
# 무작위 값(실패 행 내용의 UUID·시각)만 지우고 나머지는 그대로 비교한다
psql -X -d "$DB" -f test_security.sql 2>&1 \
  | sed -E 's/Failing row contains \(.*\)\./Failing row contains (...)./' > test_security.actual
if [[ "${UPDATE_EXPECTED:-0}" == "1" ]]; then
  mv test_security.actual test_security.expected; echo "expected updated"; exit 0
fi
if diff -u test_security.expected test_security.actual; then
  rm -f test_security.actual; echo "DB security test: OK"
else
  echo "DB security test: 결과가 기대와 다릅니다(위 diff). 의도한 변경이면 UPDATE_EXPECTED=1 로 갱신" >&2; exit 1
fi

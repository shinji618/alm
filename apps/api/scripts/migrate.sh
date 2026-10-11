#!/bin/sh
# migrate 작업(ECS 작업 정의 명령 `sh scripts/migrate.sh`). 접속 정보는 환경 변수·ECS 비밀(DB_MASTER_*)에서 온다
exec node dist/main migrate

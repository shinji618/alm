# 자리 이미지(WBS 3.1·3.2): 백엔드(apps/api, 3.4)가 생기기 전까지 ECS 작업이 뜨고
# ALB 상태 확인을 통과하게 한다. 작업 정의의 명령(node dist/main <역할>, sh scripts/migrate.sh)을 그대로 받는다.
FROM public.ecr.aws/docker/library/node:24-alpine
# 실행에는 node만 필요하다. 이미지에 딸려 오는 npm·corepack·yarn은 지운다(번들된 의존성의 취약점이 Trivy 검사를 막음)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY main.js dist/main.js
COPY migrate.sh scripts/migrate.sh
USER 1000
EXPOSE 3000
CMD ["node", "dist/main", "api"]

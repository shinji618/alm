# ALM 백엔드 이미지(WBS 3.4). 빌드 컨텍스트 = 저장소 최상위(api/permissions.json을 함께 넣는다)
#   docker buildx build --platform linux/arm64 -f apps/api/Dockerfile .
# 역할은 ECS 작업 정의의 명령으로 고른다: node dist/main <api|worker|migrate|seed|audit-archive|partman>, sh scripts/migrate.sh

FROM public.ecr.aws/docker/library/node:24-alpine AS build
WORKDIR /src
COPY apps/api/package.json apps/api/package-lock.json apps/api/
RUN cd apps/api && npm ci --ignore-scripts --no-audit --no-fund
COPY api/permissions.json api/permissions.json
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/scripts apps/api/scripts
COPY apps/api/migrations apps/api/migrations
COPY apps/api/src apps/api/src
RUN cd apps/api && npm run build && npm prune --omit=dev --no-audit --no-fund
# RDS 서버 인증서 확인용 CA 묶음(전 리전). 이미지에 넣어 실행 때 외부에서 받지 않는다
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /src/certs/rds-global-bundle.pem
RUN chmod 444 /src/certs/rds-global-bundle.pem && grep -q "BEGIN CERTIFICATE" /src/certs/rds-global-bundle.pem

FROM public.ecr.aws/docker/library/node:24-alpine
# 실행에는 node만 필요하다. 이미지에 딸려 오는 npm·corepack·yarn은 지운다(번들된 의존성의 취약점이 Trivy 검사를 막음)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /src/apps/api/package.json ./
COPY --from=build /src/apps/api/node_modules node_modules
COPY --from=build /src/apps/api/dist dist
COPY --from=build /src/certs certs
COPY apps/api/scripts/migrate.sh scripts/migrate.sh
ARG BUILD_ID=local
ENV NODE_ENV=production BUILD_ID=${BUILD_ID} NODE_OPTIONS=--enable-source-maps
USER 1000
EXPOSE 3000
CMD ["node", "dist/main", "api"]

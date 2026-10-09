# ALM — Asset Lifecycle Manager

BSG America 자산관리시스템 모노레포. 기준 문서: 기능 정의서, SAP 인터페이스 명세서, 화면설계서(UI 스펙·디자인 시스템), 구축 WBS.

## 구조

```text
apps/
  web/                       # React + TypeScript + Vite (웹 화면)
    src/styles/tokens.css    # 디자인 토큰 — 화면설계서 3장
    src/components/ui/       # 공통 컴포넌트 18종 — 화면설계서 4장
    src/components/layout/   # 앱 셸(NavRail, TopBar, ViewHeader) — 화면설계서 2장
    src/lib/                 # 포맷(5.2), 상태→색(5.1), 테마
    src/i18n/                # en / ko
    src/pages/DesignGallery  # /design — 컴포넌트 확인 화면
db/                          # 데이터 모델 원본(spec/spec.py) → schema.prisma, ddl.sql, 보안 SQL
api/                         # API·권한 원본(spec/) → openapi.yaml, permissions.json
# 예정: apps/api (NestJS), apps/pda (Android), infra (AWS CDK), sap (ABAP)
```

## 구현 현황 (2026-10-09)

설계 문서가 확정됐다고 기능이 구현된 것은 아니다. 아래 표가 저장소 기준의 실제 상태다.

| 영역 | 상태 | 근거 |
| --- | --- | --- |
| 웹 공통(토큰·컴포넌트 18종·앱 셸·i18n·테마) | 구현·단위 시험 | `apps/web`, `npm test`, Storybook |
| 웹 업무 화면 13개 | 미착수(빈 화면) | `App.tsx`가 `/design` 외 메뉴를 `Placeholder`로 연결 |
| API 서버(NestJS: 인증·권한 가드·RLS 세션·감사) | 미착수(3.4) | 계약만 있음: `api/openapi.yaml`, `api/permissions.json` |
| DB | 스키마·DDL 생성, 로컬 PostgreSQL 16 시험 | `db/ddl.sql`, `db/spec/test_security.sql` (RDS 미적용) |
| PDA 앱(Android) | 미착수(5.x) | - |
| 인프라(CDK) | 미착수(3.1) | - |
| SAP ABAP | 미착수(7.x) | 착수 전 D-13 BAPI 필드 대조 |

R1 완료 기준은 화면이 아니라 끝까지 이어지는 흐름의 통합 검증(WBS 10.2)이다: 로그인 → 자산 조회·요청 → 승인 → SAP 전기 큐 → SAP 회신, 그리고 PDA 오프라인 실사 → 동기화.

## 실행

```bash
npm install          # 루트에서 1회
npm run dev          # http://localhost:5173  → /design 에서 컴포넌트 확인
npm test             # 단위 테스트
npm run build        # 타입 검사 + 운영 빌드
npm run storybook    # http://localhost:6006  컴포넌트 카탈로그 (light/dark · en/ko 툴바)
npm run build-storybook  # 정적 빌드 → apps/web/storybook-static
```

Node 20 이상.

Storybook 스토리 위치: `src/components/**/*.stories.tsx`, 토큰은 `src/stories/Tokens.stories.tsx`.
새 컴포넌트를 만들면 스토리도 같이 추가합니다. a11y 애드온이 위반을 오류로 표시합니다.

## 규칙

- 색·글꼴·간격은 `tokens.css` 변수만 쓴다. 컴포넌트에 색 값을 직접 쓰지 않는다.
- 새 화면은 `components/ui`의 컴포넌트로 조립한다. 없는 모양이 필요하면 컴포넌트를 추가하고 `/design`에 예시를 넣는다.
- 화면 문구는 `i18n/en.json`, `ko.json`에 키로 넣는다.
- 반려·폐기·최종 승인·실사 종료 등은 `useConfirm()`으로 확인을 받는다(화면설계서 5.5).

## WBS 진행

| WBS | 내용 | 상태 |
| --- | --- | --- |
| 2.5 | 데이터 모델: 테이블 63개, ERD, 테이블 정의서 (`db/`) | 설계 확정 · 코드 생성 |
| 2.6 | API 명세: 엔드포인트 160개(웹 138 · PDA 11 · SAP 11), 수량은 `api/README.md`(생성물) 기준 | 설계 완료(계약) |
| 2.7 | SAP 인터페이스 명세서 v1.0 (산출물 08) | 서명 완료, D-13 대조 대기 |
| 2.8 | 권한·보안: `api/spec/perm.py` → `api/permissions.json`·`x-permission`, `db/spec/security*.sql`, `db/spec/test_security.sql` | 설계 확정 · 코드 생성 |
| 2.9 | AWS 아키텍처 정의서 (산출물 10) | 설계 확정 |
| 3.5 | 프론트 공통: 토큰, 컴포넌트 18종, 앱 셸, 영문·한글(Pretendard), 라이트·다크 + Storybook | 구현 완료(v0.1) |
| 3.1 | AWS 환경 구축(CDK) | 다음 |
| 4.x | 웹 화면 R1 | 예정 |

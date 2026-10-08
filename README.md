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
# 예정: apps/api (NestJS), apps/pda (Android), infra (AWS CDK), sap (ABAP)
```

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
| 2.5 | 데이터 모델: 테이블 63개, ERD, 테이블 정의서 (`db/`) | 완료(v0.2, 2.8 반영) |
| 2.6 | API 명세: 웹 137 · PDA 11 · SAP 11 (`api/openapi.yaml`, OpenAPI 3.1) | 완료(v0.3) |
| 2.8 | 권한·보안: 권한 카탈로그 `api/spec/perm.py` → `api/permissions.json`·`x-permission`, DB 역할·감사 트리거 `db/spec/security*.sql`, 시험 `db/spec/test_security.sql` | 설계 v1.0 |
| 3.5 | 프론트 공통: 토큰, 컴포넌트 18종, 앱 셸, 영문·한글, 라이트·다크 + Storybook(스토리 48개) | 완료(v0.1) |
| 4.x | 웹 화면 R1 | 예정 |

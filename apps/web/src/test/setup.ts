import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import '@/i18n';

// CI 러너는 로컬보다 느리다: findBy·waitFor 기본 1초로는 화면 전환(요청 생성 → 상세 이동·조회)이 가끔 못 끝난다
configure({ asyncUtilTimeout: 5000 });

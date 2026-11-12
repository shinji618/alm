import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/500.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/source-sans-3/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
// 한글: Pretendard Variable, 한글 동적 서브셋(필요한 글자 조각만 내려받음). SIL OFL 1.1
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@/styles/global.css';
import '@/i18n';
import { applyPalette, applyTheme, DEFAULT_PALETTE, getPalettePref, getThemePref } from '@/lib/theme';
import { SUITE } from '@/lib/suite';
import { App } from './App';

applyTheme(getThemePref());
// 공유 플랫폼 모드: 팔레트는 PAS 공통(blue)으로 고정한다(공통 상단바와 같은 색 — 통합 WBS 5.2)
applyPalette(SUITE ? DEFAULT_PALETTE : getPalettePref());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

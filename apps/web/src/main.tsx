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
import { applyTheme, getThemePref } from '@/lib/theme';
import { App } from './App';

applyTheme(getThemePref());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

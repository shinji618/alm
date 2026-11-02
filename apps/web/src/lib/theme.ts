/** 테마: 'system'이면 data-theme 속성을 지워 OS 설정을 따른다. 선택은 이 브라우저에만 저장. */
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'alm.theme';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable: theme still applies for this session */
  }
}

/** 컬러 팔레트: 기본은 'blue'(PAS 공통 브랜드, 포털 @pas/ui-tokens와 같은 값 — 문서 15 §4 결정). 'green'·'black'은 선택 사항. 항상 data-palette 속성을 붙인다. 라이트·다크(data-theme)와는 별개. 선택은 이 브라우저에만 저장. */
export type PalettePref = 'green' | 'blue' | 'black';
const PALETTE_KEY = 'alm.palette';
export const DEFAULT_PALETTE: PalettePref = 'blue';

export function getPalettePref(): PalettePref {
  try {
    const v = localStorage.getItem(PALETTE_KEY);
    return v === 'green' || v === 'blue' || v === 'black' ? v : DEFAULT_PALETTE;
  } catch {
    return DEFAULT_PALETTE;
  }
}

export function applyPalette(pref: PalettePref): void {
  const root = document.documentElement;
  if (pref === 'green') root.removeAttribute('data-palette'); // green은 :root 기본값
  else root.setAttribute('data-palette', pref);
  try {
    if (pref === DEFAULT_PALETTE) localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, pref);
  } catch {
    /* storage unavailable: palette still applies for this session */
  }
}

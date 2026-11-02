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

/** 컬러 팔레트: 'green'(기본)은 data-palette 속성을 지우고, 'blue'·'black'만 속성을 붙인다. 라이트·다크(data-theme)와는 별개. 선택은 이 브라우저에만 저장. */
export type PalettePref = 'green' | 'blue' | 'black';
const PALETTE_KEY = 'alm.palette';

export function getPalettePref(): PalettePref {
  try {
    const v = localStorage.getItem(PALETTE_KEY);
    return v === 'blue' || v === 'black' ? v : 'green';
  } catch {
    return 'green';
  }
}

export function applyPalette(pref: PalettePref): void {
  const root = document.documentElement;
  if (pref === 'green') root.removeAttribute('data-palette');
  else root.setAttribute('data-palette', pref);
  try {
    if (pref === 'green') localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, pref);
  } catch {
    /* storage unavailable: palette still applies for this session */
  }
}

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

/** 컬러 팔레트: 'green'(기본)은 data-palette 속성을 지우고, 'blue'만 속성을 붙인다. 라이트·다크(data-theme)와는 별개. 선택은 이 브라우저에만 저장. */
export type PalettePref = 'green' | 'blue';
const PALETTE_KEY = 'alm.palette';

export function getPalettePref(): PalettePref {
  try {
    return localStorage.getItem(PALETTE_KEY) === 'blue' ? 'blue' : 'green';
  } catch {
    return 'green';
  }
}

export function applyPalette(pref: PalettePref): void {
  const root = document.documentElement;
  if (pref === 'blue') root.setAttribute('data-palette', 'blue');
  else root.removeAttribute('data-palette');
  try {
    if (pref === 'blue') localStorage.setItem(PALETTE_KEY, 'blue');
    else localStorage.removeItem(PALETTE_KEY);
  } catch {
    /* storage unavailable: palette still applies for this session */
  }
}

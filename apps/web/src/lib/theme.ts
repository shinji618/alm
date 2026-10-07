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

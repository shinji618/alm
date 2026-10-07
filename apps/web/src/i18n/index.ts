import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ko from './ko.json';

const KEY = 'alm.lang';
function initialLang(): 'en' | 'ko' {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'en' || v === 'ko') return v;
  } catch {
    /* ignore */
  }
  return 'en';
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ko: { translation: ko } },
  lng: initialLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  showSupportNotice: false,
});

export function setLanguage(lang: 'en' | 'ko'): void {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* ignore */
  }
}

export default i18n;

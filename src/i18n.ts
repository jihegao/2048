import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Locale } from '../shared/types';
import en from './i18n/en.json';
import zhCN from './i18n/zh-CN.json';

const LOCALE_KEY = '2048-platform-locale';

function initialLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_KEY);
  if (stored === 'zh-CN' || stored === 'en') return stored;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
  },
  lng: initialLocale(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  returnNull: false,
});

function syncDocument(locale: string): void {
  const normalized: Locale = locale === 'en' ? 'en' : 'zh-CN';
  document.documentElement.lang = normalized;
  localStorage.setItem(LOCALE_KEY, normalized);
}

syncDocument(i18n.language);
i18n.on('languageChanged', syncDocument);

export async function applyLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
}

export function currentLocale(): Locale {
  return i18n.language === 'en' ? 'en' : 'zh-CN';
}

export default i18n;

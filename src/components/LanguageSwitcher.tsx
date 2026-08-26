import type { Locale } from '../../shared/types';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { currentLocale } from '../i18n';

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { changeLocale } = useAuth();
  const locale = currentLocale();
  const select = (next: Locale) => {
    if (next !== locale) void changeLocale(next);
  };
  return (
    <div
      className={`language-switcher ${compact ? 'language-switcher--compact' : ''}`}
      aria-label={t('a11y.languageSwitcher')}
    >
      <button
        type="button"
        className={locale === 'zh-CN' ? 'is-active' : ''}
        aria-pressed={locale === 'zh-CN'}
        onClick={() => select('zh-CN')}
      >
        {t('common.chinese')}
      </button>
      <button
        type="button"
        className={locale === 'en' ? 'is-active' : ''}
        aria-pressed={locale === 'en'}
        onClick={() => select('en')}
      >
        {t('common.english')}
      </button>
    </div>
  );
}

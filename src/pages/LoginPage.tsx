import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { Alert } from '../components/ui';

export function LoginPage() {
  const { t } = useTranslation();
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (user) return <Navigate to={user.role === 'teacher' ? '/teacher' : '/student'} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const signedIn = await login(loginId, password);
      navigate(signedIn.role === 'teacher' ? '/teacher' : '/student', { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-page__language">
        <LanguageSwitcher />
      </div>
      <section className="login-card">
        <div className="login-card__visual" aria-hidden="true">
          <div className="hero-board">
            {[2, 0, 4, 8, 0, 16, 32, 0, 64, 128, 0, 256, 512, 0, 1024, 2048].map((value, index) => (
              <span key={index} className={`game-tile game-tile--${value || 'empty'}`}>
                {value || ''}
              </span>
            ))}
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <div className="brand brand--login">
            <span className="brand__tile">2048</span>
            <span>{t('common.appName')}</span>
          </div>
          <div>
            <h1>{t('auth.welcome')}</h1>
            <p>{t('auth.subtitle')}</p>
          </div>
          {error ? <Alert message={error} /> : null}
          <label className="field">
            <span>{t('auth.loginId')}</span>
            <input
              name="loginId"
              autoComplete="username"
              required
              maxLength={64}
              placeholder={t('auth.loginIdPlaceholder')}
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('auth.password')}</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              placeholder={t('auth.passwordPlaceholder')}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button button--primary button--large"
            disabled={submitting}
          >
            {submitting ? t('auth.loggingIn') : t('auth.login')}
          </button>
          <small className="login-form__secure">{t('auth.secure')}</small>
        </form>
      </section>
    </main>
  );
}

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { checkLoginCookie, LoginCheckError } from '../lib/login-check';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { BrandMark, MathPattern, PixelMascot } from '../components/BrandArt';
import { Alert } from '../components/ui';

export function LoginPage() {
  const { t } = useTranslation();
  const { user, login, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const pending = useRef(false);
  const mounted = useRef(true);
  const cookieCheck = useRef<Promise<void> | null>(null);
  const [checkError, setCheckError] = useState('');
  useEffect(() => {
    mounted.current = true;
    const checking = checkLoginCookie();
    let active = true;
    cookieCheck.current = checking;
    void checking.catch((reason: unknown) => {
      if (active) setCheckError(reason instanceof LoginCheckError ? reason.code : 'checkUnknown');
    });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  if (user) return <Navigate to={user.role === 'teacher' ? '/teacher' : '/student'} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError('');
    try {
      // Retry failed/unknown checks on explicit submission before sending credentials.
      if (checkError || !cookieCheck.current) cookieCheck.current = checkLoginCookie();
      try {
        await cookieCheck.current;
      } catch (reason) {
        cookieCheck.current = null;
        throw reason;
      }
      if (!mounted.current) return;
      setCheckError('');
      const signedIn = await login(loginId, password);
      if (!mounted.current) return;
      navigate(signedIn.role === 'teacher' ? '/teacher' : '/student', { replace: true });
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof LoginCheckError
            ? t(`auth.${reason.code}`)
            : reason instanceof Error
              ? reason.message
              : String(reason),
        );
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-page__language">
        <LanguageSwitcher />
      </div>
      <section className="login-card">
        <div className="login-card__visual" aria-hidden="true">
          <MathPattern />
          <div className="login-visual-title">
            <BrandMark />
            <strong>2048</strong>
            <span>PLAY · THINK · TEAM UP</span>
          </div>
          <div className="hero-board">
            {[2, 0, 4, 8, 0, 16, 32, 0, 64, 128, 0, 256, 512, 0, 1024, 2048].map((value, index) => (
              <span key={index} className={`game-tile game-tile--${value || 'empty'}`}>
                {value || ''}
              </span>
            ))}
          </div>
          <div className="login-mascots">
            <PixelMascot />
            <span>✦</span>
            <PixelMascot rival />
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <div className="brand brand--login">
            <BrandMark />
            <span>{t('common.appName')}</span>
          </div>
          <div>
            <h1>{t('auth.welcome')}</h1>
            <p>{t('auth.subtitle')}</p>
          </div>
          {searchParams.get('passwordChanged') === '1' ? (
            <Alert message={t('account.changed')} tone="success" />
          ) : null}
          {sessionExpired ? <Alert message={t('auth.sessionExpired')} /> : null}
          {checkError && !error ? <Alert message={t(`auth.${checkError}`)} /> : null}
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

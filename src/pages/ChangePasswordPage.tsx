import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Alert, Card, PageHeader } from '../components/ui';
import { ApiError } from '../lib/api';

export function ChangePasswordPage() {
  const { t } = useTranslation();
  const { changePassword, user } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError(t('account.passwordMismatch'));
      return;
    }
    if (newPassword === currentPassword) {
      setError(t('account.passwordUnchanged'));
      return;
    }

    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      window.location.assign('/login?passwordChanged=1');
    } catch (reason) {
      if (reason instanceof ApiError) {
        const errorKeys: Record<string, string> = {
          CURRENT_PASSWORD_INCORRECT: 'account.currentPasswordIncorrect',
          VALIDATION_ERROR: 'account.invalidPassword',
          LOGIN_RATE_LIMITED: 'account.tooManyAttempts',
          CREDENTIALS_CHANGED: 'account.credentialsChanged',
        };
        setError(t(errorKeys[reason.code] ?? 'account.changeFailed'));
      } else {
        setError(t('account.changeFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader title={t('account.title')} subtitle={t('account.subtitle')} />
      <Card className="account-card">
        <form className="stack-form" onSubmit={submit}>
          {error ? <Alert message={error} /> : null}
          <label className="field">
            <span>{t('account.currentPassword')}</span>
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('account.newPassword')}</span>
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={256}
              aria-describedby="new-password-help"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <small id="new-password-help">{t('account.passwordHelp')}</small>
          </label>
          <label className="field">
            <span>{t('account.confirmPassword')}</span>
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={256}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => navigate(user?.role === 'teacher' ? '/teacher' : '/student')}
            >
              {t('common.cancel')}
            </button>
            <button type="submit" className="button button--primary" disabled={submitting}>
              {submitting ? t('account.changing') : t('account.submit')}
            </button>
          </div>
        </form>
      </Card>
    </>
  );
}

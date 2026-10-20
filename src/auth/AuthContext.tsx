import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Locale, UserSummary } from '../../shared/types';
import { applyLocale, currentLocale } from '../i18n';
import { api, ApiError } from '../lib/api';
import { advanceAuthGeneration, currentAuthGeneration } from '../lib/auth-generation';
import { confirmLoginSession, LoginCheckError } from '../lib/login-check';
import { checkSession } from '../lib/session-check';

interface AuthContextValue {
  user: UserSummary | null;
  loading: boolean;
  sessionExpired: boolean;
  login: (loginId: string, password: string) => Promise<UserSummary>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  changeLocale: (locale: Locale) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const loginPending = useRef(false);
  const [user, setUser] = useState<UserSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  const loadUser = useCallback(async (supersede = true) => {
    if (!supersede && loginPending.current) return;
    const generation = supersede ? advanceAuthGeneration() : currentAuthGeneration();
    try {
      // Confirmed expiration is handled by the API layer. Failed checks must
      // not clear a newer identity or leave an unhandled rejection.
      const response = supersede
        ? await api<{ user: UserSummary | null }>('/api/me', { cache: 'no-store' }).catch(
            () => undefined,
          )
        : await checkSession();
      if (!response || generation !== currentAuthGeneration()) return;

      const loadedUser = response.user;
      // Locale persistence is optional and must not determine authentication.
      try {
        if (loadedUser?.locale) {
          await applyLocale(loadedUser.locale);
        } else if (loadedUser) {
          const locale = currentLocale();
          await fetch('/api/me/locale', {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ locale }),
          });
        }
      } catch {
        /* Authentication remains valid when locale setup fails. */
      }

      if (generation === currentAuthGeneration()) {
        setUser(loadedUser);
        if (loadedUser) setSessionExpired(false);
      }
    } finally {
      if (generation === currentAuthGeneration()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUser();
    const expire = () => {
      advanceAuthGeneration();
      setLoading(false);
      setSessionExpired(true);
      setUser(null);
    };
    const refresh = () => void loadUser(false);
    window.addEventListener('auth:expired', expire);
    window.addEventListener('auth:refresh', refresh);
    return () => {
      window.removeEventListener('auth:expired', expire);
      window.removeEventListener('auth:refresh', refresh);
    };
  }, [loadUser]);

  const login = useCallback(
    async (loginId: string, password: string) => {
      if (loginPending.current) throw new LoginCheckError('superseded');
      loginPending.current = true;
      advanceAuthGeneration();
      const generation = currentAuthGeneration();
      setLoading(true);
      setSessionExpired(false);
      try {
        const response = await api<{ user: UserSummary }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ loginId, password, locale: currentLocale() }),
        });
        if (generation !== currentAuthGeneration()) throw new LoginCheckError('superseded');
        const confirmed = await confirmLoginSession(response.user.id);
        if (generation !== currentAuthGeneration()) throw new LoginCheckError('superseded');
        if (confirmed.locale) await applyLocale(confirmed.locale).catch(() => undefined);
        if (generation !== currentAuthGeneration()) throw new LoginCheckError('superseded');
        setUser(confirmed);
        return confirmed;
      } catch (reason) {
        // Only a definite rejected POST can safely restore an existing session.
        // Unknown POST/confirmation outcomes must not promote another identity.
        if (
          reason instanceof ApiError &&
          reason.status >= 400 &&
          reason.status < 500 &&
          generation === currentAuthGeneration()
        )
          await loadUser();
        throw reason instanceof ApiError || reason instanceof LoginCheckError
          ? reason
          : new LoginCheckError('checkUnknown');
      } finally {
        loginPending.current = false;
        if (generation === currentAuthGeneration()) setLoading(false);
      }
    },
    [loadUser],
  );

  const logout = useCallback(async () => {
    advanceAuthGeneration();
    const generation = currentAuthGeneration();
    await api('/api/auth/logout', { method: 'POST' });
    if (generation !== currentAuthGeneration()) return;
    advanceAuthGeneration();
    setLoading(false);
    setSessionExpired(false);
    setUser(null);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    advanceAuthGeneration();
    const generation = currentAuthGeneration();
    await api('/api/me/password', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (generation !== currentAuthGeneration()) return;
    advanceAuthGeneration();
    setLoading(false);
    setSessionExpired(false);
    setUser(null);
  }, []);

  const changeLocale = useCallback(
    async (locale: Locale) => {
      const generation = currentAuthGeneration();
      await applyLocale(locale);
      if (generation !== currentAuthGeneration()) return;
      if (user) {
        await api('/api/me/locale', { method: 'PATCH', body: JSON.stringify({ locale }) });
        if (generation !== currentAuthGeneration()) return;
        setUser((current) => (current?.id === user.id ? { ...current, locale } : current));
      }
    },
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, sessionExpired, login, logout, changePassword, changeLocale }),
    [user, loading, sessionExpired, login, logout, changePassword, changeLocale],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is missing');
  return context;
}

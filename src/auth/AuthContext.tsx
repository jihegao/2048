import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Locale, UserSummary } from '../../shared/types';
import { applyLocale, currentLocale } from '../i18n';
import { api } from '../lib/api';
import { advanceAuthGeneration, currentAuthGeneration } from '../lib/auth-generation';

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
  const [user, setUser] = useState<UserSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  const loadUser = useCallback(async (supersede = true) => {
    const generation = supersede ? advanceAuthGeneration() : currentAuthGeneration();
    try {
      // Confirmed expiration is handled by the API layer. Failed checks must
      // not clear a newer identity or leave an unhandled rejection.
      const response = await api<{ user: UserSummary | null }>('/api/me').catch(() => undefined);
      if (!response || generation !== currentAuthGeneration()) return;

      let loadedUser = response.user;
      if (loadedUser?.locale) {
        await applyLocale(loadedUser.locale);
      } else if (loadedUser) {
        const locale = currentLocale();
        await api('/api/me/locale', { method: 'PATCH', body: JSON.stringify({ locale }) });
        loadedUser = { ...loadedUser, locale };
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
      advanceAuthGeneration();
      const generation = currentAuthGeneration();
      setLoading(true);
      setSessionExpired(false);
      try {
        const response = await api<{ user: UserSummary }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ loginId, password, locale: currentLocale() }),
        });
        if (generation !== currentAuthGeneration()) return response.user;
        setUser(response.user);
        if (response.user.locale) await applyLocale(response.user.locale);
        return response.user;
      } catch (reason) {
        // The bump above discarded any pending bootstrap check, but the server
        // session may still be valid (e.g. rate-limited or network failure).
        // Re-check it so an existing session is not masked by the failed login.
        if (generation === currentAuthGeneration()) await loadUser();
        throw reason;
      } finally {
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
      await applyLocale(locale);
      if (user) {
        await api('/api/me/locale', { method: 'PATCH', body: JSON.stringify({ locale }) });
        setUser((current) => (current ? { ...current, locale } : current));
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

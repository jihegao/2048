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
import { api } from '../lib/api';

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
  const authGeneration = useRef(0);

  const loadUser = useCallback(async (supersede = true) => {
    const generation = supersede ? ++authGeneration.current : authGeneration.current;
    try {
      const response = await api<{ user: UserSummary | null }>('/api/me');
      if (generation !== authGeneration.current) return;

      let loadedUser = response.user;
      if (loadedUser?.locale) {
        await applyLocale(loadedUser.locale);
      } else if (loadedUser) {
        const locale = currentLocale();
        await api('/api/me/locale', { method: 'PATCH', body: JSON.stringify({ locale }) });
        loadedUser = { ...loadedUser, locale };
      }

      if (generation === authGeneration.current) {
        setUser(loadedUser);
        if (loadedUser) setSessionExpired(false);
      }
    } finally {
      if (generation === authGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUser();
    const expire = () => {
      authGeneration.current += 1;
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
      authGeneration.current += 1;
      const generation = authGeneration.current;
      setLoading(true);
      setSessionExpired(false);
      try {
        const response = await api<{ user: UserSummary }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ loginId, password, locale: currentLocale() }),
        });
        if (generation !== authGeneration.current) return response.user;
        setUser(response.user);
        if (response.user.locale) await applyLocale(response.user.locale);
        return response.user;
      } catch (reason) {
        // The bump above discarded any pending bootstrap check, but the server
        // session may still be valid (e.g. rate-limited or network failure).
        // Re-check it so an existing session is not masked by the failed login.
        if (generation === authGeneration.current) await loadUser();
        throw reason;
      } finally {
        if (generation === authGeneration.current) setLoading(false);
      }
    },
    [loadUser],
  );

  const logout = useCallback(async () => {
    authGeneration.current += 1;
    const generation = authGeneration.current;
    await api('/api/auth/logout', { method: 'POST' });
    if (generation !== authGeneration.current) return;
    authGeneration.current += 1;
    setLoading(false);
    setSessionExpired(false);
    setUser(null);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    authGeneration.current += 1;
    const generation = authGeneration.current;
    await api('/api/me/password', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (generation !== authGeneration.current) return;
    authGeneration.current += 1;
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

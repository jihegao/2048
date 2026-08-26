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

interface AuthContextValue {
  user: UserSummary | null;
  loading: boolean;
  login: (loginId: string, password: string) => Promise<UserSummary>;
  logout: () => Promise<void>;
  changeLocale: (locale: Locale) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    try {
      const response = await api<{ user: UserSummary | null }>('/api/me');
      setUser(response.user);
      if (response.user?.locale) {
        await applyLocale(response.user.locale);
      } else if (response.user) {
        const locale = currentLocale();
        await api('/api/me/locale', { method: 'PATCH', body: JSON.stringify({ locale }) });
        setUser({ ...response.user, locale });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUser();
    const expire = () => setUser(null);
    window.addEventListener('auth:expired', expire);
    return () => window.removeEventListener('auth:expired', expire);
  }, [loadUser]);

  const login = useCallback(async (loginId: string, password: string) => {
    const response = await api<{ user: UserSummary }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ loginId, password, locale: currentLocale() }),
    });
    setUser(response.user);
    if (response.user.locale) await applyLocale(response.user.locale);
    return response.user;
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
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
    () => ({ user, loading, login, logout, changeLocale }),
    [user, loading, login, logout, changeLocale],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is missing');
  return context;
}

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export function useApiData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError('');
    try {
      setData(await api<T>(path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    queueMicrotask(() => void reload());
  }, [reload]);

  return { data, setData, loading, error, reload };
}

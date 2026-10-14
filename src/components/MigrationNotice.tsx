import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { Alert } from './ui';

export function MigrationNotice() {
  const { t } = useTranslation();
  const [draining, setDraining] = useState(false);
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      try {
        const status = await api<{ mode: string }>('/api/migration-status');
        if (!disposed) setDraining(status.mode === 'drain');
      } catch {
        // A transient status failure never resets or discards an existing game.
      }
    };
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  return draining ? <Alert message={t('migration.finishAndSave')} tone="info" /> : null;
}

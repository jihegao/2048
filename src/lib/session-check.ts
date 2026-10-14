import type { UserSummary } from '../../shared/types';
import { currentAuthGeneration } from './auth-generation';

// Allow a slow replacement login to install its cookie before expiring auth.
const revalidationDelays = [0, 1_000, 3_000, 6_000, 10_000] as const;
const requestTimeoutMs = 60_000;

export async function checkSession(
  cancelled: () => boolean = () => false,
): Promise<{ user: UserSummary | null } | undefined> {
  const generation = currentAuthGeneration();
  const stale = () => cancelled() || generation !== currentAuthGeneration();
  for (const delay of revalidationDelays) {
    if (stale()) return;
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (stale()) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch('/api/me', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (stale()) return;
      if (!response.ok && response.status !== 401) return;
      const payload = response.ok
        ? ((await response.json()) as { user: UserSummary | null })
        : { user: null };
      if (stale()) return;
      if (payload?.user) return payload;
      // A malformed response, timeout or network error cannot prove expiration.
      if (payload?.user !== null) return;
    } catch {
      return;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!stale()) return { user: null };
}

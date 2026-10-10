import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceAuthGeneration } from '../../src/lib/auth-generation';
import { checkSession } from '../../src/lib/session-check';

const user = { id: 'student-1', role: 'student', locale: 'zh-CN' };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('session checks on a slow network', () => {
  for (const status of [200, 401]) {
    it(`keeps waiting when the session is initially absent (HTTP ${status})`, async () => {
      const fetch = vi.fn().mockImplementation(async () => json({ user }));
      fetch.mockResolvedValueOnce(json({ user: null }, status));
      fetch.mockResolvedValueOnce(json({ user: null }, status));
      fetch.mockResolvedValueOnce(json({ user: null }, status));
      vi.stubGlobal('fetch', fetch);

      const checking = checkSession();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetch).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(await checking).toEqual({ user });
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(fetch.mock.calls[0][1]).toMatchObject({
        credentials: 'same-origin',
        cache: 'no-store',
      });
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('confirms expiration only after the entire 20 second retry window', async () => {
    const fetch = vi.fn(async () => json({ user: null }));
    vi.stubGlobal('fetch', fetch);
    let settled = false;
    const checking = checkSession().then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(await checking).toEqual({ user: null });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a response taking 45 seconds without expiring the session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () => new Promise<Response>((resolve) => setTimeout(() => resolve(json({ user })), 45_000)),
      ),
    );
    const checking = checkSession();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await checking).toEqual({ user });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a 60 second request timeout as inconclusive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(new Error('Request timed out')));
          }),
      ),
    );
    const checking = checkSession();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await checking).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const failure of ['network', 'server', 'malformed']) {
    it(`does not expire a session on a ${failure} failure during retry`, async () => {
      const fetch = vi.fn().mockResolvedValueOnce(json({ user: null }));
      if (failure === 'network') fetch.mockRejectedValueOnce(new Error('Network unavailable'));
      else fetch.mockResolvedValueOnce(json({}, failure === 'server' ? 503 : 200));
      vi.stubGlobal('fetch', fetch);
      const checking = checkSession();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await checking).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  for (const change of ['login', 'unmount']) {
    it(`discards a pending retry after ${change}`, async () => {
      const fetch = vi.fn(async () => json({ user: null }));
      vi.stubGlobal('fetch', fetch);
      let stopped = false;
      const checking = checkSession(() => stopped);
      await vi.advanceTimersByTimeAsync(500);
      if (change === 'login') advanceAuthGeneration();
      else stopped = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(await checking).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  it('ignores a slow response from before a new login', async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const checking = checkSession();
    advanceAuthGeneration();
    release(json({ user: null }));
    expect(await checking).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

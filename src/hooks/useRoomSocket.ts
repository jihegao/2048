import { useCallback, useEffect, useRef, useState } from 'react';
import { SESSION_REPLACED_CLOSE_CODE } from '../../shared/types';

const sessionRevalidationDelays = [0, 100, 250, 500] as const;

export function useRoomSocket<T>(roomId: string, onState: (state: T) => void) {
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const stateHandler = useRef(onState);
  useEffect(() => {
    stateHandler.current = onState;
  }, [onState]);

  useEffect(() => {
    if (!roomId) return;
    let stopped = false;
    let revalidatingSession = false;
    let retryTimer: number | undefined;
    let retryCount = 0;
    const scheduleReconnect = (delay?: number) => {
      if (stopped) return;
      retryCount += 1;
      setAttempt((value) => value + 1);
      retryTimer = window.setTimeout(connect, delay ?? Math.min(5000, 500 * 2 ** retryCount));
    };
    const revalidateSession = async (reconnectDelay?: number) => {
      if (stopped || revalidatingSession) return;
      revalidatingSession = true;
      try {
        for (const delay of sessionRevalidationDelays) {
          if (delay > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, delay));
          }
          if (stopped) return;
          const response = await fetch('/api/me', { credentials: 'same-origin' });
          if (stopped) return;
          if (response.status !== 401 && !response.ok) {
            throw new Error(`Session revalidation failed with HTTP ${response.status}`);
          }
          const payload = response.ok ? ((await response.json()) as { user?: unknown }) : null;
          if (stopped) return;
          if (payload?.user) {
            window.dispatchEvent(new Event('auth:refresh'));
            scheduleReconnect(reconnectDelay);
            return;
          }
        }
        stopped = true;
        window.dispatchEvent(new Event('auth:expired'));
      } catch {
        // An ambiguous network failure is handled like an ordinary disconnect.
        scheduleReconnect();
      } finally {
        revalidatingSession = false;
      }
    };
    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/rooms/${roomId}/ws`);
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        retryCount = 0;
        setConnected(true);
      });
      socket.addEventListener('message', (event) => {
        try {
          stateHandler.current(JSON.parse(String(event.data)) as T);
        } catch {
          // Ignore malformed frames; the next authoritative snapshot repairs state.
        }
      });
      socket.addEventListener('close', (event) => {
        setConnected(false);
        if (event.code === SESSION_REPLACED_CLOSE_CODE) {
          // Another tab may already have installed the replacement cookie.
          // Revalidate browser auth before turning this socket-specific close
          // into a browser-wide logout.
          void revalidateSession(0);
          return;
        }
        if (event.code === 1006) {
          // A rejected WebSocket handshake hides its HTTP status from browser
          // code, so use the normal HTTP session endpoint to distinguish an
          // expired cookie from a transient network failure.
          void revalidateSession();
          return;
        }
        if (stopped) return;
        scheduleReconnect();
      });
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socketRef.current?.close(1000);
      socketRef.current = null;
    };
  }, [roomId]);

  const send = useCallback((value: unknown) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(value));
      return true;
    }
    return false;
  }, []);

  return { connected, attempt, send };
}

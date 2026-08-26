import { useCallback, useEffect, useRef, useState } from 'react';

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
    let retryTimer: number | undefined;
    let retryCount = 0;
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
      socket.addEventListener('close', () => {
        setConnected(false);
        if (stopped) return;
        retryCount += 1;
        setAttempt((value) => value + 1);
        retryTimer = window.setTimeout(connect, Math.min(5000, 500 * 2 ** retryCount));
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

import { useCallback, useEffect, useRef, useState } from 'react';

export function useFullscreen() {
  const elementRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const setRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
  }, []);

  useEffect(() => {
    const syncState = () => {
      setIsFullscreen(document.fullscreenElement === elementRef.current);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isFullscreen) return;
      event.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setIsFullscreen(false);
    };
    document.addEventListener('fullscreenchange', syncState);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', syncState);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreen]);

  const toggle = useCallback(async () => {
    const element = elementRef.current;
    if (!element) return;

    if (document.fullscreenElement === element) {
      try {
        await document.exitFullscreen();
      } catch {
        setIsFullscreen(false);
      }
      return;
    }

    if (isFullscreen && !document.fullscreenElement) {
      setIsFullscreen(false);
      return;
    }

    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      await element.requestFullscreen();
    } catch {
      setIsFullscreen(true);
    }
  }, [isFullscreen]);

  return { ref: setRef, isFullscreen, toggle };
}

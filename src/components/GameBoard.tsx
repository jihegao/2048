import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Direction, GameSnapshot } from '../../shared/types';

const KEY_DIRECTIONS: Record<string, Direction | undefined> = {
  ArrowUp: 'up',
  w: 'up',
  W: 'up',
  ArrowDown: 'down',
  s: 'down',
  S: 'down',
  ArrowLeft: 'left',
  a: 'left',
  A: 'left',
  ArrowRight: 'right',
  d: 'right',
  D: 'right',
};

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  cancelled: boolean;
}

export function GameBoard({
  game,
  onMove,
  disabled = false,
  compact = false,
}: {
  game: GameSnapshot;
  onMove?: (direction: Direction) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Set<number>());

  useEffect(() => {
    if (!onMove || disabled || navigator.maxTouchPoints > 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = KEY_DIRECTIONS[event.key];
      if (!direction || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      onMove(direction);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [disabled, onMove]);

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!onMove || disabled || !event.isPrimary) {
      if (gesture.current) gesture.current.cancelled = true;
      return;
    }
    pointers.current.add(event.pointerId);
    if (pointers.current.size > 1 || gesture.current) {
      if (gesture.current) gesture.current.cancelled = true;
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A browser may end the pointer between dispatch and capture; gesture tracking still works.
    }
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cancelled: false,
    };
  };

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    pointers.current.delete(event.pointerId);
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (cancelled || active.cancelled || !onMove || disabled) return;
    const deltaX = event.clientX - active.startX;
    const deltaY = event.clientY - active.startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    if (Math.max(absX, absY) < 24) return;
    if (absX > absY * 1.2) onMove(deltaX > 0 ? 'right' : 'left');
    else if (absY > absX * 1.2) onMove(deltaY > 0 ? 'down' : 'up');
  };

  return (
    <div
      className={`game-board ${compact ? 'game-board--compact' : ''} ${disabled ? 'is-disabled' : ''}`}
      role="grid"
      aria-label={t('a11y.gameBoard')}
      onPointerDown={pointerDown}
      onPointerUp={(event) => finishPointer(event)}
      onPointerCancel={(event) => finishPointer(event, true)}
      onLostPointerCapture={(event) => {
        if (gesture.current?.pointerId === event.pointerId) finishPointer(event, true);
      }}
    >
      {game.board.map((value, index) => {
        const row = Math.floor(index / 4) + 1;
        const column = (index % 4) + 1;
        return (
          <div
            key={index}
            className={`game-tile game-tile--${value || 'empty'}`}
            role="gridcell"
            aria-label={value ? t('a11y.tile', { value, row, column }) : undefined}
            aria-hidden={value === 0}
          >
            {value || ''}
          </div>
        );
      })}
    </div>
  );
}

export type GameClockTone = 'countdown' | 'live' | 'warning' | 'ended' | 'idle';

export function GameStatusBar({
  score,
  scoreLabel,
  time,
  timeLabel,
  timeTone,
}: {
  score: string;
  scoreLabel: string;
  time: string;
  timeLabel: string;
  timeTone: GameClockTone;
}) {
  return (
    <div
      className="game-statusbar"
      role="group"
      aria-label={`${scoreLabel} ${score}; ${timeLabel} ${time}`}
    >
      <strong aria-label={`${scoreLabel} ${score}`}>{score}</strong>
      <span aria-hidden="true" />
      <strong
        className={`game-statusbar__time game-statusbar__time--${timeTone}`}
        role="timer"
        aria-label={`${timeLabel} ${time}`}
      >
        {time}
      </strong>
    </div>
  );
}

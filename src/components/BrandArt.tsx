/** Shared decorative marks from the team-match visual language. */
export function BrandMark() {
  return <img className="brand-mark" src="/brand.svg" alt="2048" width="96" height="96" />;
}

export function PixelMascot({ rival = false }: { rival?: boolean }) {
  const rows = [
    '...XXXXX...',
    '...X...X...',
    '...X.X.X...',
    '...XXXXX...',
    '.X.XXXXX.X.',
    'XX.XXXXX.XX',
    '...XXXXX...',
    '....XXX....',
    '...XX.XX...',
    '..XX...XX..',
  ];
  return (
    <svg
      className={`pixel-mascot ${rival ? 'pixel-mascot--rival' : ''}`}
      viewBox="0 0 110 100"
      aria-hidden="true"
    >
      {rows.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === 'X' ? (
            <rect key={`${x}-${y}`} x={x * 10} y={y * 10} width="10" height="10" />
          ) : null,
        ),
      )}
    </svg>
  );
}

export function MathPattern() {
  return (
    <div className="math-pattern" aria-hidden="true">
      {['π', '÷', 'log', '×', '≠', 'α', '∑', '+', '√'].map((symbol, i) => (
        <span key={i}>{symbol}</span>
      ))}
    </div>
  );
}

/** A bounded common scale: 0 points → design Y=1000; 16384+ → Y=400. */
export const livePillarScoreLimit = 16_384;

export function scorePillarHeight(score: number): number {
  if (!Number.isFinite(score)) return score > 0 ? 100 : 0;
  return Math.sqrt(Math.min(livePillarScoreLimit, Math.max(0, score)) / livePillarScoreLimit) * 100;
}

export function shortTeamName(name: string): string {
  const characters = Array.from(name);
  return characters.length > 10 ? `${characters.slice(0, 9).join('')}…` : name;
}

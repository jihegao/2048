import { describe, expect, it } from 'vitest';
import { scorePillarHeight, shortTeamName } from '../../src/lib/live-score';

describe('live score display', () => {
  it('uses the same monotonic bounded scale for both teams', () => {
    const scores = [0, 60, 1024, 4096, 8192, 16384, 999999];
    const heights = scores.map(scorePillarHeight);
    expect(heights[0]).toBe(0);
    expect(heights[3]).toBe(50);
    expect(heights.at(-1)).toBe(100);
    expect(heights.every((height, index) => !index || height >= heights[index - 1])).toBe(true);
    expect(scorePillarHeight(-1)).toBe(0);
    expect(scorePillarHeight(NaN)).toBe(0);
  });
  it('limits the visual team name without splitting Unicode characters', () => {
    expect(shortTeamName('计算狂魔队')).toBe('计算狂魔队');
    expect(shortTeamName('😀一二三四五六')).toBe('😀一二三四…');
  });
});

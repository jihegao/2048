import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildOfflineTournamentZip } from '../../src/lib/offline-export';

describe('offline tournament bundle', () => {
  it('packages actual logos once, both versions, a classic directory script, and legacy glyphs', async () => {
    const requested: string[] = [];
    const bytes = await buildOfflineTournamentZip(
      {
        version: 1,
        exportedAt: '2026-10-09T00:00:00.000Z',
        teams: [
          { id: 'one', name: '计算狂魔队', logo: 'icon1' },
          { id: 'two', name: '另一队', logo: 'icon1' },
          { id: 'old', name: '</script>旧队', logo: 'tiger' },
          { id: 'unsafe', name: '无图标队', logo: '../private' },
        ],
      },
      async (path) => {
        requested.push(path);
        return new TextEncoder().encode(path).buffer;
      },
    );
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('8-teams.html')).not.toBeNull();
    expect(zip.file('4-teams.html')).not.toBeNull();
    expect(zip.file('fonts/Silkscreen-Regular.ttf')).not.toBeNull();
    expect(await zip.file('teams/logos/icon1.svg')!.async('text')).toBe('/team-logos/icon1.svg');
    expect(requested.filter((path) => path === '/team-logos/icon1.svg')).toHaveLength(1);
    expect(requested.some((path) => path.includes('private'))).toBe(false);
    const manifest = JSON.parse(await zip.file('teams/teams.json')!.async('text'));
    expect(manifest.teams[0]).toMatchObject({ name: '计算狂魔队', logo: 'teams/logos/icon1.svg' });
    expect(manifest.teams[2]).toMatchObject({ logo: null, glyph: '🐯' });
    const script = await zip.file('teams/teams.js')!.async('text');
    expect(script).toContain('window.TOURNAMENT_TEAMS = ');
    expect(script).not.toContain('</script>');
    expect(script).toContain('\\u003c/script>');
  });
});

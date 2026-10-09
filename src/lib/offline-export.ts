import type { OfflineTeamDirectory } from '../../shared/offline-teams';
import { teamLogoAsset, teamLogoGlyph } from '../../shared/types';
import { api } from './api';

const offlineFiles = [
  'index.html',
  '8-teams.html',
  '4-teams.html',
  'bracket.js',
  'bracket-model.js',
  'bracket.css',
  'brand.svg',
  'fonts/Silkscreen-Regular.ttf',
  'fonts/OFL.txt',
  'README.txt',
] as const;

async function loadAsset(path: string): Promise<ArrayBuffer> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  if (response.headers.get('content-type')?.includes('text/html') && !path.endsWith('.html')) {
    throw new Error(`Missing offline asset: ${path}`);
  }
  return response.arrayBuffer();
}

export async function buildOfflineTournamentZip(
  directory: OfflineTeamDirectory,
  readAsset: (path: string) => Promise<ArrayBuffer> = loadAsset,
): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  await Promise.all(
    offlineFiles.map(async (path) => zip.file(path, await readAsset(`/offline/${path}`))),
  );
  const logos = new Set(
    directory.teams.flatMap((team) => {
      const source = teamLogoAsset(team.logo);
      return source ? [source] : [];
    }),
  );
  await Promise.all(
    [...logos].map(async (source) =>
      zip.file(`teams/logos/${source.split('/').pop()}`, await readAsset(source)),
    ),
  );
  const teams = directory.teams.map((team) => ({
    id: team.id,
    name: team.name,
    logoId: team.logo,
    logo: teamLogoAsset(team.logo) ? `teams/logos/${team.logo}.svg` : null,
    glyph: teamLogoAsset(team.logo) ? null : teamLogoGlyph(team.logo),
  }));
  // A classic local script works when HTML is opened with file://, without fetch or a server.
  const json = JSON.stringify({ ...directory, teams })
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  zip.file('teams/teams.js', `window.TOURNAMENT_TEAMS = ${json};\n`);
  zip.file('teams/teams.json', JSON.stringify({ ...directory, teams }, null, 2));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function downloadOfflineTournament(): Promise<void> {
  const directory = await api<OfflineTeamDirectory>('/api/teacher/teams/export');
  const bytes = await buildOfflineTournamentZip(directory);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `2048-knockout-${directory.exportedAt.slice(0, 10)}.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

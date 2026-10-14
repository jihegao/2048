export interface OfflineTeamRecord {
  id: string;
  name: string;
  logo: string | null;
}

export interface OfflineTeamDirectory {
  version: 1;
  exportedAt: string;
  teams: OfflineTeamRecord[];
}

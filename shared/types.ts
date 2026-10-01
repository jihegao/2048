export const locales = ['zh-CN', 'en'] as const;
export type Locale = (typeof locales)[number];

export const roles = ['teacher', 'student'] as const;
export type Role = (typeof roles)[number];

export const SESSION_REPLACED_CLOSE_CODE = 4001;

export const gradeLevels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type GradeLevel = (typeof gradeLevels)[number];
export type GradeLabel = GradeLevel | string;

export const roomModes = ['duel', 'team_3v3'] as const;
export type RoomMode = (typeof roomModes)[number];

export const roomPurposes = ['official', 'friendly'] as const;
export type RoomPurpose = (typeof roomPurposes)[number];

export const roomStatuses = ['open', 'full', 'countdown', 'live', 'ended', 'cancelled'] as const;
export type RoomStatus = (typeof roomStatuses)[number];

export const directions = ['up', 'down', 'left', 'right'] as const;
export type Direction = (typeof directions)[number];

export type GameStatus = 'playing' | 'over';

export interface GameSnapshot {
  board: number[];
  score: number;
  maxTile: number;
  maxTileReachedAt: number;
  moveCount: number;
  rngState: number;
  seq: number;
  status: GameStatus;
}

export interface UserSummary {
  id: string;
  loginId: string;
  studentNumber: string;
  name: string;
  className: string | null;
  gradeLevel: GradeLabel | null;
  role: Role;
  locale: Locale | null;
}

export type MatchOutcome = 'win' | 'loss' | 'draw';

export interface PersonalResultsSummary {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
}

export interface PersonalBestPracticeResult {
  id: string;
  score: number;
  maxTile: number;
  validMoveCount: number;
  occurredAt: string;
}

export interface PersonalTimedPracticeResult extends PersonalBestPracticeResult {
  mode: 'timed_3m';
  durationSeconds: 180;
  startedAt: string;
  deadlineAt: string;
  endReason: 'time_limit' | 'game_over';
}

export interface MaskedStudentIdentity {
  className: string;
  maskedName: string;
  studentNumberSuffix: string;
}

export interface PersonalDuelResult {
  roomId: string;
  roomName: string;
  occurredAt: string;
  outcome: MatchOutcome;
  points: number;
  opponent: MaskedStudentIdentity | null;
}

export interface PersonalTeamMatchResult {
  roomId: string;
  roomName: string;
  occurredAt: string;
  outcome: MatchOutcome;
  points: number;
  team: { id: string; name: string } | null;
  opponentTeam: { id: string; name: string } | null;
}

export interface PersonalResultsPeriod<T> {
  period: LeaderboardPeriod;
  summary: PersonalResultsSummary;
  items: T[];
}

export interface PersonalResultsCategory<T> {
  history: {
    summary: PersonalResultsSummary;
    items: T[];
  };
  currentPeriod: PersonalResultsPeriod<T> | null;
}

export interface PersonalResultsResponse {
  totalCount: number;
  practiceBest: PersonalBestPracticeResult[];
  timedPracticeBest: PersonalTimedPracticeResult[];
  duel: PersonalResultsCategory<PersonalDuelResult>;
  team: PersonalResultsCategory<PersonalTeamMatchResult>;
}

export type LeaderboardPeriodStatus = 'upcoming' | 'active' | 'ended';

export interface LeaderboardPeriod {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  status: LeaderboardPeriodStatus;
}

export interface StudentPracticeLeaderboardEntry {
  rank: number;
  className: string;
  maskedName: string;
  studentNumberSuffix: string;
  score: number;
  gameCount: number;
  maxTile: number | null;
  isCurrentUser: boolean;
}

export interface StudentPracticeLeaderboardBoard {
  status: 'available';
  gradeLevel: GradeLabel | null;
  participantCount: number;
  currentUserRank: number | null;
  entries: StudentPracticeLeaderboardEntry[];
}

export interface StudentPracticeLeaderboardResponse {
  status: 'available';
  mode: 'unlimited' | 'timed_3m';
  period: LeaderboardPeriod;
  overall: StudentPracticeLeaderboardBoard;
  grade:
    | StudentPracticeLeaderboardBoard
    | {
        status: 'grade_missing';
        gradeLevel: null;
        participantCount: 0;
        currentUserRank: null;
        entries: [];
      };
}

export interface StudentPracticeLeaderboardUnavailableResponse {
  status: 'no_active_period';
  mode: 'unlimited' | 'timed_3m';
  period: null;
  overall: null;
  grade: null;
}

export interface TeacherPracticeLeaderboardEntry {
  rank: number;
  studentId: string;
  studentNumber: string;
  name: string;
  className: string;
  gradeLevel: GradeLabel | null;
  gradeSource: 'completion';
  score: number;
  gameCount: number;
  maxTile: number | null;
  validMoveCount: number | null;
  endedAt: string | null;
}

export interface TeacherPracticeLeaderboardResponse {
  mode: 'unlimited' | 'timed_3m';
  period: LeaderboardPeriod;
  gradeLevel: GradeLabel | null;
  participantCount: number;
  entries: TeacherPracticeLeaderboardEntry[];
}

export const presetTeamLogos = [
  { id: 'lion', glyph: '🦁' },
  { id: 'tiger', glyph: '🐯' },
  { id: 'dragon', glyph: '🐲' },
  { id: 'eagle', glyph: '🦅' },
  { id: 'wolf', glyph: '🐺' },
  { id: 'shark', glyph: '🦈' },
  { id: 'owl', glyph: '🦉' },
  { id: 'panda', glyph: '🐼' },
  { id: 'fox', glyph: '🦊' },
  { id: 'turtle', glyph: '🐢' },
  { id: 'whale', glyph: '🐳' },
  { id: 'rocket', glyph: '🚀' },
] as const;

export type TeamLogoId = (typeof presetTeamLogos)[number]['id'];

export const defaultTeamLogoId: TeamLogoId = 'lion';

export function teamLogoGlyph(logo: string | null | undefined): string {
  const found = presetTeamLogos.find((candidate) => candidate.id === logo);
  if (found) return found.glyph;
  return presetTeamLogos.find((candidate) => candidate.id === defaultTeamLogoId)!.glyph;
}

export interface TeamSummary {
  id: string;
  name: string;
  code: string;
  logo: TeamLogoId | null;
  creatorId: string | null;
  isOwner: boolean;
  members: UserSummary[];
  frozen: boolean;
}

export interface RoomSummary {
  id: string;
  code: string;
  name: string;
  mode: RoomMode;
  durationMinutes: number;
  status: RoomStatus;
  isParticipant: boolean;
  participantCount: number;
  participantCapacity: number;
  lockedAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  createdBy?: string;
  creatorTeamId?: string | null;
  isCreatorTeamMember?: boolean;
  studentCreated?: boolean;
  teamGroup?: 'K' | '1-2' | '3-5' | '6-12' | null;
  teamPracticePeriodId?: string | null;
  selfRoomExpiresAt?: string | null;
}

export interface MatchPlayerResult {
  userId: string;
  studentNumber: string;
  name: string;
  className: string | null;
  teamId: string | null;
  teamName: string | null;
  side: 1 | 2;
  score: number;
  teamScore: number;
  maxTile: number;
  outcome: 'win' | 'loss' | 'draw';
}

export interface MatchResult {
  id: string;
  roomId: string;
  roomName: string;
  mode: RoomMode;
  durationMinutes: number;
  startedAt: string;
  endedAt: string;
  endReason: 'timeout' | 'all_game_over';
  players: MatchPlayerResult[];
}

export interface ImportPreview<T> {
  token: string;
  totalRows: number;
  creates: number;
  updates: number;
  rows: T[];
  errors: Array<{ row: number; field: string; message: string }>;
  expiresAt: string;
}

export type PlayerClientMessage = {
  type: 'move';
  seq: number;
  direction: Direction;
};

export interface MatchScoreSummary {
  mode: RoomMode;
  side: 1 | 2;
  sideScores: { 1: number; 2: number };
  ownScore: number;
  revision: number;
}

export type ServerScoreSummary = {
  type: 'score-summary';
  roomId: string;
  scores: MatchScoreSummary;
};

export type ServerPlayerState = {
  type: 'state';
  roomId: string;
  roomStatus: RoomStatus;
  serverTime: number;
  startsAt: number | null;
  endsAt: number | null;
  game: GameSnapshot | null;
  canControl: boolean;
  scores: MatchScoreSummary | null;
};

export interface TeacherPlayerState {
  userId: string;
  studentNumber: string;
  name: string;
  className: string | null;
  teamName: string | null;
  teamLogo: string | null;
  side: 1 | 2;
  online: boolean;
  game: GameSnapshot;
}

export type ServerTeacherState = {
  type: 'teacher-snapshot';
  roomId: string;
  roomStatus: RoomStatus;
  serverTime: number;
  startsAt: number | null;
  endsAt: number | null;
  revision: number;
  players: TeacherPlayerState[];
};

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    issues?: Array<{ path: string; message: string }>;
  };
}

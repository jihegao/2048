export const locales = ['zh-CN', 'en'] as const;
export type Locale = (typeof locales)[number];

export const roles = ['teacher', 'student'] as const;
export type Role = (typeof roles)[number];

export const gradeLevels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type GradeLevel = (typeof gradeLevels)[number];

export const roomModes = ['duel', 'team_3v3'] as const;
export type RoomMode = (typeof roomModes)[number];

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
  gradeLevel: GradeLevel | null;
  role: Role;
  locale: Locale | null;
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
  maxTile: number;
  isCurrentUser: boolean;
}

export interface StudentPracticeLeaderboardBoard {
  status: 'available';
  gradeLevel: GradeLevel | null;
  participantCount: number;
  currentUserRank: number | null;
  entries: StudentPracticeLeaderboardEntry[];
}

export interface StudentPracticeLeaderboardResponse {
  status: 'available';
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
  gradeLevel: GradeLevel | null;
  score: number;
  maxTile: number;
  validMoveCount: number;
  endedAt: string;
}

export interface TeacherPracticeLeaderboardResponse {
  period: LeaderboardPeriod;
  gradeLevel: GradeLevel | null;
  participantCount: number;
  entries: TeacherPracticeLeaderboardEntry[];
}

export interface TeamSummary {
  id: string;
  name: string;
  code: string;
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

export type ServerPlayerState = {
  type: 'state';
  roomId: string;
  roomStatus: RoomStatus;
  serverTime: number;
  startsAt: number | null;
  endsAt: number | null;
  game: GameSnapshot | null;
  canControl: boolean;
};

export interface TeacherPlayerState {
  userId: string;
  studentNumber: string;
  name: string;
  className: string | null;
  teamName: string | null;
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
  players: TeacherPlayerState[];
};

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    issues?: Array<{ path: string; message: string }>;
  };
}

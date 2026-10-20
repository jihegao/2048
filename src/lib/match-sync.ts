import { applyMove } from '../../shared/game';
import { isGameSnapshot, MATCH_SYNC_GRACE_MS, sameGame } from '../../shared/match';
import type {
  Direction,
  GameSnapshot,
  PlayerProgressMessage,
  ServerPlayerState,
  ServerScoreSummary,
} from '../../shared/types';

interface SavedMatch {
  startsAt: number;
  game: GameSnapshot;
  playedAt: number;
  final: boolean;
}

/** Local play has one clock and one board. Server replies only acknowledge uploads. */
export class MatchSync {
  state: ServerPlayerState | null = null;
  final = false;
  finalAcknowledged = false;
  private owned = false;
  private acknowledgedSeq = -1;
  private playedAt = 0;
  private epoch: number | null = null;
  private waitingSince: number | null = null;

  constructor(
    private storage?: Pick<Storage, 'getItem' | 'setItem'>,
    private key = '',
    private clock = () => performance.now(),
  ) {}

  get now() {
    return this.epoch === null ? Date.now() : Math.floor(this.epoch + this.clock());
  }

  private save() {
    if (!this.owned || !this.state?.game || this.state.startsAt === null) return;
    try {
      this.storage?.setItem(
        this.key,
        JSON.stringify({
          startsAt: this.state.startsAt,
          game: this.state.game,
          playedAt: this.playedAt,
          final: this.final,
        } satisfies SavedMatch),
      );
    } catch {
      // Storage being unavailable must never interrupt a move or its upload.
    }
  }

  accept(next: ServerPlayerState | ServerScoreSummary, fromSocket = true) {
    const current = this.state;
    if (next.type === 'score-summary') {
      if (current?.roomId !== next.roomId) return;
      if (next.scores.revision < (current.scores?.revision ?? -1)) return;
      this.state = { ...current, scores: next.scores };
      return;
    }
    const sameMatch = current?.roomId === next.roomId && current.startsAt === next.startsAt;
    this.waitingSince = null;
    if (!sameMatch) {
      this.epoch = next.serverTime - this.clock();
      this.owned = false;
      this.final = false;
      this.finalAcknowledged = false;
      this.acknowledgedSeq = -1;
      this.playedAt = next.startsAt ?? next.serverTime;
    } else {
      // Later packets can shorten the countdown, but delayed packets cannot extend it.
      this.epoch = Math.max(this.epoch!, next.serverTime - this.clock());
    }
    const scores =
      sameMatch && (current.scores?.revision ?? -1) > (next.scores?.revision ?? -1)
        ? current.scores
        : next.scores;
    // HTTP bootstrap can arrive after the socket; it has no controller identity.
    const canControl = fromSocket ? next.canControl : (current?.canControl ?? next.canControl);
    let game = sameMatch && this.owned ? current.game : next.game;
    if (!this.owned && next.game) {
      this.owned = canControl;
      this.playedAt = Math.max(next.startsAt ?? 0, next.game.maxTileReachedAt);
      try {
        const saved = JSON.parse(this.storage?.getItem(this.key) ?? 'null') as SavedMatch | null;
        if (
          saved?.startsAt === next.startsAt &&
          isGameSnapshot(saved.game) &&
          saved.game.seq >= next.game.seq &&
          saved.game.score >= next.game.score &&
          Number.isSafeInteger(saved.playedAt) &&
          saved.playedAt >= next.startsAt! &&
          saved.playedAt < next.endsAt! &&
          typeof saved.final === 'boolean'
        ) {
          this.owned = true;
          game = saved.game;
          this.playedAt = saved.playedAt;
          this.final = saved.final;
        }
      } catch {
        // Ignore an incomplete or obsolete local cache.
      }
    }
    if (sameMatch || !current) {
      this.acknowledgedSeq = Math.max(this.acknowledgedSeq, next.game?.seq ?? -1);
      if ((next.finalSubmitted || next.settled) && next.game && game && sameGame(next.game, game)) {
        this.final = true;
        this.finalAcknowledged = true;
      }
    }
    this.state = { ...next, game, scores, canControl };
    this.tick();
    this.save();
  }

  tick() {
    const state = this.state;
    if (!state) return;
    let roomStatus = state.roomStatus;
    if (roomStatus === 'countdown' && state.startsAt !== null && this.now >= state.startsAt)
      roomStatus = 'live';
    if (state.endsAt !== null && this.now >= state.endsAt) roomStatus = 'ended';
    if (roomStatus !== state.roomStatus) this.state = { ...state, roomStatus };
    if (this.owned && !this.final && (roomStatus === 'ended' || state.game?.status === 'over')) {
      this.final = true;
      this.save();
    }
  }

  get disabled() {
    const state = this.state;
    return (
      !state?.canControl ||
      !state.game ||
      state.roomStatus !== 'live' ||
      this.final ||
      state.game.status === 'over' ||
      state.startsAt === null ||
      state.endsAt === null ||
      this.now < state.startsAt ||
      this.now >= state.endsAt
    );
  }

  move(direction: Direction) {
    this.tick();
    if (this.disabled || !this.state?.game) return false;
    const playedAt = this.now;
    const result = applyMove(this.state.game, direction, playedAt);
    if (!result.moved) return false;
    this.playedAt = playedAt;
    this.state = { ...this.state, game: result.snapshot };
    this.tick();
    this.save();
    return true;
  }

  get uploadExpired() {
    const state = this.state;
    const deadline = state?.syncDeadlineAt ?? (state?.endsAt ?? 0) + MATCH_SYNC_GRACE_MS;
    return !this.finalAcknowledged && (Boolean(state?.settled) || this.now >= deadline);
  }

  sent() {
    this.waitingSince ??= this.clock();
  }

  reconnectNeeded() {
    if (this.waitingSince === null || this.clock() - this.waitingSince < 8000) return false;
    // A socket can remain OPEN after the network path has failed. Resending to
    // that socket alone would consume the entire final upload window.
    this.waitingSince = null;
    return true;
  }

  progress(force = false): PlayerProgressMessage | null {
    this.tick();
    const state = this.state;
    if (
      !this.owned ||
      !state?.canControl ||
      !state.game ||
      state.roomStatus === 'countdown' ||
      state.settled ||
      this.finalAcknowledged ||
      this.uploadExpired ||
      (!force && !this.final && this.acknowledgedSeq >= state.game.seq)
    )
      return null;
    return { type: 'progress', game: state.game, playedAt: this.playedAt, final: this.final };
  }
}

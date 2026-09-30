import { applyMove } from '../../shared/game';
import {
  TIMED_MAX_BATCH,
  TIMED_MAX_OPERATIONS,
  type TimedResponse,
  type TimedResult,
  type TimedSession,
} from '../../shared/timed-practice';
import type { Direction } from '../../shared/types';

const FLUSH_INTERVAL_MS = 100;
const RETRY_INTERVAL_MS = 1_000;
const MAX_PENDING = 256;

type Request = (path: string, init?: RequestInit) => Promise<TimedResponse>;
export interface TimedView {
  loading: boolean;
  session: TimedSession | null;
  result: TimedResult | null;
  error: string;
  pendingCount: number;
  remainingMs: number;
  disabled: boolean;
}

/** Local prediction never waits for HTTP. A single ordered uploader reconciles
 * acknowledged operations and replays only the still-pending local suffix. */
export class TimedPracticeSync {
  view: TimedView = {
    loading: true,
    session: null,
    result: null,
    error: '',
    pendingCount: 0,
    remainingMs: 0,
    disabled: true,
  };
  private pending: Array<{ seq: number; direction: Direction }> = [];
  private deadline = 0;
  private bestRoundTrip = Infinity;
  private busy = false;
  private disposed = false;
  private retryAt = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private request: Request,
    private changed: (view: TimedView) => void,
    private clock = () => performance.now(),
  ) {
    this.timer = setInterval(() => {
      if (
        Math.ceil(this.remainingMs / 1000) !== Math.ceil(this.view.remainingMs / 1000) ||
        this.disabled !== this.view.disabled
      )
        this.publish({});
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  get remainingMs() {
    return Math.max(0, this.deadline - this.clock());
  }

  get disabled() {
    return (
      this.view.loading ||
      !this.view.session ||
      this.remainingMs <= 0 ||
      this.view.session.snapshot.status === 'over' ||
      this.pending.length >= MAX_PENDING ||
      this.view.session.seq >= TIMED_MAX_OPERATIONS
    );
  }

  private publish(update: Partial<TimedView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...update, pendingCount: this.pending.length };
    this.view = { ...this.view, remainingMs: this.remainingMs, disabled: this.disabled };
    this.changed(this.view);
  }

  private accept(response: TimedResponse, sentAt: number) {
    if (this.disposed) return;
    if (response.status === 'settled') {
      this.pending = [];
      this.publish({ session: null, result: response.result, error: '' });
    } else if (response.status === 'active') {
      const session = response.session;
      const sameGame = this.view.session?.id === session.id;
      if (!sameGame) this.pending = [];
      // Use a monotonic clock and a midpoint RTT estimate. Later replies cannot
      // extend this game's local deadline; the server still enforces receipt time.
      const roundTrip = this.clock() - sentAt;
      const deadline =
        this.clock() +
        Date.parse(session.deadlineAt) -
        Date.parse(session.serverNow) -
        roundTrip / 2;
      // Slow/retried requests are poor clock samples. Only refine with a faster
      // round trip, so an upload delay cannot shorten the game by several seconds.
      if (!sameGame || roundTrip < this.bestRoundTrip) {
        this.deadline = sameGame ? Math.min(this.deadline, deadline) : deadline;
        this.bestRoundTrip = roundTrip;
      }
      this.pending = this.pending.filter((move) => move.seq > session.seq);
      let snapshot = session.snapshot;
      for (const move of this.pending) snapshot = applyMove(snapshot, move.direction).snapshot;
      this.publish({
        session: { ...session, snapshot, seq: this.pending.at(-1)?.seq ?? session.seq },
        result: null,
        error: '',
      });
    }
  }

  private send(path: string, init?: RequestInit) {
    return this.request(path, { ...init, signal: AbortSignal.timeout(8_000) });
  }

  async start() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.publish({ loading: true, error: '' });
    try {
      let sentAt = this.clock();
      let response = await this.send('/api/practice/timed/current');
      if (response.status === 'none' && !this.disposed) {
        sentAt = this.clock();
        response = await this.send('/api/practice/timed/start', { method: 'POST' });
      }
      this.accept(response, sentAt);
    } catch (reason) {
      this.publish({ error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      this.busy = false;
      this.publish({ loading: false });
    }
  }

  move(direction: Direction) {
    const session = this.view.session;
    if (!session || this.disabled || this.disposed) return;
    const result = applyMove(session.snapshot, direction);
    if (!result.moved) return;
    const seq = session.seq + 1;
    this.pending.push({ seq, direction });
    this.publish({ session: { ...session, seq, snapshot: result.snapshot } });
    // Avoid the batching delay at the deadline and on early game over.
    if (this.remainingMs <= 1_000 || result.snapshot.status === 'over') void this.flush();
  }

  async flush() {
    const session = this.view.session;
    if (this.disposed || this.busy || !session || this.clock() < this.retryAt) return;
    if (!this.pending.length && this.remainingMs > 0 && session.snapshot.status !== 'over') return;
    this.busy = true;
    const sentAt = this.clock();
    const batch = this.pending.slice(0, TIMED_MAX_BATCH);
    let succeeded = false;
    try {
      const response = await this.send(
        batch.length ? '/api/practice/timed/moves' : '/api/practice/timed/finish',
        {
          method: 'POST',
          body: JSON.stringify(
            batch.length
              ? {
                  sessionId: session.id,
                  seq: batch[0].seq,
                  directions: batch.map((move) => move.direction),
                }
              : { sessionId: session.id },
          ),
        },
      );
      this.accept(response, sentAt);
      succeeded = true;
    } catch (reason) {
      // Unknown outcomes retain identical sequence numbers for idempotent retry.
      // A confirmed sequence conflict (for example another tab) requires rebasing.
      if (
        reason instanceof Error &&
        'code' in reason &&
        ['TIMED_SEQUENCE_CONFLICT', 'TIMED_SEQUENCE_GAP'].includes(String(reason.code))
      ) {
        try {
          const resyncAt = this.clock();
          const response = await this.send('/api/practice/timed/finish', {
            method: 'POST',
            body: JSON.stringify({ sessionId: session.id }),
          });
          this.pending = [];
          this.accept(response, resyncAt);
        } catch {
          /* retain the queue until the next retry */
        }
      }
      this.retryAt = this.clock() + RETRY_INTERVAL_MS;
      this.publish({ error: 'sync_retry' });
    } finally {
      this.busy = false;
    }
    // Inputs collected during the request are sent immediately, in order.
    if (succeeded && this.pending.length && !this.disposed) void this.flush();
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
  }
}

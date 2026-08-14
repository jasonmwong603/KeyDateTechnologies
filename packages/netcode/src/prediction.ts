/**
 * Client-side prediction and server reconciliation.
 *
 * The client cannot wait a round trip to draw its own movement — at 80ms ping
 * that is visible input lag. So it applies input immediately against the shared
 * simulation and keeps every input frame the server has not yet acknowledged.
 *
 * When a snapshot arrives it carries the server's authoritative state *as of*
 * some input sequence number. The client snaps to that state and replays every
 * input after it. If the client predicted correctly the replay lands exactly
 * where it already was and nothing visibly happens; if it predicted wrongly —
 * it got blocked by a player it could not see, say — the correction is applied
 * once rather than fought over every frame.
 */

export interface PendingInput<TInput> {
  seq: number;
  input: TInput;
}

export interface ReconcileOptions<TState, TInput> {
  /** The server's authoritative state. */
  authoritative: TState;
  /** Highest input sequence the server had consumed when it produced that state. */
  ackedSeq: number;
  /** Advances state by one tick. Must be the same function the server runs. */
  step: (state: TState, input: TInput) => TState;
}

export class PredictionBuffer<TState, TInput> {
  private pending: PendingInput<TInput>[] = [];
  private nextSeq = 1;

  /**
   * Records an input frame and returns its sequence number.
   *
   * Call this in the same tick you apply the input locally.
   */
  record(input: TInput): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.pending.push({ seq, input });
    return seq;
  }

  /** Input frames the server has not acknowledged yet, oldest first. */
  get unacknowledged(): readonly PendingInput<TInput>[] {
    return this.pending;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Drops acknowledged inputs and replays the rest on top of the server state.
   *
   * Returns the corrected present-time state.
   */
  reconcile({ authoritative, ackedSeq, step }: ReconcileOptions<TState, TInput>): TState {
    // Everything up to and including ackedSeq is now baked into the server
    // state; keeping it would double-apply those frames.
    this.pending = this.pending.filter((entry) => entry.seq > ackedSeq);

    let state = authoritative;
    for (const entry of this.pending) {
      state = step(state, entry.input);
    }
    return state;
  }

  /** Forgets all pending input. Used on teleport, respawn, or resume. */
  reset(): void {
    this.pending = [];
  }
}

/**
 * True when two positions differ enough to be worth correcting.
 *
 * Snapping on every floating-point disagreement would jitter constantly; a
 * small tolerance lets harmless drift stand and reserves the visible correction
 * for real divergence.
 */
export function needsCorrection(
  predicted: { x: number; y: number; z: number },
  authoritative: { x: number; y: number; z: number },
  tolerance = 0.05,
): boolean {
  const dx = predicted.x - authoritative.x;
  const dy = predicted.y - authoritative.y;
  const dz = predicted.z - authoritative.z;
  return dx * dx + dy * dy + dz * dz > tolerance * tolerance;
}

import {
  createCommitment,
  createRng,
  publicPart,
  revealPart,
  type RoundCommitment,
} from '@keydate/netcode';
import { findSpot, type TableGameDefinition, type TableResolution, type Wager } from './types.js';

/**
 * Drives one table through its round loop.
 *
 * The runtime owns everything the rules modules deliberately do not: the phase
 * machine, the betting window, the commit–reveal transcript, and the guards on
 * what a player is allowed to stake. It holds no chip balances itself — it asks
 * the host for a debit and reports credits back — so the authoritative ledger
 * stays in one place on the server.
 */

export type TablePhase =
  /** Waiting for enough seated players to start a round. */
  | 'idle'
  /** Bets accepted. Ends on the timer or when everyone declares ready. */
  | 'betting'
  /** Bets locked, outcome being played out for the camera. */
  | 'resolving'
  /** Outcome shown and paid; brief pause before the next round. */
  | 'payout';

export interface TableSeat {
  playerId: string;
  seatIndex: number;
  ready: boolean;
}

export interface WagerRejection {
  ok: false;
  code: 'table_locked' | 'invalid_action' | 'insufficient_chips';
  message: string;
}

export type WagerResult = { ok: true; wager: Wager } | WagerRejection;

export interface TableRuntimeHost {
  /**
   * Attempts to take `amount` chips from a player.
   *
   * Returns false when they cannot cover it. The runtime never debits directly,
   * so the server's ledger remains the single source of truth on balances.
   */
  debit(playerId: string, amount: number, reason: string): boolean;
  /** Returns chips to a player. */
  credit(playerId: string, amount: number, reason: string): void;
  /** Milliseconds since an arbitrary fixed epoch. Injected so tests can drive it. */
  now(): number;
}

/** What clients are told about the table. Never includes an unrevealed seed. */
export interface TablePublicState {
  tableId: number;
  gameId: string;
  phase: TablePhase;
  round: number;
  seats: { playerId: string; seatIndex: number; ready: boolean }[];
  wagers: { playerId: string; spotId: string; amount: number }[];
  /** Milliseconds left in the betting window; 0 outside it. */
  bettingMsRemaining: number;
  /** Published before bets open so the outcome can be verified afterwards. */
  commitment: { digest: string; nonce: number } | null;
  /** Populated only once the round has resolved. */
  lastResult: {
    summary: string;
    detail: Record<string, unknown>;
    reveal: { seed: number; nonce: number };
  } | null;
}

/** How long the result stays on screen before the next round opens. */
const PAYOUT_DISPLAY_MS = 6_000;

export class TableRuntime {
  private phase: TablePhase = 'idle';
  private seats: TableSeat[] = [];
  private wagers: Wager[] = [];
  private round = 0;
  private phaseEndsAt = 0;
  private commitment: RoundCommitment | null = null;
  private lastResult: TablePublicState['lastResult'] = null;

  constructor(
    readonly tableId: number,
    private readonly definition: TableGameDefinition,
    private readonly host: TableRuntimeHost,
    /** Seed source for round seeds. Injected so a whole session can be replayed. */
    private readonly seedSource: () => number,
  ) {}

  get gameId(): string {
    return this.definition.id;
  }

  get currentPhase(): TablePhase {
    return this.phase;
  }

  get seatedCount(): number {
    return this.seats.length;
  }

  // -------------------------------------------------------------------------
  // Seating
  // -------------------------------------------------------------------------

  /** Seats a player, returning the seat index, or null when the table is full. */
  sit(playerId: string): number | null {
    if (this.seats.some((seat) => seat.playerId === playerId)) {
      return this.seats.find((seat) => seat.playerId === playerId)?.seatIndex ?? null;
    }
    if (this.seats.length >= this.definition.maxPlayers) return null;

    const taken = new Set(this.seats.map((seat) => seat.seatIndex));
    let seatIndex = 0;
    while (taken.has(seatIndex)) seatIndex += 1;

    this.seats.push({ playerId, seatIndex, ready: false });
    return seatIndex;
  }

  /**
   * Removes a player from the table.
   *
   * Chips already staked in an open betting round are refunded — standing up
   * mid-round is not a way to lose money, and more importantly it is not a way
   * to dodge a bet, because bets are locked before the wheel is seeded.
   */
  stand(playerId: string): void {
    this.seats = this.seats.filter((seat) => seat.playerId !== playerId);

    if (this.phase === 'betting') {
      for (const wager of this.wagers.filter((entry) => entry.playerId === playerId)) {
        this.host.credit(playerId, wager.amount, 'wager-refunded');
      }
      this.wagers = this.wagers.filter((entry) => entry.playerId !== playerId);
    }
  }

  isSeated(playerId: string): boolean {
    return this.seats.some((seat) => seat.playerId === playerId);
  }

  setReady(playerId: string, ready: boolean): void {
    const seat = this.seats.find((entry) => entry.playerId === playerId);
    if (seat !== undefined) seat.ready = ready;
  }

  // -------------------------------------------------------------------------
  // Wagering
  // -------------------------------------------------------------------------

  placeWager(playerId: string, spotId: string, amount: number): WagerResult {
    if (this.phase !== 'betting') {
      return { ok: false, code: 'table_locked', message: 'Betting is closed on this table.' };
    }
    if (!this.isSeated(playerId)) {
      return { ok: false, code: 'invalid_action', message: 'You are not seated at this table.' };
    }
    if (findSpot(this.definition, spotId) === undefined) {
      return { ok: false, code: 'invalid_action', message: `Unknown betting spot "${spotId}".` };
    }
    if (!Number.isInteger(amount) || amount < this.definition.minWager) {
      return {
        ok: false,
        code: 'invalid_action',
        message: `Minimum wager is ${this.definition.minWager}.`,
      };
    }

    // The cap applies to a player's total exposure, not to each chip they push
    // out — otherwise the limit is trivially bypassed by splitting the bet.
    const staked = this.wagers
      .filter((wager) => wager.playerId === playerId)
      .reduce((sum, wager) => sum + wager.amount, 0);
    if (staked + amount > this.definition.maxWager) {
      return {
        ok: false,
        code: 'invalid_action',
        message: `Table limit is ${this.definition.maxWager} per round.`,
      };
    }

    if (!this.host.debit(playerId, amount, 'wager')) {
      return { ok: false, code: 'insufficient_chips', message: 'Not enough chips.' };
    }

    // Stakes on the same spot merge, so the felt shows one pile per spot.
    const existing = this.wagers.find(
      (wager) => wager.playerId === playerId && wager.spotId === spotId,
    );
    if (existing !== undefined) {
      existing.amount += amount;
      return { ok: true, wager: existing };
    }

    const wager: Wager = { playerId, spotId, amount };
    this.wagers.push(wager);
    return { ok: true, wager };
  }

  /** Pulls a player's chips back off the felt while betting is still open. */
  clearWagers(playerId: string): boolean {
    if (this.phase !== 'betting') return false;
    const mine = this.wagers.filter((wager) => wager.playerId === playerId);
    if (mine.length === 0) return false;

    for (const wager of mine) {
      this.host.credit(playerId, wager.amount, 'wager-cleared');
    }
    this.wagers = this.wagers.filter((wager) => wager.playerId !== playerId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Phase machine
  // -------------------------------------------------------------------------

  /**
   * Advances the table. Called every server tick.
   *
   * Returns a resolution on the tick a round is decided, so the caller can
   * broadcast it, and null otherwise.
   */
  update(): TableResolution | null {
    const now = this.host.now();

    switch (this.phase) {
      case 'idle':
        if (this.seats.length >= this.definition.minPlayers) this.openBetting();
        return null;

      case 'betting': {
        if (this.seats.length < this.definition.minPlayers) {
          // Everyone wandered off. Refund and reset rather than resolving into
          // an empty room.
          this.refundAll('table-abandoned');
          this.phase = 'idle';
          this.commitment = null;
          return null;
        }
        const everyoneReady = this.wagers.length > 0 && this.seats.every((seat) => seat.ready);
        if (now >= this.phaseEndsAt || everyoneReady) {
          this.phase = 'resolving';
          // A short beat so the wheel visibly spins before the result lands.
          this.phaseEndsAt = now + 3_000;
        }
        return null;
      }

      case 'resolving': {
        if (now < this.phaseEndsAt) return null;
        return this.resolveRound();
      }

      case 'payout':
        if (now >= this.phaseEndsAt) {
          this.phase = 'idle';
          for (const seat of this.seats) seat.ready = false;
        }
        return null;
    }
  }

  private openBetting(): void {
    this.round += 1;
    this.wagers = [];
    this.phase = 'betting';
    this.phaseEndsAt = this.host.now() + this.definition.bettingWindowMs;

    // The seed is chosen and committed to *before* a single chip is placed.
    // That ordering is the entire guarantee: the server cannot see the bets and
    // then pick a seed that beats them.
    this.commitment = createCommitment(this.seedSource(), this.round);
    this.lastResult = null;
  }

  private resolveRound(): TableResolution {
    const commitment = this.commitment;
    // openBetting always sets this before betting opens; the fallback exists
    // only so a corrupted phase cannot resolve with an unseeded RNG.
    if (commitment === null) {
      throw new Error(`Table ${this.tableId} tried to resolve without a commitment.`);
    }

    const rng = createRng(commitment.seed);
    const resolution = this.definition.resolve(this.wagers, rng);

    for (const credit of resolution.credits) {
      if (credit.amount > 0) this.host.credit(credit.playerId, credit.amount, 'wager-won');
    }

    this.lastResult = {
      summary: resolution.summary,
      detail: resolution.detail,
      // Revealing the seed alongside the result is what lets any client replay
      // the round and confirm it against the digest published before betting.
      reveal: revealPart(commitment),
    };

    this.wagers = [];
    this.phase = 'payout';
    this.phaseEndsAt = this.host.now() + PAYOUT_DISPLAY_MS;

    return resolution;
  }

  private refundAll(reason: string): void {
    for (const wager of this.wagers) {
      this.host.credit(wager.playerId, wager.amount, reason);
    }
    this.wagers = [];
  }

  // -------------------------------------------------------------------------
  // Replication
  // -------------------------------------------------------------------------

  toPublicState(): TablePublicState {
    return {
      tableId: this.tableId,
      gameId: this.definition.id,
      phase: this.phase,
      round: this.round,
      seats: this.seats.map((seat) => ({ ...seat })),
      wagers: this.wagers.map((wager) => ({ ...wager })),
      bettingMsRemaining:
        this.phase === 'betting' ? Math.max(0, this.phaseEndsAt - this.host.now()) : 0,
      // Only the digest goes out while the round is live. The seed stays server
      // side until `lastResult` carries it.
      commitment: this.commitment === null ? null : publicPart(this.commitment),
      lastResult: this.lastResult,
    };
  }
}

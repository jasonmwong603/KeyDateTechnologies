import {
  createCommitment,
  createRng,
  publicPart,
  revealPart,
  type RoundCommitment,
} from '@keydate/netcode';
import {
  findSpot,
  type InteractiveTableGame,
  type TableAction,
  type TableGameDefinition,
  type TableResolution,
  type Wager,
} from './types.js';

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
  /** Cards dealt, players acting in seat order. Only interactive games enter it. */
  | 'decisions'
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

export type ActionResult = { ok: true } | WagerRejection;

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

/** The live hand, sent only while an interactive game is in its decision phase. */
export interface TableDecisionState {
  /** Player to act. Never null while the table is in `decisions`. */
  actor: string | null;
  /** What that player may do. Everyone receives it; only the actor may use it. */
  actions: TableAction[];
  /** Milliseconds before the table decides for them. */
  msRemaining: number;
  /** Game-specific public view of the hand — cards on the table, totals. */
  view: Record<string, unknown>;
}

/** What clients are told about the table. Never includes an unrevealed seed. */
export interface TablePublicState {
  tableId: number;
  gameId: string;
  /**
   * Sent so the client can label the panel without a hardcoded lookup. Adding
   * a game should not mean editing a switch statement in the HUD.
   */
  displayName: string;
  phase: TablePhase;
  round: number;
  seats: { playerId: string; seatIndex: number; ready: boolean }[];
  wagers: { playerId: string; spotId: string; amount: number }[];
  /** Every spot on this felt, so the client can build the betting UI from it. */
  spots: { id: string; label: string; payout: number; description: string }[];
  minWager: number;
  maxWager: number;
  /** The full betting window, so a countdown bar knows what it is a fraction of. */
  bettingWindowMs: number;
  /**
   * Milliseconds left on the betting clock; 0 when no clock is running.
   *
   * On an on-demand table this stays 0 until somebody calls the deal — there is
   * genuinely no countdown before that, and showing a frozen bar would imply
   * one.
   */
  bettingMsRemaining: number;
  /** True when this table waits for a player to call the deal. */
  dealOnDemand: boolean;
  /** True once the deal has been called and the last call is running. */
  dealCalled: boolean;
  /** The hand in progress, or null outside the decision phase. */
  decision: TableDecisionState | null;
  /** Published before bets open so the outcome can be verified afterwards. */
  commitment: { digest: string; nonce: number } | null;
  /** Populated only once the round has resolved. */
  lastResult: {
    summary: string;
    detail: Record<string, unknown>;
    reveal: { seed: number; nonce: number };
    /**
     * Every action taken this round, in order.
     *
     * An interactive round is not reproducible from the seed alone — the seed
     * fixes the shoe, the actions decide what happens to it. Publishing both is
     * what keeps the round verifiable; see `replayInteractiveRound`.
     */
    actions: string[];
  } | null;
}

/** How long the result stays on screen before the next round opens. */
const PAYOUT_DISPLAY_MS = 6_000;

/** How long the outcome plays out for the camera once everything is decided. */
const RESOLVE_BEAT_MS = 3_000;

export class TableRuntime {
  private phase: TablePhase = 'idle';
  private seats: TableSeat[] = [];
  private wagers: Wager[] = [];
  private round = 0;
  private phaseEndsAt = 0;
  private commitment: RoundCommitment | null = null;
  private lastResult: TablePublicState['lastResult'] = null;

  /** The interactive game's opaque hand state, or null outside `decisions`. */
  private decisionState: unknown = null;
  /** Every action applied this round, in order. Published with the result. */
  private actionLog: string[] = [];
  /** On an on-demand table, whether a player has called for the deal. */
  private dealCalled = false;

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

  /** The interactive rules, already narrowed, or null for a one-shot game. */
  private get interactive(): InteractiveTableGame<unknown> | null {
    return (this.definition.interactive as InteractiveTableGame<unknown> | undefined) ?? null;
  }

  /** True when this table waits for a player to call the deal instead of a clock. */
  get dealsOnDemand(): boolean {
    return this.definition.bettingClose === 'on-demand';
  }

  /** Whose turn it is, or null when the table is not waiting on anybody. */
  get currentActor(): string | null {
    const game = this.interactive;
    if (game === null || this.phase !== 'decisions' || this.decisionState === null) return null;
    return game.actor(this.decisionState);
  }

  // -------------------------------------------------------------------------
  // Seating
  // -------------------------------------------------------------------------

  /** Seats a player, returning the seat index, or null when the table is full. */
  sit(playerId: string, preferred?: number): number | null {
    if (this.seats.some((seat) => seat.playerId === playerId)) {
      return this.seats.find((seat) => seat.playerId === playerId)?.seatIndex ?? null;
    }
    if (this.seats.length >= this.definition.maxPlayers) return null;

    const taken = new Set(this.seats.map((seat) => seat.seatIndex));

    // The caller may ask for a particular seat — the server passes the one
    // nearest where the player is standing, so walking up to a table puts you
    // in the chair you walked up to rather than dragging you round to seat
    // zero. It is only a preference: if it is taken, the next free one wins.
    let seatIndex = 0;
    if (preferred !== undefined && Number.isInteger(preferred) && !taken.has(preferred)) {
      seatIndex = Math.max(0, Math.min(this.definition.maxPlayers - 1, preferred));
    } else {
      while (taken.has(seatIndex)) seatIndex += 1;
    }

    this.seats.push({ playerId, seatIndex, ready: false });
    return seatIndex;
  }

  /**
   * Removes a player from the table.
   *
   * Chips already staked in an open betting round are refunded — standing up
   * mid-round is not a way to lose money, and more importantly it is not a way
   * to dodge a bet, because bets are locked before the wheel is seeded.
   *
   * Leaving *mid-hand* is different and is deliberately not a refund. By then
   * the player has seen their cards, and walking away from a bad one would be
   * the cheapest possible way to never lose a hand of blackjack. Their seat
   * goes, their hand stays, and the table plays it out for them.
   */
  stand(playerId: string): void {
    this.seats = this.seats.filter((seat) => seat.playerId !== playerId);

    if (this.phase === 'betting') {
      for (const wager of this.wagers.filter((entry) => entry.playerId === playerId)) {
        this.host.credit(playerId, wager.amount, 'wager-refunded');
      }
      this.wagers = this.wagers.filter((entry) => entry.playerId !== playerId);
      return;
    }

    // Do not leave a table of six waiting fifteen seconds on somebody who has
    // already walked out of the room. One action is not always enough to end a
    // hand — an auto-hit that draws a five leaves them still to act — so play
    // it out until the turn genuinely moves on.
    //
    // The bound is generous rather than tight: a blackjack player holding three
    // boxes and splitting each of them to the limit is twelve hands, every one
    // of which may draw several cards. It exists to turn a rules bug that never
    // advances the turn into a thrown error instead of a hung server tick, and
    // a bound that a legal hand can reach would do the opposite.
    let guard = 0;
    while (this.phase === 'decisions' && this.currentActor === playerId) {
      this.applyAutoAction();
      guard += 1;
      if (guard > 512) {
        throw new Error(`Table ${this.tableId}: auto-play never released the turn.`);
      }
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

    // Rules that depend on the rest of a player's bets belong to the game: a
    // table where playing more hands raises the minimum on all of them is not
    // something the runtime could work out from a single number.
    const mine = this.wagers.filter((wager) => wager.playerId === playerId);
    const objection = this.definition.checkWager?.({ existing: mine, spotId, amount });
    if (objection !== null && objection !== undefined) {
      return { ok: false, code: 'invalid_action', message: objection };
    }

    // The cap applies to a player's total exposure, not to each chip they push
    // out — otherwise the limit is trivially bypassed by splitting the bet.
    const staked = mine.reduce((sum, wager) => sum + wager.amount, 0);
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

  /**
   * Tells the dealer to deal.
   *
   * Only a player with chips actually on the felt may call it. That is the
   * whole guard: without it, somebody with nothing at stake could stand at a
   * table of six and cut everyone else's betting short for free, over and over.
   * Having to put money down first makes rushing the table cost the person
   * doing the rushing exactly as much as it costs everybody else.
   *
   * Idempotent. A second call while the last call is already running is a
   * no-op rather than an error — a dropped acknowledgement should not turn a
   * double-tap into a red message, and it must never extend the window.
   */
  callDeal(playerId: string): ActionResult {
    if (!this.dealsOnDemand) {
      return {
        ok: false,
        code: 'invalid_action',
        message: 'This table deals on its own clock.',
      };
    }
    if (this.phase !== 'betting') {
      return { ok: false, code: 'table_locked', message: 'The cards are already out.' };
    }
    if (!this.isSeated(playerId)) {
      return { ok: false, code: 'invalid_action', message: 'You are not seated at this table.' };
    }
    if (this.dealCalled) return { ok: true };

    if (!this.wagers.some((wager) => wager.playerId === playerId)) {
      return { ok: false, code: 'invalid_action', message: 'Place a bet before calling the deal.' };
    }

    this.dealCalled = true;
    this.phaseEndsAt = this.host.now() + this.definition.bettingWindowMs;
    return { ok: true };
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
  // Decisions
  // -------------------------------------------------------------------------

  /**
   * Plays one action for the player whose turn it is.
   *
   * Every guard here matters: a client can send any action id at any moment,
   * including one belonging to somebody else's turn, and an action that costs
   * chips must not be applied before the chips are actually taken.
   */
  takeAction(playerId: string, actionId: string): ActionResult {
    const game = this.interactive;
    if (game === null || this.phase !== 'decisions' || this.decisionState === null) {
      return { ok: false, code: 'table_locked', message: 'There is nothing to decide right now.' };
    }
    if (game.actor(this.decisionState) !== playerId) {
      return { ok: false, code: 'invalid_action', message: 'It is not your turn.' };
    }
    if (!game.actions(this.decisionState).some((action) => action.id === actionId)) {
      return { ok: false, code: 'invalid_action', message: `You cannot ${actionId} right now.` };
    }

    // Doubling down costs chips. Take them first: applying the action and then
    // discovering the player cannot pay would leave a hand staked with money
    // that was never debited.
    const extra = game.stakeDelta(this.decisionState, actionId);
    if (extra > 0) {
      // Read before applying: once the action lands, the turn has moved on and
      // the spot it belonged to is no longer the current one.
      const spot = game.activeSpot?.(this.decisionState) ?? null;
      if (!this.host.debit(playerId, extra, 'wager')) {
        return { ok: false, code: 'insufficient_chips', message: 'Not enough chips to double.' };
      }
      const wager = this.wagers.find(
        (entry) => entry.playerId === playerId && (spot === null || entry.spotId === spot),
      );
      // Keeps the felt honest: the wager list is what the table shows as staked,
      // and it must match what the hand is actually playing for.
      if (wager !== undefined) wager.amount += extra;
    }

    this.commitAction(game, actionId);
    return { ok: true };
  }

  /** Plays the table's default for a player who ran out of time or left. */
  private applyAutoAction(): void {
    const game = this.interactive;
    if (game === null || this.decisionState === null) return;
    this.commitAction(game, game.autoAction(this.decisionState));
  }

  /**
   * Applies an action, records it, and hands the turn on.
   *
   * The log is the second half of the fairness proof for an interactive round:
   * the seed alone no longer determines the outcome, so what was chosen has to
   * be published alongside it.
   */
  private commitAction(game: InteractiveTableGame<unknown>, actionId: string): void {
    this.decisionState = game.apply(this.decisionState, actionId);
    this.actionLog.push(actionId);
    this.enterDecisionOrResolve();
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
        if (this.dealsOnDemand) {
          // No clock until a player asks for one. A card table waits.
          if (!this.dealCalled || now < this.phaseEndsAt) return null;
          if (this.wagers.length === 0) {
            // Everyone who had called the deal pulled their chips back off the
            // felt during the last call. Dealing into an empty table would burn
            // a round and a commitment for nothing, so the call is simply
            // withdrawn and betting stays open.
            this.dealCalled = false;
            return null;
          }
          this.closeBetting();
          return null;
        }

        const everyoneReady = this.wagers.length > 0 && this.seats.every((seat) => seat.ready);
        if (now >= this.phaseEndsAt || everyoneReady) this.closeBetting();
        return null;
      }

      case 'decisions': {
        // One player's clock, not the table's: each seat gets the full window
        // when its turn arrives, and a slow player upstream cannot eat it.
        if (now >= this.phaseEndsAt) this.applyAutoAction();
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
    // An on-demand table has no deadline until somebody sets one by calling the
    // deal. `Infinity` rather than a very large number so nothing can quietly
    // wrap around it after a long-running session.
    this.phaseEndsAt = this.dealsOnDemand
      ? Number.POSITIVE_INFINITY
      : this.host.now() + this.definition.bettingWindowMs;
    this.dealCalled = false;
    this.decisionState = null;
    this.actionLog = [];

    // The seed is chosen and committed to *before* a single chip is placed.
    // That ordering is the entire guarantee: the server cannot see the bets and
    // then pick a seed that beats them.
    this.commitment = createCommitment(this.seedSource(), this.round);
    this.lastResult = null;
  }

  /**
   * Locks the bets and starts whatever comes next.
   *
   * For a one-shot game that is the spin. For an interactive one it is the
   * deal: the hand is built here, from the seed committed to before betting
   * opened, and only then does anybody get to choose anything.
   */
  private closeBetting(): void {
    const game = this.interactive;
    const commitment = this.commitment;

    if (game === null || commitment === null) {
      this.phase = 'resolving';
      // A short beat so the wheel visibly spins before the result lands.
      this.phaseEndsAt = this.host.now() + RESOLVE_BEAT_MS;
      return;
    }

    this.decisionState = game.begin(this.wagers, createRng(commitment.seed));
    this.actionLog = [];
    this.enterDecisionOrResolve();
  }

  /**
   * Parks the table on whoever acts next, or moves on if nobody does.
   *
   * A hand where every seat was dealt a natural — or where nobody staked —
   * reaches this with nothing to decide, and must not sit in `decisions`
   * waiting for an actor who will never exist.
   */
  private enterDecisionOrResolve(): void {
    const game = this.interactive;
    const now = this.host.now();

    if (game !== null && this.decisionState !== null && game.actor(this.decisionState) !== null) {
      this.phase = 'decisions';
      this.phaseEndsAt = now + game.decisionWindowMs;
      return;
    }

    this.phase = 'resolving';
    this.phaseEndsAt = now + RESOLVE_BEAT_MS;
  }

  private resolveRound(): TableResolution {
    const commitment = this.commitment;
    // openBetting always sets this before betting opens; the fallback exists
    // only so a corrupted phase cannot resolve with an unseeded RNG.
    if (commitment === null) {
      throw new Error(`Table ${this.tableId} tried to resolve without a commitment.`);
    }

    const game = this.interactive;
    const resolution =
      game !== null && this.decisionState !== null
        ? // The hand was already dealt from this seed at `closeBetting`; settling
          // it again from a fresh RNG would deal a different one.
          game.settle(this.decisionState)
        : this.definition.resolve(this.wagers, createRng(commitment.seed));

    for (const credit of resolution.credits) {
      if (credit.amount > 0) this.host.credit(credit.playerId, credit.amount, 'wager-won');
    }

    this.lastResult = {
      summary: resolution.summary,
      detail: resolution.detail,
      // Revealing the seed alongside the result is what lets any client replay
      // the round and confirm it against the digest published before betting.
      reveal: revealPart(commitment),
      actions: [...this.actionLog],
    };

    this.wagers = [];
    this.decisionState = null;
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
      displayName: this.definition.displayName,
      phase: this.phase,
      round: this.round,
      seats: this.seats.map((seat) => ({ ...seat })),
      wagers: this.wagers.map((wager) => ({ ...wager })),
      spots: this.definition.spots.map((spot) => ({ ...spot })),
      minWager: this.definition.minWager,
      maxWager: this.definition.maxWager,
      bettingWindowMs: this.definition.bettingWindowMs,
      bettingMsRemaining: this.bettingMsRemaining(),
      dealOnDemand: this.dealsOnDemand,
      dealCalled: this.dealCalled,
      decision: this.publicDecision(),
      // Only the digest goes out while the round is live. The seed stays server
      // side until `lastResult` carries it.
      commitment: this.commitment === null ? null : publicPart(this.commitment),
      lastResult: this.lastResult,
    };
  }

  /**
   * How long the betting clock has left, or 0 when no clock is running.
   *
   * An on-demand table sits on an infinite deadline until the deal is called,
   * and `Infinity` must never reach a client: it does not survive JSON, and a
   * countdown bar cannot be a fraction of it.
   */
  private bettingMsRemaining(): number {
    if (this.phase !== 'betting') return 0;
    if (this.dealsOnDemand && !this.dealCalled) return 0;
    return Math.max(0, this.phaseEndsAt - this.host.now());
  }

  /**
   * The hand as everyone at the table may see it.
   *
   * Built through the rules module's own `view`, never from the raw state: the
   * state holds the rest of the shoe, and the dealer's hole card is in it.
   */
  private publicDecision(): TableDecisionState | null {
    const game = this.interactive;
    if (game === null || this.phase !== 'decisions' || this.decisionState === null) return null;

    return {
      actor: game.actor(this.decisionState),
      actions: game.actions(this.decisionState),
      msRemaining: Math.max(0, this.phaseEndsAt - this.host.now()),
      view: game.view(this.decisionState),
    };
  }
}

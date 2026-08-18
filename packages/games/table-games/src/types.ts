import type { Rng } from '@keydate/netcode';

/**
 * The contract every wagering table implements.
 *
 * Rules modules are pure: given the wagers on the table and a seeded RNG, they
 * return the outcome and who gets paid what. They never touch sockets, clocks
 * or chip balances — the runtime owns those. That is what makes an outcome
 * replayable from its seed, which is the whole basis of the fairness proof.
 */

export interface Wager {
  playerId: string;
  spotId: string;
  /** Chips staked. Already debited from the player when the wager was accepted. */
  amount: number;
}

/** A place on the felt a player can put chips. */
export interface BettingSpot {
  id: string;
  label: string;
  /**
   * Payout odds to one. A winning stake returns `amount * (payout + 1)`:
   * the original stake back, plus `payout` times it in winnings.
   */
  payout: number;
  description: string;
}

/** Chips returned to a player. `amount` is gross — stake included. */
export interface Credit {
  playerId: string;
  amount: number;
}

export interface TableResolution {
  /** One line for the table log, e.g. "Wheel stopped on 9x". */
  summary: string;
  /** Game-specific payload the client renders (wheel angle, dealt cards, ...). */
  detail: Record<string, unknown>;
  /** Gross chips returned per player. Players absent from this list won nothing. */
  credits: Credit[];
}

/** One choice offered to the player whose turn it is. */
export interface TableAction {
  id: string;
  label: string;
  hint: string;
}

/**
 * The extra contract a game implements when the round is not decided the
 * instant bets close.
 *
 * Wheel of Fortune and roulette are settled by one spin: bets in, seed out,
 * done. Blackjack is not — the outcome depends on what each player chooses to
 * do with the cards they were dealt, one seat at a time. That needs a phase
 * between "bets locked" and "paid", which is what this describes.
 *
 * The fairness proof survives intact, but the thing being proved grows by one
 * term. A non-interactive round is reproducible from its seed alone. An
 * interactive one is reproducible from (seed, action log) — the seed fixes the
 * shoe before a single card is seen, and the action log is published with the
 * result. `replayInteractiveRound` in this package is that replay, and the
 * client runs it.
 *
 * Only `begin` draws on the RNG. Everything after it reads cards off a shoe
 * that was already shuffled and already committed to, so no later step can
 * introduce randomness that the seed does not account for.
 */
export interface InteractiveTableGame<S = unknown> {
  /** How long one player has to choose before the table decides for them. */
  decisionWindowMs: number;
  /** Deals the round. The only step that touches the RNG. */
  begin(wagers: readonly Wager[], rng: Rng): S;
  /** Whose turn it is, or null when there is nothing left to decide. */
  actor(state: S): string | null;
  /** What the current actor may do. Empty when `actor` is null. */
  actions(state: S): TableAction[];
  /**
   * Extra chips this action costs, e.g. doubling down.
   *
   * The runtime debits it before applying, and refuses the action when the
   * player cannot cover it — the rules module never touches a balance.
   */
  stakeDelta(state: S, actionId: string): number;
  /** Applies a legal action. Pure in (state, actionId). */
  apply(state: S, actionId: string): S;
  /**
   * What the table does for a player who runs out of time, or who walks away
   * mid-hand. Must always return a legal action.
   */
  autoAction(state: S): string;
  /** What everyone at the table can see while the hand is in progress. */
  view(state: S): Record<string, unknown>;
  /** Settles once `actor` returns null. Pure in (state). */
  settle(state: S): TableResolution;
}

export interface TableGameDefinition {
  id: string;
  displayName: string;
  /** Minimum seated players before a round may start. */
  minPlayers: number;
  maxPlayers: number;
  minWager: number;
  maxWager: number;
  /** How long the betting window stays open, in milliseconds. */
  bettingWindowMs: number;
  spots: BettingSpot[];
  /**
   * Decides the round.
   *
   * MUST be deterministic in (wagers, rng) alone — no ambient randomness, no
   * clock reads — or the published seed will not reproduce the outcome.
   *
   * An interactive game still implements this, playing every seat with
   * `autoAction`. That is what a table full of players who all timed out would
   * produce, and it gives the paytable a pure function to measure.
   */
  resolve(wagers: readonly Wager[], rng: Rng): TableResolution;
  /** Present only on games with a per-player decision phase. */
  interactive?: InteractiveTableGame<never>;
}

/**
 * Replays an interactive round from its published seed and action log.
 *
 * This is the verification path: given what the server committed to before
 * betting opened and the actions it says were taken, anyone can recompute the
 * outcome and check it against what they were paid.
 */
export function replayInteractiveRound(
  definition: TableGameDefinition,
  wagers: readonly Wager[],
  rng: Rng,
  actions: readonly string[],
): TableResolution {
  const game = definition.interactive;
  if (game === undefined) {
    throw new Error(`Table game "${definition.id}" has no decision phase to replay.`);
  }

  // The cast is contained here rather than spread through the runtime: a
  // definition's state type is its own business, and nothing outside the rules
  // module ever inspects it.
  const interactive = game as InteractiveTableGame<unknown>;
  let state = interactive.begin(wagers, rng);

  for (const actionId of actions) {
    if (interactive.actor(state) === null) {
      throw new Error(`Action log for "${definition.id}" is longer than the hand.`);
    }
    state = interactive.apply(state, actionId);
  }

  if (interactive.actor(state) !== null) {
    throw new Error(`Action log for "${definition.id}" ends mid-hand.`);
  }
  return interactive.settle(state);
}

/** Plays every remaining decision with the game's own default. */
export function autoPlay<S>(game: InteractiveTableGame<S>, initial: S): S {
  let state = initial;
  // Bounded so a rules bug that never advances the turn fails a test rather
  // than hanging the server tick.
  for (let step = 0; step < 512; step += 1) {
    if (game.actor(state) === null) return state;
    state = game.apply(state, game.autoAction(state));
  }
  throw new Error('Auto-play did not terminate; the decision phase never ended.');
}

export function findSpot(definition: TableGameDefinition, spotId: string): BettingSpot | undefined {
  return definition.spots.find((spot) => spot.id === spotId);
}

/** Sums the stakes on the table. */
export function totalStaked(wagers: readonly Wager[]): number {
  return wagers.reduce((sum, wager) => sum + wager.amount, 0);
}

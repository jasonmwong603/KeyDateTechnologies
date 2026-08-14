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
   */
  resolve(wagers: readonly Wager[], rng: Rng): TableResolution;
}

export function findSpot(definition: TableGameDefinition, spotId: string): BettingSpot | undefined {
  return definition.spots.find((spot) => spot.id === spotId);
}

/** Sums the stakes on the table. */
export function totalStaked(wagers: readonly Wager[]): number {
  return wagers.reduce((sum, wager) => sum + wager.amount, 0);
}

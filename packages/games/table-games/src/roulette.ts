import type { Rng } from '@keydate/netcode';
import type { TableGameDefinition, TableResolution, Wager } from './types.js';

/**
 * Roulette — European single-zero.
 *
 * Thirty-seven pockets, 0 to 36. One zero, not two: the American double-zero
 * wheel doubles the house edge to 5.26% for no extra gameplay, and there is no
 * reason to inflict that on anybody.
 *
 * Every spot here returns exactly 36/37 of what is staked on it — a 2.70% edge,
 * uniform across the board. That uniformity is the point of the layout, and it
 * is asserted in the tests: there is no trap bet, and no spot that is secretly
 * better than the others. Where you put your chips is a question of variance,
 * not of value.
 */

export const POCKET_COUNT = 37;

/**
 * The pockets in the order they physically appear around a European wheel.
 *
 * Not 0..36 in sequence — the real layout alternates high and low, red and
 * black, so that adjacent pockets are never similar. The client parks the wheel
 * graphic using an index into *this*, so the ball lands where the number is
 * actually painted.
 */
export const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const;

/** The eighteen red pockets. Everything else except zero is black. */
const RED_POCKETS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export type PocketColour = 'red' | 'black' | 'green';

export function pocketColour(pocket: number): PocketColour {
  if (pocket === 0) return 'green';
  return RED_POCKETS.has(pocket) ? 'red' : 'black';
}

/**
 * Which spots a pocket pays.
 *
 * Zero pays only `zero`. That single fact is the entire house edge: every
 * even-money and dozen bet on the felt loses to it, which is why 18 red
 * pockets pay even money out of 37 rather than out of 36.
 */
export function winningSpots(pocket: number): string[] {
  if (pocket === 0) return ['zero'];

  const spots: string[] = [pocketColour(pocket)];
  spots.push(pocket % 2 === 0 ? 'even' : 'odd');
  spots.push(pocket <= 18 ? 'low' : 'high');
  spots.push(pocket <= 12 ? 'dozen-1' : pocket <= 24 ? 'dozen-2' : 'dozen-3');
  return spots;
}

export const roulette: TableGameDefinition = {
  id: 'roulette',
  displayName: 'Roulette',
  minPlayers: 1,
  maxPlayers: 6,
  minWager: 5,
  maxWager: 5_000,
  // Longer than the wheel's window: there are ten spots to read, and spreading
  // chips across several of them is most of how roulette is actually played.
  bettingWindowMs: 25_000,
  spots: [
    { id: 'red', label: 'Red', payout: 1, description: 'Any of the 18 red pockets. Even money.' },
    {
      id: 'black',
      label: 'Black',
      payout: 1,
      description: 'Any of the 18 black pockets. Even money.',
    },
    { id: 'odd', label: 'Odd', payout: 1, description: 'Any odd number. Even money.' },
    { id: 'even', label: 'Even', payout: 1, description: 'Any even number. Zero does not count.' },
    { id: 'low', label: '1–18', payout: 1, description: 'The bottom half. Even money.' },
    { id: 'high', label: '19–36', payout: 1, description: 'The top half. Even money.' },
    { id: 'dozen-1', label: '1st 12', payout: 2, description: '1 through 12. Pays 2 to 1.' },
    { id: 'dozen-2', label: '2nd 12', payout: 2, description: '13 through 24. Pays 2 to 1.' },
    { id: 'dozen-3', label: '3rd 12', payout: 2, description: '25 through 36. Pays 2 to 1.' },
    {
      id: 'zero',
      label: '0',
      payout: 35,
      description: 'Straight up on the green. Pays 35 to 1, once in thirty-seven.',
    },
  ],

  resolve(wagers: readonly Wager[], rng: Rng): TableResolution {
    // Drawn as a position on the wheel rather than as a number, so the ball and
    // the result cannot disagree: the index *is* the outcome.
    const wheelIndex = rng.int(0, POCKET_COUNT - 1);
    const pocket = WHEEL_ORDER[wheelIndex] as number;
    const colour = pocketColour(pocket);
    const winners = new Set(winningSpots(pocket));

    const credits = wagers
      .filter((wager) => winners.has(wager.spotId))
      .map((wager) => {
        const spot = roulette.spots.find((entry) => entry.id === wager.spotId);
        const payout = spot?.payout ?? 0;
        return { playerId: wager.playerId, amount: wager.amount * (payout + 1) };
      });

    return {
      summary:
        pocket === 0 ? 'Zero. The house takes everything but the green.' : `${pocket} ${colour}.`,
      detail: {
        pocket,
        colour,
        wheelIndex,
        winningSpots: [...winners],
        // Where to park the wheel graphic, in radians.
        restAngle: (wheelIndex / POCKET_COUNT) * Math.PI * 2,
      },
      credits,
    };
  },
};

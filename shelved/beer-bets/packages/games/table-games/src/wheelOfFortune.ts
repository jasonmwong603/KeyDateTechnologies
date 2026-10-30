import type { Rng } from '@keydate/netcode';
import type { TableGameDefinition, TableResolution, Wager } from './types.js';

/**
 * Wheel of Fortune — the house game.
 *
 * A 54-segment wheel. Players stake on a multiplier; if the wheel stops on a
 * segment bearing that multiplier they are paid it, otherwise they lose the
 * stake. Four BUST segments pay nobody.
 *
 * The paytable is deliberately far kinder than a real Big Six wheel (which
 * runs an 11–24% house edge). These are virtual chips in a game between
 * friends, and a grind that bleeds everyone out inside twenty minutes is not
 * fun. Edges here run ~4–7%, with the 9x spot priced at exactly even money so
 * there is one bet that rewards knowing the maths.
 */

export const WHEEL_SEGMENT_COUNT = 54;

interface SegmentSpec {
  spotId: string;
  label: string;
  /** Multiplier applied to the stake on a win, stake included. */
  multiplier: number;
  count: number;
}

/**
 * Segment counts, chosen so each spot's expected return is close to 1:
 *   2x: 26/54 * 2 = 0.963    3x: 17/54 * 3 = 0.944
 *   9x:  6/54 * 9 = 1.000   50x:  1/54 * 50 = 0.926
 */
const SEGMENT_SPECS: SegmentSpec[] = [
  { spotId: 'x2', label: '2x', multiplier: 2, count: 26 },
  { spotId: 'x3', label: '3x', multiplier: 3, count: 17 },
  { spotId: 'x9', label: '9x', multiplier: 9, count: 6 },
  { spotId: 'x50', label: '50x', multiplier: 50, count: 1 },
  { spotId: 'bust', label: 'BUST', multiplier: 0, count: 4 },
];

export interface WheelSegment {
  index: number;
  spotId: string;
  label: string;
  multiplier: number;
}

/**
 * Lays the segments out around the rim, interleaved rather than grouped.
 *
 * Grouping all 26 of the 2x segments into one arc would make the wheel's
 * resting position readable to anyone watching it slow down, which is a real
 * edge for an observant player.
 *
 * A plain round-robin does not achieve this: it exhausts the rare labels in the
 * first few passes and leaves a solid block of the commonest one at the end. So
 * each segment is instead assigned its ideal fractional position around the rim
 * — the k-th of n copies belongs at (k + 0.5) / n — and the rim is then read off
 * in that order. Every label ends up spread as evenly as its count allows.
 */
export function buildWheel(): WheelSegment[] {
  const placements: { spec: SegmentSpec; position: number }[] = [];

  for (const spec of SEGMENT_SPECS) {
    for (let k = 0; k < spec.count; k += 1) {
      placements.push({ spec, position: (k + 0.5) / spec.count });
    }
  }

  // Ties broken by multiplier so the layout is fully deterministic, and so the
  // same wheel is drawn on every client.
  placements.sort((a, b) => a.position - b.position || a.spec.multiplier - b.spec.multiplier);

  return placements.map((placement, index) => ({
    index,
    spotId: placement.spec.spotId,
    label: placement.spec.label,
    multiplier: placement.spec.multiplier,
  }));
}

const WHEEL = buildWheel();

export const wheelOfFortune: TableGameDefinition = {
  id: 'wheel-of-fortune',
  displayName: 'Wheel of Fortune',
  minPlayers: 1,
  maxPlayers: 6,
  minWager: 5,
  maxWager: 5_000,
  bettingWindowMs: 20_000,
  spots: [
    {
      id: 'x2',
      label: '2x',
      payout: 1,
      description: 'Pays even money. Lands just under half the time.',
    },
    { id: 'x3', label: '3x', payout: 2, description: 'Pays 2 to 1.' },
    {
      id: 'x9',
      label: '9x',
      payout: 8,
      description: 'Pays 8 to 1. Priced at true odds — no house edge.',
    },
    {
      id: 'x50',
      label: '50x',
      payout: 49,
      description: 'Pays 49 to 1. One segment in fifty-four.',
    },
  ],

  resolve(wagers: readonly Wager[], rng: Rng): TableResolution {
    const index = rng.int(0, WHEEL_SEGMENT_COUNT - 1);
    const segment = WHEEL[index] as WheelSegment;

    const credits = wagers
      .filter((wager) => wager.spotId === segment.spotId)
      .map((wager) => ({
        playerId: wager.playerId,
        amount: wager.amount * segment.multiplier,
      }));

    return {
      summary:
        segment.multiplier === 0
          ? 'The wheel stopped on BUST. The house takes the table.'
          : `The wheel stopped on ${segment.label}.`,
      detail: {
        segmentIndex: index,
        segmentLabel: segment.label,
        multiplier: segment.multiplier,
        // Where to park the wheel graphic, in radians.
        restAngle: (index / WHEEL_SEGMENT_COUNT) * Math.PI * 2,
      },
      credits,
    };
  },
};

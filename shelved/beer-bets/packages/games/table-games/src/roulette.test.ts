import { createRng } from '@keydate/netcode';
import { describe, expect, it } from 'vitest';
import { POCKET_COUNT, pocketColour, roulette, WHEEL_ORDER, winningSpots } from './roulette.js';
import type { Wager } from './types.js';

const bet = (spotId: string, amount = 100, playerId = 'p1'): Wager => ({
  playerId,
  spotId,
  amount,
});

describe('the wheel', () => {
  it('has thirty-seven pockets, each appearing exactly once', () => {
    expect(WHEEL_ORDER).toHaveLength(POCKET_COUNT);
    expect(new Set(WHEEL_ORDER).size).toBe(POCKET_COUNT);
  });

  it('covers 0 through 36 with no gaps', () => {
    const sorted = [...WHEEL_ORDER].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: POCKET_COUNT }, (_, i) => i));
  });

  it('has one green, eighteen red and eighteen black', () => {
    const colours = WHEEL_ORDER.map(pocketColour);
    expect(colours.filter((colour) => colour === 'green')).toHaveLength(1);
    expect(colours.filter((colour) => colour === 'red')).toHaveLength(18);
    expect(colours.filter((colour) => colour === 'black')).toHaveLength(18);
  });

  it('alternates red and black all the way round', () => {
    // The defining property of a real European layout, and the thing a typo in
    // the order would break: walking the rim from the green, the colour changes
    // at every single pocket.
    const coloured = WHEEL_ORDER.slice(1).map(pocketColour);
    for (let i = 1; i < coloured.length; i += 1) {
      expect(coloured[i]).not.toBe(coloured[i - 1]);
    }
    // And the run closes cleanly either side of the zero rather than doubling
    // up across it.
    expect(coloured[0]).toBe('red');
    expect(coloured[coloured.length - 1]).toBe('black');
  });

  it('never seats two consecutive numbers next to each other', () => {
    // The other half of the layout's job: neighbouring pockets are far apart
    // numerically, so a ball that lands "near" your number is not near it.
    for (let i = 1; i < POCKET_COUNT; i += 1) {
      const here = WHEEL_ORDER[i] as number;
      const previous = WHEEL_ORDER[i - 1] as number;
      expect(Math.abs(here - previous)).not.toBe(1);
    }
  });
});

describe('winningSpots', () => {
  it('pays only the zero spot on a zero', () => {
    expect(winningSpots(0)).toEqual(['zero']);
  });

  it('reads a number as colour, parity, half and dozen', () => {
    expect(winningSpots(1).sort()).toEqual(['dozen-1', 'low', 'odd', 'red']);
    expect(winningSpots(36).sort()).toEqual(['dozen-3', 'even', 'high', 'red']);
    expect(winningSpots(20).sort()).toEqual(['black', 'dozen-2', 'even', 'high']);
  });

  it('puts every non-zero pocket on exactly one spot of each kind', () => {
    for (let pocket = 1; pocket <= 36; pocket += 1) {
      const spots = winningSpots(pocket);
      expect(spots).toHaveLength(4);
      expect(spots.filter((id) => id === 'red' || id === 'black')).toHaveLength(1);
      expect(spots.filter((id) => id === 'odd' || id === 'even')).toHaveLength(1);
      expect(spots.filter((id) => id === 'low' || id === 'high')).toHaveLength(1);
      expect(spots.filter((id) => id.startsWith('dozen-'))).toHaveLength(1);
    }
  });

  it('splits the board exactly in half on every even-money spot', () => {
    const pockets = Array.from({ length: 36 }, (_, i) => i + 1);
    for (const [a, b] of [
      ['red', 'black'],
      ['odd', 'even'],
      ['low', 'high'],
    ]) {
      const onA = pockets.filter((pocket) => winningSpots(pocket).includes(a as string));
      const onB = pockets.filter((pocket) => winningSpots(pocket).includes(b as string));
      expect(onA).toHaveLength(18);
      expect(onB).toHaveLength(18);
    }
  });
});

describe('roulette.resolve', () => {
  it('is reproducible from its seed', () => {
    const wagers = [bet('red'), bet('dozen-2')];
    const a = roulette.resolve(wagers, createRng(90210));
    const b = roulette.resolve(wagers, createRng(90210));
    expect(a).toEqual(b);
  });

  it('pays a winning even-money bet at 2x the stake, gross', () => {
    // Find a seed that lands on red, then check what it pays.
    let seed = 0;
    let result = roulette.resolve([bet('red')], createRng(seed));
    while (result.credits.length === 0) {
      seed += 1;
      result = roulette.resolve([bet('red')], createRng(seed));
    }
    expect(result.credits[0]!.amount).toBe(200);
    expect(result.detail.colour).toBe('red');
  });

  it('pays the zero spot 36x the stake', () => {
    let seed = 0;
    let result = roulette.resolve([bet('zero')], createRng(seed));
    while (result.detail.pocket !== 0) {
      seed += 1;
      result = roulette.resolve([bet('zero')], createRng(seed));
    }
    expect(result.credits[0]!.amount).toBe(3_600);
  });

  it('pays nothing on the board when the ball lands on zero', () => {
    let seed = 0;
    const spread = roulette.spots
      .filter((spot) => spot.id !== 'zero')
      .map((spot) => bet(spot.id, 50));
    let result = roulette.resolve(spread, createRng(seed));
    while (result.detail.pocket !== 0) {
      seed += 1;
      result = roulette.resolve(spread, createRng(seed));
    }
    expect(result.credits).toEqual([]);
  });

  it('ignores a spot it does not offer', () => {
    // A modified client can name any spot it likes. The runtime rejects unknown
    // ones, but the rules module must not pay one either.
    const result = roulette.resolve([bet('street-7'), bet('00')], createRng(4));
    expect(result.credits).toEqual([]);
  });

  it('reports a rest angle inside one full turn', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const angle = roulette.resolve([], createRng(seed)).detail.restAngle as number;
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(Math.PI * 2);
    }
  });

  it('lands on every pocket over a long run, and on none it should not', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 20_000; seed += 1) {
      seen.add(roulette.resolve([], createRng(seed)).detail.pocket as number);
    }
    expect(seen.size).toBe(POCKET_COUNT);
  });
});

describe('the paytable', () => {
  /**
   * Every spot on this felt is priced at exactly 36/37.
   *
   * This is the test that catches a mistyped payout or a mis-grouped dozen: a
   * spot that pays a chip too much is a spot somebody will find and sit on all
   * night. Computed exactly over all 37 pockets rather than sampled, so it is
   * an arithmetic fact, not a statistical one.
   */
  function expectedReturn(spotId: string): number {
    let returned = 0;
    for (let pocket = 0; pocket < POCKET_COUNT; pocket += 1) {
      if (!winningSpots(pocket).includes(spotId)) continue;
      const payout = roulette.spots.find((spot) => spot.id === spotId)?.payout ?? 0;
      returned += payout + 1;
    }
    return returned / POCKET_COUNT;
  }

  it('returns exactly 36/37 on every spot', () => {
    for (const spot of roulette.spots) {
      expect(expectedReturn(spot.id)).toBeCloseTo(36 / 37, 10);
    }
  });

  it('sits inside the house band the other games are held to', () => {
    for (const spot of roulette.spots) {
      expect(expectedReturn(spot.id)).toBeGreaterThan(0.93);
      expect(expectedReturn(spot.id)).toBeLessThanOrEqual(1);
    }
  });

  it('holds up when actually spun, not just on paper', () => {
    // 100k spins of a flat bet on each spot. Wide bounds — this is a smoke test
    // for a resolve() that disagrees with the arithmetic above, not a test of
    // the RNG's distribution.
    for (const spot of roulette.spots) {
      const rounds = 100_000;
      let paid = 0;
      for (let seed = 0; seed < rounds; seed += 1) {
        const result = roulette.resolve([bet(spot.id, 10)], createRng(seed));
        paid += result.credits.reduce((sum, credit) => sum + credit.amount, 0);
      }
      const ret = paid / (rounds * 10);
      expect(ret).toBeGreaterThan(0.85);
      expect(ret).toBeLessThan(1.15);
    }
  });
});

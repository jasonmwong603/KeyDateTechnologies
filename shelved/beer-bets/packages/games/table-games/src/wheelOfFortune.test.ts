import { createRng } from '@keydate/netcode';
import { describe, expect, it } from 'vitest';
import { totalStaked, type Wager } from './types.js';
import { WHEEL_SEGMENT_COUNT, buildWheel, wheelOfFortune } from './wheelOfFortune.js';

const wager = (playerId: string, spotId: string, amount: number): Wager => ({
  playerId,
  spotId,
  amount,
});

describe('buildWheel', () => {
  it('lays out exactly the declared number of segments', () => {
    expect(buildWheel()).toHaveLength(WHEEL_SEGMENT_COUNT);
  });

  it('uses the intended segment counts', () => {
    const counts = new Map<string, number>();
    for (const segment of buildWheel()) {
      counts.set(segment.spotId, (counts.get(segment.spotId) ?? 0) + 1);
    }
    expect(counts.get('x2')).toBe(26);
    expect(counts.get('x3')).toBe(17);
    expect(counts.get('x9')).toBe(6);
    expect(counts.get('x50')).toBe(1);
    expect(counts.get('bust')).toBe(4);
  });

  it('spreads each multiplier around the rim rather than grouping it', () => {
    // Grouped segments would make the resting position readable as the wheel
    // slows down. Interleaving means no long run of one label.
    const wheel = buildWheel();
    let longestRun = 1;
    let run = 1;
    for (let i = 1; i < wheel.length; i += 1) {
      run = wheel[i]!.spotId === wheel[i - 1]!.spotId ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    expect(longestRun).toBeLessThanOrEqual(3);
  });
});

describe('wheelOfFortune.resolve', () => {
  it('is reproducible from its seed', () => {
    const wagers = [wager('a', 'x2', 100), wager('b', 'x9', 50)];
    const first = wheelOfFortune.resolve(wagers, createRng(777));
    const second = wheelOfFortune.resolve(wagers, createRng(777));
    // This is the fairness guarantee: a published seed must replay exactly.
    expect(first).toEqual(second);
  });

  it('pays only the players who backed the winning multiplier', () => {
    // Find a seed that lands on x50 so the assertion is about a known outcome.
    let seed = 0;
    let resolution = wheelOfFortune.resolve([], createRng(seed));
    while (resolution.detail.segmentLabel !== '50x' && seed < 10_000) {
      seed += 1;
      resolution = wheelOfFortune.resolve([], createRng(seed));
    }
    expect(resolution.detail.segmentLabel).toBe('50x');

    const paid = wheelOfFortune.resolve(
      [wager('winner', 'x50', 10), wager('loser', 'x2', 1000)],
      createRng(seed),
    );

    expect(paid.credits).toHaveLength(1);
    expect(paid.credits[0]).toEqual({ playerId: 'winner', amount: 500 });
  });

  it('pays nobody on a BUST segment', () => {
    let seed = 0;
    let resolution = wheelOfFortune.resolve(
      [wager('a', 'x2', 10), wager('b', 'x3', 10), wager('c', 'x9', 10), wager('d', 'x50', 10)],
      createRng(seed),
    );
    while (resolution.detail.segmentLabel !== 'BUST' && seed < 10_000) {
      seed += 1;
      resolution = wheelOfFortune.resolve(
        [wager('a', 'x2', 10), wager('b', 'x3', 10), wager('c', 'x9', 10), wager('d', 'x50', 10)],
        createRng(seed),
      );
    }
    expect(resolution.detail.segmentLabel).toBe('BUST');
    expect(resolution.credits).toHaveLength(0);
  });

  it('never pays out on a spot nobody backed', () => {
    const resolution = wheelOfFortune.resolve([wager('a', 'x2', 100)], createRng(4321));
    for (const credit of resolution.credits) {
      expect(credit.playerId).toBe('a');
    }
  });

  it('holds the advertised house edge over a long run', () => {
    // 200k spins of a flat stake on each spot. If a paytable is ever changed,
    // this is the test that catches a spot accidentally becoming profitable to
    // grind or punitively bad.
    const spins = 200_000;
    const stake = 10;
    const rng = createRng(20260814);

    const staked = new Map<string, number>();
    const returned = new Map<string, number>();
    const spots = ['x2', 'x3', 'x9', 'x50'];

    for (let i = 0; i < spins; i += 1) {
      const wagers = spots.map((spotId) => wager(spotId, spotId, stake));
      const resolution = wheelOfFortune.resolve(wagers, rng);
      for (const spotId of spots) {
        staked.set(spotId, (staked.get(spotId) ?? 0) + stake);
      }
      for (const credit of resolution.credits) {
        returned.set(credit.playerId, (returned.get(credit.playerId) ?? 0) + credit.amount);
      }
    }

    const expectedReturn: Record<string, number> = {
      x2: (26 / 54) * 2,
      x3: (17 / 54) * 3,
      x9: (6 / 54) * 9,
      x50: (1 / 54) * 50,
    };

    for (const spotId of spots) {
      const actual = (returned.get(spotId) ?? 0) / (staked.get(spotId) ?? 1);
      expect(actual).toBeCloseTo(expectedReturn[spotId]!, 1);
      // No spot may be a money printer.
      expect(actual).toBeLessThan(1.05);
    }
  });

  it('reports where to stop the wheel graphic', () => {
    const resolution = wheelOfFortune.resolve([], createRng(55));
    const angle = resolution.detail.restAngle as number;
    expect(angle).toBeGreaterThanOrEqual(0);
    expect(angle).toBeLessThan(Math.PI * 2);
  });

  it('never returns more than the table staked on a losing-heavy round', () => {
    const wagers = [wager('a', 'x2', 100), wager('b', 'x2', 100)];
    const resolution = wheelOfFortune.resolve(wagers, createRng(9));
    const paid = resolution.credits.reduce((sum, credit) => sum + credit.amount, 0);
    // Both backed the same spot, so either both win 2x or both lose.
    expect(paid === 0 || paid === totalStaked(wagers) * 2).toBe(true);
  });
});

import { createRng } from '@keydate/netcode';
import { describe, expect, it } from 'vitest';
import {
  baccarat,
  BANKER_PAYOUT,
  bankerDraws,
  cardPoints,
  dealCoup,
  handTotal,
} from './baccarat.js';
import { buildDeck, type Card, type Rank } from './cards.js';
import type { Wager } from './types.js';

const bet = (spotId: string, amount = 100, playerId = 'p1'): Wager => ({
  playerId,
  spotId,
  amount,
});

/** Builds a stacked shoe from rank names, so a coup can be dealt on purpose. */
function stack(ranks: readonly Rank[]): Card[] {
  const deck = buildDeck();
  return ranks.map((rank) => {
    const card = deck.find((entry) => entry.rank === rank);
    if (card === undefined) throw new Error(`No such rank: ${rank}`);
    return card;
  });
}

describe('cardPoints', () => {
  it('counts aces one, faces and tens zero, everything else at face value', () => {
    const points = Object.fromEntries(
      buildDeck()
        .filter((card) => card.suit === '♠')
        .map((card) => [card.rank, cardPoints(card)]),
    );
    expect(points).toMatchObject({
      A: 1,
      '2': 2,
      '9': 9,
      '10': 0,
      J: 0,
      Q: 0,
      K: 0,
    });
  });
});

describe('handTotal', () => {
  it('drops the tens digit — there is no bust in baccarat', () => {
    expect(handTotal(stack(['7', '8']))).toBe(5);
    expect(handTotal(stack(['9', 'K']))).toBe(9);
    expect(handTotal(stack(['5', '5']))).toBe(0);
    expect(handTotal(stack(['9', '9', '9']))).toBe(7);
  });
});

describe('bankerDraws', () => {
  it('stands on 7 and above regardless of what the player drew', () => {
    for (const third of [null, 0, 4, 8, 9]) {
      expect(bankerDraws(7, third)).toBe(false);
    }
  });

  it('plays the player rule when the player stood pat', () => {
    for (let total = 0; total <= 5; total += 1) expect(bankerDraws(total, null)).toBe(true);
    expect(bankerDraws(6, null)).toBe(false);
    expect(bankerDraws(7, null)).toBe(false);
  });

  it('always draws on 0, 1 and 2', () => {
    for (let third = 0; third <= 9; third += 1) {
      expect(bankerDraws(0, third)).toBe(true);
      expect(bankerDraws(1, third)).toBe(true);
      expect(bankerDraws(2, third)).toBe(true);
    }
  });

  /**
   * The conditional rows, spelled out.
   *
   * This is the part of baccarat everyone gets wrong from memory, so it is
   * asserted exhaustively rather than spot-checked: one wrong cell here shifts
   * the house edge and nothing else in the game would notice.
   */
  it('matches the standard table on every conditional row', () => {
    const expected: Record<number, number[]> = {
      3: [0, 1, 2, 3, 4, 5, 6, 7, 9],
      4: [2, 3, 4, 5, 6, 7],
      5: [4, 5, 6, 7],
      6: [6, 7],
    };
    for (const [bankerTotal, draws] of Object.entries(expected)) {
      for (let third = 0; third <= 9; third += 1) {
        expect(bankerDraws(Number(bankerTotal), third)).toBe(draws.includes(third));
      }
    }
  });
});

describe('dealCoup', () => {
  it('alternates the opening deal — player, banker, player, banker', () => {
    // The order cards come off the shoe is fixed by the seed, so it is part of
    // what the commitment covers. Dealing both of the player's cards first
    // would still be reproducible, but it would not be baccarat.
    const coup = dealCoup(stack(['A', '2', '3', '4', '5', '6']));
    expect(coup.player.slice(0, 2).map((card) => card.rank)).toEqual(['A', '3']);
    expect(coup.banker.slice(0, 2).map((card) => card.rank)).toEqual(['2', '4']);
  });

  it('gives the player the third card before the banker', () => {
    // Player 0 (10+10) draws, banker 0 (10+10) then draws. The player's third
    // card must be the one that came off the shoe first.
    const coup = dealCoup(stack(['10', 'J', 'Q', 'K', '5', '6']));
    expect(coup.player.map((card) => card.rank)).toEqual(['10', 'Q', '5']);
    expect(coup.banker.map((card) => card.rank)).toEqual(['J', 'K', '6']);
  });

  it('stands both hands on a natural', () => {
    // Player 9, banker 5. Without the natural rule the banker would draw.
    const coup = dealCoup(stack(['4', '2', '5', '3', '7', '7']));
    expect(coup.playerTotal).toBe(9);
    expect(coup.natural).toBe(true);
    expect(coup.player).toHaveLength(2);
    expect(coup.banker).toHaveLength(2);
    expect(coup.outcome).toBe('player');
  });

  it('stands the player on 6 and 7, and draws below that', () => {
    // Player 6 (2+4), banker 5 (2+3) -> player stands, banker draws on 5.
    const stood = dealCoup(stack(['2', '2', '4', '3', '8', '8']));
    expect(stood.player).toHaveLength(2);
    expect(stood.banker).toHaveLength(3);

    // Player 5 (2+3), banker 6 (2+4) -> player draws, banker stands on 6 unless
    // the player's third card was a 6 or 7.
    const drew = dealCoup(stack(['2', '2', '3', '4', '2', '9']));
    expect(drew.player).toHaveLength(3);
    expect(drew.banker).toHaveLength(2);
  });

  it('calls a tie a tie', () => {
    const coup = dealCoup(stack(['4', '4', '4', '4', '9', '9']));
    expect(coup.playerTotal).toBe(coup.bankerTotal);
    expect(coup.outcome).toBe('tie');
  });

  it('never deals a hand of fewer than two or more than three cards', () => {
    for (let seed = 0; seed < 2_000; seed += 1) {
      const result = baccarat.resolve([], createRng(seed));
      const player = result.detail.player as unknown[];
      const banker = result.detail.banker as unknown[];
      expect(player.length).toBeGreaterThanOrEqual(2);
      expect(player.length).toBeLessThanOrEqual(3);
      expect(banker.length).toBeGreaterThanOrEqual(2);
      expect(banker.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('baccarat.resolve', () => {
  it('is reproducible from its seed', () => {
    const wagers = [bet('player'), bet('banker', 200, 'p2')];
    expect(baccarat.resolve(wagers, createRng(1234))).toEqual(
      baccarat.resolve(wagers, createRng(1234)),
    );
  });

  /** Finds a seed producing the given outcome, so payouts can be asserted. */
  function seedFor(outcome: 'player' | 'banker' | 'tie'): number {
    for (let seed = 0; seed < 10_000; seed += 1) {
      if (baccarat.resolve([], createRng(seed)).detail.outcome === outcome) return seed;
    }
    throw new Error(`No seed produced a ${outcome} in ten thousand tries.`);
  }

  it('pays the player spot even money', () => {
    const result = baccarat.resolve([bet('player', 100)], createRng(seedFor('player')));
    expect(result.credits).toEqual([{ playerId: 'p1', amount: 200 }]);
  });

  it('pays the banker spot even money less the five percent commission', () => {
    const result = baccarat.resolve([bet('banker', 100)], createRng(seedFor('banker')));
    expect(result.credits).toEqual([{ playerId: 'p1', amount: 195 }]);
    expect(BANKER_PAYOUT).toBe(0.95);
  });

  it('rounds the commission against the player rather than for them', () => {
    // 30 * 0.95 = 28.5. Paying 29 would make the minimum banker bet the best
    // value on the felt, which is exactly the sort of thing somebody notices.
    const result = baccarat.resolve([bet('banker', 30)], createRng(seedFor('banker')));
    expect(result.credits[0]!.amount).toBe(58);
  });

  it('pays a tie nine to one', () => {
    const result = baccarat.resolve([bet('tie', 100)], createRng(seedFor('tie')));
    expect(result.credits).toEqual([{ playerId: 'p1', amount: 1_000 }]);
  });

  it('pushes player and banker stakes on a tie', () => {
    const seed = seedFor('tie');
    const result = baccarat.resolve(
      [bet('player', 100, 'p1'), bet('banker', 250, 'p2')],
      createRng(seed),
    );
    expect(result.credits).toEqual([
      { playerId: 'p1', amount: 100 },
      { playerId: 'p2', amount: 250 },
    ]);
  });

  it('takes the losing side when the coup is decided', () => {
    const result = baccarat.resolve(
      [bet('player', 100, 'p1'), bet('banker', 100, 'p2'), bet('tie', 100, 'p3')],
      createRng(seedFor('player')),
    );
    expect(result.credits).toEqual([{ playerId: 'p1', amount: 200 }]);
  });

  it('ignores a spot it does not offer', () => {
    const result = baccarat.resolve([bet('dragon-7'), bet('pair')], createRng(7));
    expect(result.credits).toEqual([]);
  });

  it('resolves an empty table without paying anybody', () => {
    expect(baccarat.resolve([], createRng(3)).credits).toEqual([]);
  });
});

describe('the paytable', () => {
  /**
   * Ten thousand coups, flat-betting each spot.
   *
   * Baccarat's edge is small and its variance is low, so this converges fast
   * and the bounds can be tight enough to catch a wrong commission or a wrong
   * tie payout — which is the whole point of running it.
   */
  const ROUNDS = 10_000;

  function expectedReturn(spotId: string): number {
    let paid = 0;
    for (let seed = 0; seed < ROUNDS; seed += 1) {
      const result = baccarat.resolve([bet(spotId, 100)], createRng(seed));
      paid += result.credits.reduce((sum, credit) => sum + credit.amount, 0);
    }
    return paid / (ROUNDS * 100);
  }

  it('returns close to 98.8% on the player spot', () => {
    expect(expectedReturn('player')).toBeCloseTo(0.988, 1);
  });

  it('returns close to 98.9% on the banker spot', () => {
    expect(expectedReturn('banker')).toBeCloseTo(0.989, 1);
  });

  it('returns close to 95% on the tie, not the 85% an 8-to-1 tie would', () => {
    // The one deliberate departure from a real pit. If somebody "corrects" the
    // tie to 8 to 1 this test is what tells them the bet just became a trap.
    const ret = expectedReturn('tie');
    expect(ret).toBeGreaterThan(0.9);
    expect(ret).toBeLessThan(1.0);
  });

  it('keeps every spot inside the house band', () => {
    for (const spot of baccarat.spots) {
      const ret = expectedReturn(spot.id);
      expect(ret).toBeGreaterThan(0.93);
      expect(ret).toBeLessThanOrEqual(1.0);
    }
  });
});

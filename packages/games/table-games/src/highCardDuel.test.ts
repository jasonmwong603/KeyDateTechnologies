import { createRng } from '@keydate/netcode';
import { describe, expect, it } from 'vitest';
import { buildDeck, highCardDuel, shuffle } from './highCardDuel.js';
import { totalStaked, type Wager } from './types.js';

const ante = (playerId: string, amount: number): Wager => ({ playerId, spotId: 'ante', amount });

describe('buildDeck', () => {
  it('builds a standard 52-card deck with no duplicates', () => {
    const deck = buildDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((card) => `${card.rank}${card.suit}`)).size).toBe(52);
  });

  it('ranks aces high', () => {
    const deck = buildDeck();
    expect(deck.find((card) => card.rank === 'A')?.value).toBe(14);
    expect(deck.find((card) => card.rank === '2')?.value).toBe(2);
  });
});

describe('shuffle', () => {
  it('is reproducible from its seed', () => {
    const a = shuffle(buildDeck(), createRng(31));
    const b = shuffle(buildDeck(), createRng(31));
    expect(a).toEqual(b);
  });

  it('preserves every card exactly once', () => {
    const shuffled = shuffle(buildDeck(), createRng(5));
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled.map((card) => `${card.rank}${card.suit}`)).size).toBe(52);
  });

  it('actually reorders the deck', () => {
    expect(shuffle(buildDeck(), createRng(5))).not.toEqual(buildDeck());
  });

  it('distributes the top card roughly evenly across the deck', () => {
    // Fisher-Yates should give every card an equal chance of landing first;
    // a biased shuffle here would be a subtle, exploitable house advantage.
    const rng = createRng(2026);
    const counts = new Map<string, number>();
    const trials = 52_000;
    for (let i = 0; i < trials; i += 1) {
      const top = shuffle(buildDeck(), rng)[0]!;
      const key = `${top.rank}${top.suit}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(52);
    const expected = trials / 52;
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.75);
      expect(count).toBeLessThan(expected * 1.25);
    }
  });
});

describe('highCardDuel.resolve', () => {
  it('refunds the ante when there is nobody to duel', () => {
    const wagers = [ante('lonely', 250)];
    const resolution = highCardDuel.resolve(wagers, createRng(1));
    expect(resolution.detail.pushed).toBe(true);
    expect(resolution.credits).toEqual([{ playerId: 'lonely', amount: 250 }]);
  });

  it('pays the whole pot to the highest card', () => {
    const wagers = [ante('a', 100), ante('b', 100), ante('c', 100)];
    const resolution = highCardDuel.resolve(wagers, createRng(88));

    const winners = resolution.detail.winners as string[];
    expect(winners.length).toBeGreaterThanOrEqual(1);

    const paid = resolution.credits.reduce((sum, credit) => sum + credit.amount, 0);
    expect(paid).toBe(300);
  });

  it('conserves chips exactly — the house takes nothing', () => {
    // Run many deals with awkward pot sizes; rounding must never create or
    // destroy a chip, since these are the same chips players spend elsewhere.
    for (let seed = 0; seed < 300; seed += 1) {
      const wagers = [ante('a', 33), ante('b', 33), ante('c', 33), ante('d', 34)];
      const resolution = highCardDuel.resolve(wagers, createRng(seed));
      const paid = resolution.credits.reduce((sum, credit) => sum + credit.amount, 0);
      expect(paid).toBe(totalStaked(wagers));
    }
  });

  it('splits the pot on a tie', () => {
    // Search for a seed that deals two players the same rank.
    let seed = 0;
    let resolution = highCardDuel.resolve(
      [ante('a', 50), ante('b', 50), ante('c', 50), ante('d', 50), ante('e', 50), ante('f', 50)],
      createRng(seed),
    );
    while ((resolution.detail.winners as string[]).length < 2 && seed < 20_000) {
      seed += 1;
      resolution = highCardDuel.resolve(
        [ante('a', 50), ante('b', 50), ante('c', 50), ante('d', 50), ante('e', 50), ante('f', 50)],
        createRng(seed),
      );
    }

    const winners = resolution.detail.winners as string[];
    expect(winners.length).toBeGreaterThan(1);
    expect(resolution.credits).toHaveLength(winners.length);
    const paid = resolution.credits.reduce((sum, credit) => sum + credit.amount, 0);
    expect(paid).toBe(300);
  });

  it('deals one distinct card per player', () => {
    const wagers = [ante('a', 10), ante('b', 10), ante('c', 10), ante('d', 10)];
    const resolution = highCardDuel.resolve(wagers, createRng(404));
    const cards = resolution.detail.cards as { playerId: string; rank: string; suit: string }[];

    expect(cards).toHaveLength(4);
    expect(new Set(cards.map((card) => `${card.rank}${card.suit}`)).size).toBe(4);
  });

  it('is reproducible from its seed', () => {
    const wagers = [ante('a', 10), ante('b', 20)];
    expect(highCardDuel.resolve(wagers, createRng(17))).toEqual(
      highCardDuel.resolve(wagers, createRng(17)),
    );
  });

  it('ignores stakes on spots the game does not offer', () => {
    const wagers: Wager[] = [ante('a', 100), { playerId: 'b', spotId: 'x50', amount: 100 }];
    const resolution = highCardDuel.resolve(wagers, createRng(3));
    // Only one valid ante remains, so it is refunded rather than won.
    expect(resolution.credits).toEqual([{ playerId: 'a', amount: 100 }]);
  });
});

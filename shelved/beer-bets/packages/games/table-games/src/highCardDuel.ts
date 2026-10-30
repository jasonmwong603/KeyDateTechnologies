import type { Rng } from '@keydate/netcode';
import { buildDeck, shuffle, type Card } from './cards.js';
import {
  totalStaked,
  type TableGameDefinition,
  type TableResolution,
  type Wager,
} from './types.js';

/**
 * High Card Duel — the social game.
 *
 * Everyone at the table antes into one pot and is dealt a single card. Highest
 * card takes the pot; ties split it. There is no house: every chip staked is
 * paid back out, so this is friends playing each other rather than the building.
 *
 * That is the deliberate counterweight to the wheel. The wheel is where chips
 * slowly drain; the duel is where they change hands.
 */

/** Splits `pot` among winners, giving the odd chips to the earliest seats. */
function splitPot(pot: number, winners: string[]): { playerId: string; amount: number }[] {
  if (winners.length === 0) return [];
  const share = Math.floor(pot / winners.length);
  let remainder = pot - share * winners.length;

  return winners.map((playerId) => {
    // Distributing the remainder deterministically keeps the total exact —
    // chips must never be created or destroyed by rounding.
    const bonus = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return { playerId, amount: share + bonus };
  });
}

export const highCardDuel: TableGameDefinition = {
  id: 'high-card-duel',
  displayName: 'High Card Duel',
  minPlayers: 2,
  maxPlayers: 6,
  minWager: 10,
  maxWager: 2_000,
  bettingWindowMs: 15_000,
  spots: [
    {
      id: 'ante',
      label: 'Ante',
      payout: 0,
      description: 'Ante into the pot. Highest card takes it all. No house cut.',
    },
  ],

  resolve(wagers: readonly Wager[], rng: Rng): TableResolution {
    const antes = wagers.filter((wager) => wager.spotId === 'ante');

    // A duel needs an opponent. With nobody to play against, the ante is
    // returned rather than swallowed.
    if (antes.length < 2) {
      return {
        summary: 'Not enough players for a duel. Antes returned.',
        detail: { cards: [], pushed: true },
        credits: antes.map((wager) => ({ playerId: wager.playerId, amount: wager.amount })),
      };
    }

    const deck = shuffle(buildDeck(), rng);
    const dealt = antes.map((wager, index) => ({
      playerId: wager.playerId,
      card: deck[index] as Card,
    }));

    let best = dealt[0] as (typeof dealt)[number];
    for (const entry of dealt) {
      if (entry.card.value > best.card.value) best = entry;
    }

    // Rank alone decides the winner; identical ranks genuinely split the pot.
    const winners = dealt
      .filter((entry) => entry.card.value === best.card.value)
      .map((entry) => entry.playerId);

    const pot = totalStaked(antes);
    const summary =
      winners.length === 1
        ? `High card ${best.card.rank}${best.card.suit} takes ${pot} chips.`
        : `${winners.length} players tied on ${best.card.rank}. Pot split.`;

    return {
      summary,
      detail: {
        cards: dealt.map((entry) => ({
          playerId: entry.playerId,
          rank: entry.card.rank,
          suit: entry.card.suit,
        })),
        pot,
        winners,
      },
      credits: splitPot(pot, winners),
    };
  },
};

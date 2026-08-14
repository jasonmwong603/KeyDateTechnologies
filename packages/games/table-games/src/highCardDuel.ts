import type { Rng } from '@keydate/netcode';
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

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
const SUITS = ['♣', '♦', '♥', '♠'] as const;

export interface Card {
  rank: (typeof RANKS)[number];
  suit: (typeof SUITS)[number];
  /** 2..14, aces high. */
  value: number;
  /** Suit rank 0..3, used only to break exact ties deterministically. */
  suitValue: number;
}

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (let suitIndex = 0; suitIndex < SUITS.length; suitIndex += 1) {
    for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
      deck.push({
        rank: RANKS[rankIndex] as Card['rank'],
        suit: SUITS[suitIndex] as Card['suit'],
        value: rankIndex + 2,
        suitValue: suitIndex,
      });
    }
  }
  return deck;
}

/**
 * Fisher–Yates, driven entirely by the seeded RNG.
 *
 * Shuffling in place with the supplied RNG (rather than `Array.sort` with a
 * random comparator, which is both biased and non-reproducible) is what lets
 * the deal be replayed from the published seed.
 */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

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

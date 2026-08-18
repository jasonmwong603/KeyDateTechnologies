import type { Rng } from '@keydate/netcode';

/**
 * Playing cards, shared by every game that deals them.
 *
 * Card counting values are deliberately *not* here: blackjack counts an ace as
 * 1 or 11, baccarat counts it as 1 and counts every face card as 0, and High
 * Card Duel ranks it above a king. There is no single "value of a card", so
 * each game supplies its own reading of the same deck.
 */

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['♣', '♦', '♥', '♠'] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];

export interface Card {
  rank: Rank;
  suit: Suit;
  /** 2..14, aces high. High Card Duel's reading; other games ignore it. */
  value: number;
  /** Suit rank 0..3, used only to break exact ties deterministically. */
  suitValue: number;
}

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (let suitIndex = 0; suitIndex < SUITS.length; suitIndex += 1) {
    for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
      deck.push({
        rank: RANKS[rankIndex] as Rank,
        suit: SUITS[suitIndex] as Suit,
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

/** A shuffled multi-deck shoe. Blackjack and baccarat are both dealt from one. */
export function buildShoe(deckCount: number, rng: Rng): Card[] {
  const cards: Card[] = [];
  for (let i = 0; i < deckCount; i += 1) cards.push(...buildDeck());
  return shuffle(cards, rng);
}

/**
 * Draws cards off the top of a shoe without mutating it.
 *
 * The shoe array is shared by every state in a hand and only the cursor moves,
 * which is what keeps `apply` pure: a state transition allocates a small object
 * rather than copying three hundred cards, and no earlier state is disturbed.
 */
export function deal(shoe: readonly Card[], cursor: number, count: number): Card[] {
  const drawn: Card[] = [];
  for (let i = 0; i < count; i += 1) {
    const card = shoe[cursor + i];
    // A round cannot outrun a six-deck shoe: the deepest possible draw is a few
    // dozen cards. Running dry means the shoe was built wrong, not that a hand
    // went long, so it is a bug rather than a condition to recover from.
    if (card === undefined) throw new RangeError('Shoe exhausted.');
    drawn.push(card);
  }
  return drawn;
}

/** "A♠" — how a card is written in a summary line or a log. */
export function cardCode(card: Card): string {
  return `${card.rank}${card.suit}`;
}

/** The wire form of a card: enough to draw it, nothing more. */
export function publicCard(card: Card): { rank: Rank; suit: Suit } {
  return { rank: card.rank, suit: card.suit };
}

import type { Rng } from '@keydate/netcode';
import { buildShoe, cardCode, deal, publicCard, type Card } from './cards.js';
import {
  autoPlay,
  type InteractiveTableGame,
  type TableAction,
  type TableGameDefinition,
  type TableResolution,
  type Wager,
} from './types.js';

/**
 * Blackjack — the first game here where the player actually plays.
 *
 * Everything else on the floor is a bet: chips down, outcome out. Blackjack
 * puts a decision between the two, one seat at a time, and that decision
 * changes the odds. It is the reason `InteractiveTableGame` exists.
 *
 * House rules, all chosen on the generous side of the usual spread:
 *
 *   - Six-deck shoe, reshuffled every round.
 *   - Dealer stands on all 17, soft included.
 *   - Blackjack pays 3 to 2.
 *   - Double down on any first two cards.
 *   - No splitting, no insurance, no surrender.
 *
 * Splits are the notable omission. They are not hard to compute, but they turn
 * one seat into several simultaneous hands, and every layer above this — the
 * turn order, the action panel, the wire state — is built around one hand per
 * player. Adding them is a real change, not a switch, so they are left out
 * rather than half-done. See `docs/roadmap.md`.
 */

const SHOE_DECKS = 6;
const DEALER_STANDS_ON = 17;
export const BLACKJACK_PAYOUT = 1.5;

export interface BlackjackHand {
  playerId: string;
  /** Chips at risk. Doubles when the player doubles down. */
  stake: number;
  cards: Card[];
  doubled: boolean;
  /** True once the hand can take no more cards, however that happened. */
  finished: boolean;
}

export interface BlackjackState {
  /** Shuffled up front and never mutated; `cursor` is the only thing that moves. */
  shoe: readonly Card[];
  cursor: number;
  dealer: Card[];
  hands: BlackjackHand[];
  /** Index of the hand to act, or `hands.length` once every seat is done. */
  turn: number;
  /** Set at the deal. Ends the hand immediately — nobody gets to decide. */
  dealerBlackjack: boolean;
}

/**
 * A hand's total, and whether an ace is still counting as eleven.
 *
 * Counting every ace as 11 and demoting them one at a time is the whole trick:
 * a hand can hold at most one ace worth eleven, because a second would bust it.
 */
export function handValue(cards: readonly Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.rank === 'A') {
      aces += 1;
      total += 11;
    } else if (card.rank === '10' || card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

export function isBust(cards: readonly Card[]): boolean {
  return handValue(cards).total > 21;
}

/** Twenty-one on the first two cards, and only on the first two. */
export function isBlackjack(cards: readonly Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

// ---------------------------------------------------------------------------
// Decision phase
// ---------------------------------------------------------------------------

function currentHand(state: BlackjackState): BlackjackHand | undefined {
  return state.hands[state.turn];
}

/** Moves the turn on to the next seat that still has a choice to make. */
function advance(state: BlackjackState): BlackjackState {
  let turn = state.turn;
  while (turn < state.hands.length && (state.hands[turn] as BlackjackHand).finished) {
    turn += 1;
  }
  return { ...state, turn };
}

const interactive: InteractiveTableGame<BlackjackState> = {
  // Short enough that one player thinking about it does not stall a table of
  // six, long enough to read your cards on a phone.
  decisionWindowMs: 15_000,

  begin(wagers: readonly Wager[], rng: Rng): BlackjackState {
    const shoe = buildShoe(SHOE_DECKS, rng);
    const antes = wagers.filter((wager) => wager.spotId === 'ante');

    // Dealt round the table then to the dealer, twice, as at a real table. The
    // order matters: it is fixed by the shoe, and the shoe is fixed by the
    // committed seed, so this is part of what the fairness proof covers.
    let cursor = 0;
    const hands: BlackjackHand[] = antes.map((wager) => ({
      playerId: wager.playerId,
      stake: wager.amount,
      cards: [],
      doubled: false,
      finished: false,
    }));

    for (let pass = 0; pass < 2; pass += 1) {
      for (const hand of hands) {
        hand.cards.push(deal(shoe, cursor, 1)[0] as Card);
        cursor += 1;
      }
    }
    const dealer = deal(shoe, cursor, 2);
    cursor += 2;

    const dealerBlackjack = isBlackjack(dealer);
    for (const hand of hands) {
      // A natural stands itself, and nobody acts against a dealer natural.
      if (dealerBlackjack || isBlackjack(hand.cards)) hand.finished = true;
    }

    return advance({ shoe, cursor, dealer, hands, turn: 0, dealerBlackjack });
  },

  actor(state: BlackjackState): string | null {
    return currentHand(state)?.playerId ?? null;
  },

  actions(state: BlackjackState): TableAction[] {
    const hand = currentHand(state);
    if (hand === undefined) return [];

    const { total, soft } = handValue(hand.cards);
    const options: TableAction[] = [
      { id: 'hit', label: 'Hit', hint: 'Take another card' },
      { id: 'stand', label: 'Stand', hint: `Stay on ${soft ? 'soft ' : ''}${total}` },
    ];
    // Doubling is a first-decision-only move: it buys exactly one card for
    // exactly one extra stake.
    if (hand.cards.length === 2) {
      options.push({ id: 'double', label: 'Double', hint: 'Double the stake, take one card' });
    }
    return options;
  },

  stakeDelta(state: BlackjackState, actionId: string): number {
    if (actionId !== 'double') return 0;
    const hand = currentHand(state);
    if (hand === undefined || hand.cards.length !== 2) return 0;
    return hand.stake;
  },

  apply(state: BlackjackState, actionId: string): BlackjackState {
    const hand = currentHand(state);
    if (hand === undefined) return state;

    if (actionId === 'stand') {
      const hands = [...state.hands];
      hands[state.turn] = { ...hand, finished: true };
      return advance({ ...state, hands });
    }

    if (actionId === 'double' && hand.cards.length === 2) {
      const card = deal(state.shoe, state.cursor, 1)[0] as Card;
      const hands = [...state.hands];
      hands[state.turn] = {
        ...hand,
        cards: [...hand.cards, card],
        // The runtime has already debited the extra stake by the time this runs.
        stake: hand.stake * 2,
        doubled: true,
        finished: true,
      };
      return advance({ ...state, hands, cursor: state.cursor + 1 });
    }

    // Anything unrecognised is treated as a hit rather than rejected: the
    // runtime validates action ids before they get here, so reaching this point
    // with a bad one means a bug, and a bug must not be able to wedge a table
    // in a phase nobody can leave.
    const card = deal(state.shoe, state.cursor, 1)[0] as Card;
    const cards = [...hand.cards, card];
    const hands = [...state.hands];
    // Twenty-one needs no further decision, and busting ends it either way.
    hands[state.turn] = { ...hand, cards, finished: handValue(cards).total >= 21 };
    return advance({ ...state, hands, cursor: state.cursor + 1 });
  },

  /**
   * What the table plays for somebody who ran out of time or walked away.
   *
   * A simplified basic strategy: it never doubles (that would spend chips the
   * player did not choose to spend), and otherwise plays the standard hard and
   * soft totals against the dealer's upcard. Standing on everything would be
   * simpler and noticeably worse for the absent player, which is the wrong
   * default when the table is deciding on their behalf.
   */
  autoAction(state: BlackjackState): string {
    const hand = currentHand(state);
    if (hand === undefined) return 'stand';

    const upcard = state.dealer[0];
    const { total, soft } = handValue(hand.cards);
    const dealerShows = upcard === undefined ? 10 : handValue([upcard]).total;
    const dealerWeak = dealerShows >= 2 && dealerShows <= 6;

    // Soft hands cannot bust on the next card, so they hit far deeper.
    if (soft) return total <= 17 ? 'hit' : 'stand';
    if (total <= 11) return 'hit';
    if (total >= 17) return 'stand';
    // 12 against a 2 or 3 is the one hard-total exception worth keeping.
    if (total === 12) return dealerShows >= 4 && dealerShows <= 6 ? 'stand' : 'hit';
    return dealerWeak ? 'stand' : 'hit';
  },

  view(state: BlackjackState): Record<string, unknown> {
    const upcard = state.dealer[0];
    return {
      // Only the upcard goes out. The hole card is in the shoe the seed
      // committed to, but publishing it mid-hand would hand every player the
      // dealer's hand — the one piece of information the game is built around
      // not having.
      dealerUpcard: upcard === undefined ? null : publicCard(upcard),
      dealerCards: state.dealerBlackjack ? state.dealer.map(publicCard) : null,
      dealerBlackjack: state.dealerBlackjack,
      turnPlayerId: currentHand(state)?.playerId ?? null,
      hands: state.hands.map((hand) => ({
        playerId: hand.playerId,
        stake: hand.stake,
        cards: hand.cards.map(publicCard),
        total: handValue(hand.cards).total,
        soft: handValue(hand.cards).soft,
        bust: isBust(hand.cards),
        blackjack: isBlackjack(hand.cards),
        doubled: hand.doubled,
        finished: hand.finished,
      })),
    };
  },

  settle(state: BlackjackState): TableResolution {
    // The dealer only plays once every seat is done, and only if there is
    // anything left to beat. With every hand bust the dealer takes the table
    // without drawing, exactly as in a pit.
    const dealer = [...state.dealer];
    let cursor = state.cursor;
    const contested = state.hands.some((hand) => !isBust(hand.cards));

    if (!state.dealerBlackjack && contested) {
      while (handValue(dealer).total < DEALER_STANDS_ON) {
        dealer.push(deal(state.shoe, cursor, 1)[0] as Card);
        cursor += 1;
      }
    }

    const dealerTotal = handValue(dealer).total;
    const dealerBust = dealerTotal > 21;
    const dealerNatural = isBlackjack(dealer);

    const credits: { playerId: string; amount: number }[] = [];
    const outcomes: Record<string, unknown>[] = [];

    for (const hand of state.hands) {
      const { total } = handValue(hand.cards);
      const natural = isBlackjack(hand.cards);
      let payout = 0;
      let outcome: string;

      if (isBust(hand.cards)) {
        outcome = 'bust';
      } else if (natural && !dealerNatural) {
        // 3:2, floored — a 25-chip natural pays 37 in winnings, not 37.5.
        payout = hand.stake + Math.floor(hand.stake * BLACKJACK_PAYOUT);
        outcome = 'blackjack';
      } else if (dealerNatural && !natural) {
        outcome = 'lose';
      } else if (dealerBust || total > dealerTotal) {
        payout = hand.stake * 2;
        outcome = 'win';
      } else if (total === dealerTotal) {
        payout = hand.stake;
        outcome = 'push';
      } else {
        outcome = 'lose';
      }

      if (payout > 0) credits.push({ playerId: hand.playerId, amount: payout });
      outcomes.push({
        playerId: hand.playerId,
        cards: hand.cards.map(publicCard),
        total,
        stake: hand.stake,
        doubled: hand.doubled,
        outcome,
        payout,
      });
    }

    const dealerLine = dealerNatural
      ? 'Dealer has blackjack.'
      : dealerBust
        ? `Dealer busts with ${dealerTotal}.`
        : contested
          ? `Dealer stands on ${dealerTotal}.`
          : 'Dealer takes the table.';

    return {
      summary: dealerLine,
      detail: {
        dealer: dealer.map(publicCard),
        dealerTotal,
        dealerBust,
        dealerBlackjack: dealerNatural,
        hands: outcomes,
        written: `Dealer ${dealer.map(cardCode).join(' ')}`,
      },
      credits,
    };
  },
};

export const blackjack: TableGameDefinition = {
  id: 'blackjack',
  displayName: 'Blackjack',
  minPlayers: 1,
  maxPlayers: 6,
  minWager: 10,
  maxWager: 2_500,
  bettingWindowMs: 18_000,
  spots: [
    {
      id: 'ante',
      label: 'Deal me in',
      payout: 1,
      description: 'Even money. Blackjack pays 3 to 2. Dealer stands on all 17.',
    },
  ],

  interactive: interactive as InteractiveTableGame<never>,

  /**
   * The whole hand with nobody at the keyboard.
   *
   * This is the shape the paytable is measured in, and it is what a table of
   * players who all timed out would produce. It is deliberately the same code
   * path the live table runs, so the two cannot drift.
   */
  resolve(wagers: readonly Wager[], rng: Rng): TableResolution {
    return interactive.settle(autoPlay(interactive, interactive.begin(wagers, rng)));
  },
};

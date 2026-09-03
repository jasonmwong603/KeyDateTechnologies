import type { Rng } from '@keydate/netcode';
import { buildShoe, cardCode, deal, publicCard, type Card } from './cards.js';
import {
  autoPlay,
  NO_TABLE_LIMIT,
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
 *   - Eight-deck shoe on a continuous shuffler.
 *   - Up to three boxes per player.
 *   - Dealer stands on all 17, soft included.
 *   - Blackjack pays 3 to 2.
 *   - Double down on any first two cards, after a split included.
 *   - Split any two cards of equal value, up to three times per box.
 *   - Split aces get one card each and stand.
 *   - Late surrender: give up half the stake before taking a card.
 *   - Insurance at 2 to 1 whenever the dealer shows an ace.
 *
 * **The shoe is a continuous shuffling machine.** Every round is dealt from a
 * freshly shuffled eight-deck shoe, which is exactly what a CSM does: cards go
 * back into the machine as soon as the hand is over, so the composition of the
 * shoe never drifts away from a fresh one. That kills card counting outright,
 * which matters here rather more than in a real pit — the seed for each round
 * is published afterwards, so a counter would not even have to count.
 *
 * Boxes and splits look similar on the felt and are not the same thing. A box
 * is chosen and paid for before any card is seen; a split doubles a stake in
 * reaction to a pair that has already been dealt. Both are supported, and a
 * split hand still belongs to the box it came from — its extra chips go on that
 * box's pile, not onto a fourth box.
 */

/** Eight decks, reshuffled every round — see the note on the CSM above. */
const SHOE_DECKS = 8;

/**
 * How many hands one player may play at once.
 *
 * Each box is a separate betting spot with its own stake, so the price of
 * playing more of them is simply that each one has to meet the table minimum:
 * two boxes cost at least twice the minimum, three at least three times. That
 * rule needs no special-casing anywhere — it falls out of the spots.
 */
export const MAX_BOXES = 3;

/** The betting spots, in the order they are dealt across the felt. */
export const BOX_SPOTS = ['box-1', 'box-2', 'box-3'] as const;
const DEALER_STANDS_ON = 17;
export const BLACKJACK_PAYOUT = 1.5;

/**
 * How many times one box may be split.
 *
 * Three, so a box can become at most four hands — the usual pit limit, and the
 * point past which a player is holding more cards than fit in front of a seat.
 */
export const MAX_SPLITS = 3;

/** What a surrendered hand gets back, as a fraction of its stake. */
export const SURRENDER_RETURN = 0.5;

/**
 * Insurance: a side bet, half the stake, paying 2 to 1 if the dealer has
 * blackjack.
 *
 * It is a bad bet and it is meant to be. Roughly 4 cards in 13 give the dealer
 * the ten they need, so 2 to 1 is paid on odds nearer 2.25 to 1 — which is
 * exactly why a real pit offers it. It is here because a blackjack table
 * without it is not a blackjack table, and because refusing it is a decision a
 * player should get to make rather than one made for them.
 *
 * It is also the one bet on this floor outside the 93–100% band every other
 * spot is held to, so it is worth stating rather than burying. With eight decks
 * and an ace face up, 128 of the 415 unseen cards are tens, so the bet returns
 * 3 × 128/415 ≈ 92.5% of what is staked on it. `insuranceReturn` computes that
 * and a test holds it to the arithmetic; it is deliberately excluded from the
 * paytable sweep, which measures the spots a player bets before the deal.
 */
export const INSURANCE_SPOT = 'insurance';
export const INSURANCE_COST = 0.5;
export const INSURANCE_PAYOUT = 2;

export interface BlackjackHand {
  /**
   * Unique for the life of the round, and stable once assigned.
   *
   * A split turns one hand into two on the same box, so neither the player id
   * nor the box identifies a hand any more. Everything that has to follow one
   * across updates — the panel rows, the cards on the felt — keys off this.
   */
  handId: string;
  playerId: string;
  /**
   * Which box this hand is playing, e.g. `box-2`.
   *
   * Carried on the hand because a player can hold several at once, and a
   * double has to add its chips to the right one. Split hands keep the box they
   * came from: their chips go on that pile.
   */
  spotId: string;
  /** Chips at risk. Doubles when the player doubles down. */
  stake: number;
  cards: Card[];
  doubled: boolean;
  /**
   * How many splits this hand descends from. Zero for a hand as dealt.
   *
   * More than a counter: a two-card 21 in a split hand is an ordinary 21 and
   * pays even money, not a natural at 3 to 2.
   */
  splitDepth: number;
  /** Split from a pair of aces: one card each, and no further decision. */
  splitAces: boolean;
  /** Given up before taking a card. Half the stake comes back. */
  surrendered: boolean;
  /**
   * Chips on the insurance side bet, or 0 for a hand that declined it.
   *
   * Kept apart from `stake` because it is a different bet against a different
   * outcome: the hand can lose and the insurance still pay.
   */
  insurance: number;
  /** True once the hand can take no more cards, however that happened. */
  finished: boolean;
}

/**
 * What the table is currently asking for.
 *
 * `'insurance'` runs only when the dealer's upcard is an ace, and it runs
 * *before* the peek — every hand is asked, including hands that are about to be
 * settled by a dealer blackjack. It has to be that way round: the whole bet is
 * on the hole card, so a hand that already knew the answer would not be
 * insuring anything.
 */
export type BlackjackStage = 'insurance' | 'play';

export interface BlackjackState {
  /** Shuffled up front and never mutated; `cursor` is the only thing that moves. */
  shoe: readonly Card[];
  cursor: number;
  dealer: Card[];
  hands: BlackjackHand[];
  /** Which question the table is asking. See `BlackjackStage`. */
  stage: BlackjackStage;
  /** Index of the hand to act, or `hands.length` once every seat is done. */
  turn: number;
  /**
   * Set at the deal, but only *acted on* once the insurance round is over.
   *
   * The value is in the state from the start because the cards are already
   * dealt — what is deferred is the peek, not the deal. `view` is what keeps it
   * secret, and it must not publish the dealer's hand while `stage` is
   * `'insurance'`.
   */
  dealerBlackjack: boolean;
  /** Source of the next `handId`. Part of the state so a replay assigns the same ones. */
  nextHandId: number;
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

/** What one card is worth on its own — 11 for an ace, 10 for any face card. */
function cardValue(card: Card): number {
  return handValue([card]).total;
}

/**
 * A natural: twenty-one as dealt, paying 3 to 2.
 *
 * Split hands are excluded on purpose, and this is the rule everybody
 * remembers wrongly. Splitting a pair of aces and drawing a ten gives 21, but
 * it is not a blackjack — it pays even money. Getting this wrong hands the
 * player an extra half a stake on the single most-split hand in the game.
 */
export function isNatural(hand: Pick<BlackjackHand, 'cards' | 'splitDepth'>): boolean {
  return hand.splitDepth === 0 && isBlackjack(hand.cards);
}

/**
 * Whether a hand may be split.
 *
 * Equal *value* rather than equal rank, which is the more generous of the two
 * usual readings: a king and a jack are both worth ten, so they split. A pit
 * that insists on matching ranks is drawing a distinction the player cannot see
 * on the felt.
 *
 * Split aces are never resplit. That is redundant today — they are dealt one
 * card and finished, so nobody is ever asked — but it is the rule, and stating
 * it here is what stops a later change to the one-card rule silently taking the
 * resplit ban with it.
 */
export function canSplit(hand: BlackjackHand): boolean {
  if (hand.cards.length !== 2 || hand.splitDepth >= MAX_SPLITS) return false;
  if (hand.splitAces) return false;
  const [first, second] = hand.cards as [Card, Card];
  return cardValue(first) === cardValue(second);
}

/**
 * Whether a hand may be surrendered.
 *
 * Late surrender, and only as the very first decision: two cards, nothing
 * doubled, nothing split. Allowing it after a hit would let a player draw a
 * card and then take half their money back on seeing it, which is not a rule
 * so much as an escape hatch.
 */
export function canSurrender(hand: BlackjackHand): boolean {
  return hand.cards.length === 2 && hand.splitDepth === 0 && !hand.doubled;
}

/** What insurance costs a hand: half its stake, floored to whole chips. */
export function insuranceCost(stake: number): number {
  return Math.floor(stake * INSURANCE_COST);
}

/**
 * What the insurance bet returns per chip staked, against a fresh shoe.
 *
 * Stated as a function rather than a constant so the arithmetic is visible and
 * a test can hold it to the shoe size: with the ace face up, the tens among the
 * unseen cards are what the bet is really on.
 */
export function insuranceReturn(decks = SHOE_DECKS): number {
  const unseen = decks * 52 - 1;
  const tens = decks * 16;
  return (INSURANCE_PAYOUT + 1) * (tens / unseen);
}

// ---------------------------------------------------------------------------
// Decision phase
// ---------------------------------------------------------------------------

function currentHand(state: BlackjackState): BlackjackHand | undefined {
  return state.hands[state.turn];
}

/** Position of a box spot, or -1 for anything that is not one. */
function boxIndex(spotId: string): number {
  return (BOX_SPOTS as readonly string[]).indexOf(spotId);
}

/** "Box 2", for a hand's own label on the felt and in the panel. */
export function boxLabel(spotId: string): string {
  const index = boxIndex(spotId);
  return index < 0 ? 'Box' : `Box ${index + 1}`;
}

/**
 * Turns the dealer's second card over and settles what that decides.
 *
 * This is the peek, and it is a separate step from the deal because insurance
 * has to be bought before it happens. Once it does, a dealer blackjack ends
 * every hand at once and a player's own natural stands itself.
 */
function peek(state: BlackjackState): BlackjackState {
  const hands = state.hands.map((hand) =>
    state.dealerBlackjack || isNatural(hand) ? { ...hand, finished: true } : hand,
  );
  return { ...state, stage: 'play', hands, turn: 0 };
}

/**
 * Moves the turn on to the next hand that still has a choice to make.
 *
 * In the insurance round every hand is asked, finished or not — a hand about to
 * be settled by a dealer blackjack is precisely the one with a reason to insure.
 * Running off the end of that round is what triggers the peek, and the play
 * round then starts from the top.
 */
function advance(state: BlackjackState): BlackjackState {
  if (state.stage === 'insurance') {
    if (state.turn < state.hands.length) return state;
    return advance(peek(state));
  }

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
    const boxes = wagers.filter((wager) => boxIndex(wager.spotId) >= 0);

    // Order is part of what the seed reproduces, so it has to be a function of
    // the wagers rather than of whatever order they happened to arrive in.
    // Players keep the order they first bet in, and a player's own boxes run
    // left to right — which is how they are laid out on the felt.
    const seatOrder = new Map<string, number>();
    for (const wager of boxes) {
      if (!seatOrder.has(wager.playerId)) seatOrder.set(wager.playerId, seatOrder.size);
    }
    const ordered = [...boxes].sort(
      (a, b) =>
        (seatOrder.get(a.playerId) ?? 0) - (seatOrder.get(b.playerId) ?? 0) ||
        boxIndex(a.spotId) - boxIndex(b.spotId),
    );

    // Dealt round the table then to the dealer, twice, as at a real table. The
    // order matters: it is fixed by the shoe, and the shoe is fixed by the
    // committed seed, so this is part of what the fairness proof covers.
    let cursor = 0;
    const hands: BlackjackHand[] = ordered.map((wager, index) => ({
      handId: `h${index + 1}`,
      playerId: wager.playerId,
      spotId: wager.spotId,
      stake: wager.amount,
      cards: [],
      doubled: false,
      splitDepth: 0,
      splitAces: false,
      surrendered: false,
      insurance: 0,
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

    // An ace face up opens the insurance round, and the peek waits for it. Any
    // other upcard peeks immediately, which is the ordinary case: a natural
    // stands itself, and nobody acts against a dealer natural.
    const dealt: BlackjackState = {
      shoe,
      cursor,
      dealer,
      hands,
      stage: 'insurance',
      turn: 0,
      dealerBlackjack: isBlackjack(dealer),
      nextHandId: hands.length + 1,
    };

    const upcard = dealer[0];
    const offersInsurance = hands.length > 0 && upcard !== undefined && upcard.rank === 'A';
    return advance(offersInsurance ? dealt : peek(dealt));
  },

  actor(state: BlackjackState): string | null {
    return currentHand(state)?.playerId ?? null;
  },

  actions(state: BlackjackState): TableAction[] {
    const hand = currentHand(state);
    if (hand === undefined) return [];

    // The insurance round asks one question and takes either answer. `decline`
    // exists because the turn has to move on somehow, and there is no other
    // action to move it: the hand has not been offered its cards yet.
    if (state.stage === 'insurance') {
      const cost = insuranceCost(hand.stake);
      return [
        {
          id: 'insure',
          label: 'Insure',
          hint: `${cost.toLocaleString()} against a dealer blackjack, pays 2 to 1`,
        },
        { id: 'decline', label: 'No insurance', hint: 'Play the hand as dealt' },
      ];
    }

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
    if (canSplit(hand)) {
      options.push({
        id: 'split',
        label: 'Split',
        hint: `Two hands, ${hand.stake.toLocaleString()} on each`,
      });
    }
    if (canSurrender(hand)) {
      options.push({
        id: 'surrender',
        label: 'Surrender',
        hint: `Fold for ${Math.floor(hand.stake * SURRENDER_RETURN).toLocaleString()} back`,
      });
    }
    return options;
  },

  stakeDelta(state: BlackjackState, actionId: string): number {
    const hand = currentHand(state);
    if (hand === undefined) return 0;

    if (state.stage === 'insurance') {
      return actionId === 'insure' ? insuranceCost(hand.stake) : 0;
    }
    // Both moves that cost chips cost exactly one more stake: doubling buys a
    // second bet on the same hand, splitting buys the same bet on a second one.
    if (actionId === 'double') return hand.cards.length === 2 ? hand.stake : 0;
    if (actionId === 'split') return canSplit(hand) ? hand.stake : 0;
    return 0;
  },

  /**
   * Which spot on the felt the extra chips belong to.
   *
   * A player holding three boxes has three wagers on the felt. Doubling the
   * middle one must not quietly add the chips to the first.
   *
   * Insurance goes on a spot of its own rather than onto the box, because it is
   * a different bet against a different outcome — the box can lose while the
   * insurance pays. Putting them on one pile would make the felt claim the hand
   * was playing for more than it was.
   */
  activeSpot(state: BlackjackState): string | null {
    if (state.stage === 'insurance') return INSURANCE_SPOT;
    return currentHand(state)?.spotId ?? null;
  },

  apply(state: BlackjackState, actionId: string): BlackjackState {
    const hand = currentHand(state);
    if (hand === undefined) return state;

    // The insurance round. Either answer moves to the next hand, and running
    // off the end of the list is what makes the dealer peek — see `advance`.
    if (state.stage === 'insurance') {
      const hands = [...state.hands];
      if (actionId === 'insure') {
        hands[state.turn] = { ...hand, insurance: insuranceCost(hand.stake) };
      }
      return advance({ ...state, hands, turn: state.turn + 1 });
    }

    if (actionId === 'stand') {
      const hands = [...state.hands];
      hands[state.turn] = { ...hand, finished: true };
      return advance({ ...state, hands });
    }

    if (actionId === 'surrender' && canSurrender(hand)) {
      const hands = [...state.hands];
      hands[state.turn] = { ...hand, surrendered: true, finished: true };
      return advance({ ...state, hands });
    }

    if (actionId === 'split' && canSplit(hand)) {
      // Both halves are given their second card straight away, rather than the
      // pit's order of playing the first hand right out before the second is
      // even dealt.
      //
      // That is a real difference, not just a presentational one: hit the first
      // hand and the pit's second half would get a later card off the shoe than
      // it gets here. It is a house rule either way, chosen because the player
      // can then see both hands before deciding anything about either. What it
      // does not affect is the fairness proof — every card still comes off the
      // committed shoe in cursor order, so the round replays exactly.
      const [first, second] = hand.cards as [Card, Card];
      const aces = first.rank === 'A';
      const depth = hand.splitDepth + 1;

      const half = (card: Card, drawn: Card, handId: string, insurance: number): BlackjackHand => {
        const cards = [card, drawn];
        return {
          ...hand,
          handId,
          cards,
          insurance,
          splitDepth: depth,
          splitAces: aces,
          // Split aces get exactly one card each. Without that rule a pair of
          // aces is the strongest hand in the game to keep hitting.
          finished: aces || handValue(cards).total >= 21,
        };
      };

      // One insurance bet was bought, so one insurance bet is settled. It stays
      // with the left half rather than being copied onto both.
      //
      // Unreachable today — insurance only ever pays on a dealer natural, and a
      // dealer natural finishes every hand at the peek, so nobody insured is
      // ever offered a split. That is exactly why it is worth being explicit:
      // the alternative is a double payout resting on an invariant two rules
      // away, which a change to the peek would break without a sound.
      const hands = [...state.hands];
      hands.splice(
        state.turn,
        1,
        half(first, deal(state.shoe, state.cursor, 1)[0] as Card, hand.handId, hand.insurance),
        half(second, deal(state.shoe, state.cursor + 1, 1)[0] as Card, `h${state.nextHandId}`, 0),
      );
      return advance({
        ...state,
        hands,
        cursor: state.cursor + 2,
        nextHandId: state.nextHandId + 1,
      });
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
   * A simplified basic strategy: it plays the standard hard and soft totals
   * against the dealer's upcard. Standing on everything would be simpler and
   * noticeably worse for the absent player, which is the wrong default when the
   * table is deciding on their behalf.
   *
   * It never doubles, splits, insures or surrenders. The first three would
   * spend chips the player did not choose to spend; the last would give away
   * half a stake they never agreed to give away. All four are the player's call
   * and nobody else's, so the table declines to make it for them. Insurance is
   * the clearest of the four: it is a losing bet on average, and buying one for
   * somebody who has walked away from the table would be indefensible.
   *
   * This is also what keeps the paytable honest. `resolve` plays every hand
   * through here, and the 200,000-hand expected-return test measures that — so
   * the measured return is the return of a table nobody is helping, which is
   * the conservative direction to be wrong in.
   */
  autoAction(state: BlackjackState): string {
    const hand = currentHand(state);
    if (hand === undefined) return 'stand';
    if (state.stage === 'insurance') return 'decline';

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

    // The peek has not happened yet during the insurance round, and nothing
    // about the hole card may leave the server until it has.
    //
    // This is the one place where a leak would be worth money rather than just
    // untidy: insurance is a bet on precisely this card, so publishing
    // `dealerBlackjack` a moment early would let a client buy a certainty. Both
    // fields are gated on the stage, not on `dealerBlackjack` itself — a field
    // that is only ever sent when true tells you as much by its absence.
    const peeked = state.stage === 'play';

    return {
      // Only the upcard goes out. The hole card is in the shoe the seed
      // committed to, but publishing it mid-hand would hand every player the
      // dealer's hand — the one piece of information the game is built around
      // not having.
      dealerUpcard: upcard === undefined ? null : publicCard(upcard),
      dealerCards: peeked && state.dealerBlackjack ? state.dealer.map(publicCard) : null,
      dealerBlackjack: peeked && state.dealerBlackjack,
      stage: state.stage,
      turnPlayerId: currentHand(state)?.playerId ?? null,
      hands: state.hands.map((hand) => ({
        handId: hand.handId,
        playerId: hand.playerId,
        spotId: hand.spotId,
        box: boxLabel(hand.spotId),
        stake: hand.stake,
        cards: hand.cards.map(publicCard),
        total: handValue(hand.cards).total,
        soft: handValue(hand.cards).soft,
        bust: isBust(hand.cards),
        blackjack: isNatural(hand),
        doubled: hand.doubled,
        split: hand.splitDepth > 0,
        surrendered: hand.surrendered,
        insurance: hand.insurance,
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
    // A surrendered hand is out, exactly like a bust one: the dealer has nothing
    // left to beat and does not draw for it.
    const contested = state.hands.some((hand) => !isBust(hand.cards) && !hand.surrendered);

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
      const natural = isNatural(hand);
      let payout = 0;
      let outcome: string;

      if (hand.surrendered) {
        // Half back, floored — a 25-chip surrender returns 12, not 12.5. The
        // rounding goes to the house here for the same reason it goes to the
        // player on a natural: chips are whole, and the direction has to be
        // fixed rather than decided case by case.
        payout = Math.floor(hand.stake * SURRENDER_RETURN);
        outcome = 'surrender';
      } else if (isBust(hand.cards)) {
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

      // Insurance settles on its own, against the dealer's hand rather than
      // against this one. A hand can lose and its insurance still pay — that is
      // the entire point of it — so the two are added, never merged into one
      // verdict.
      //
      // Insured, and the dealer turns over a natural: the hand loses its stake
      // and the insurance returns three times half of it, which is the stake
      // back. That break-even is what the bet is sold on, and it is also why it
      // is a bad bet: it only breaks even on the third of hands where it wins.
      const insuranceBack =
        hand.insurance > 0 && dealerNatural ? hand.insurance * (INSURANCE_PAYOUT + 1) : 0;
      const returned = payout + insuranceBack;

      if (returned > 0) credits.push({ playerId: hand.playerId, amount: returned });
      outcomes.push({
        handId: hand.handId,
        playerId: hand.playerId,
        spotId: hand.spotId,
        box: boxLabel(hand.spotId),
        cards: hand.cards.map(publicCard),
        total,
        stake: hand.stake,
        doubled: hand.doubled,
        split: hand.splitDepth > 0,
        insurance: hand.insurance,
        insurancePayout: insuranceBack,
        outcome,
        payout: returned,
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
  // Bet what you hold. The ledger is the only ceiling — see NO_TABLE_LIMIT.
  maxWager: NO_TABLE_LIMIT,
  // Nothing happens until somebody calls the deal; this is the last call that
  // follows, so a table of six all get their bets down before the cards come out.
  bettingClose: 'on-demand',
  bettingWindowMs: 10_000,
  /**
   * One spot per box, and the minimum on each rises with how many you play.
   *
   * This is the pit rule: a player taking two hands must bet at least twice the
   * table minimum on *each* of them, three hands three times. It is not a
   * penalty — it is what stops one player occupying half the felt for the price
   * of one seat, and it is why the descriptions spell the numbers out.
   */
  spots: [
    {
      id: 'box-1',
      label: 'Box 1',
      payout: 1,
      description:
        'Even money. Blackjack pays 3 to 2. Dealer stands on all 17. ' +
        'Double, split equal cards, or surrender for half. Minimum 10.',
    },
    {
      id: 'box-2',
      label: 'Box 2',
      payout: 1,
      description: 'A second hand. Playing two means at least 20 on each of them.',
    },
    {
      id: 'box-3',
      label: 'Box 3',
      payout: 1,
      description: 'A third hand. Playing three means at least 30 on each of them.',
    },
    {
      id: INSURANCE_SPOT,
      label: 'Insurance',
      payout: INSURANCE_PAYOUT,
      description:
        'Offered only when the dealer shows an ace. Half your stake, paying 2 to 1 ' +
        'if the dealer has blackjack. It returns about 92 chips per 100 staked.',
      // Not a bet you place — the table offers it against the upcard, and the
      // runtime refuses it during the betting window.
      derived: true,
    },
  ],

  /**
   * The rising minimum, checked against the whole of a player's felt.
   *
   * Adding a box raises the bar on the boxes already down, not just the new
   * one — so opening a second hand while the first is still at the single-box
   * minimum is refused, with the number the player needs.
   */
  checkWager({ existing, spotId, amount }): string | null {
    if (boxIndex(spotId) < 0) return null;

    const after = new Map(
      existing.filter((wager) => boxIndex(wager.spotId) >= 0).map((w) => [w.spotId, w.amount]),
    );
    after.set(spotId, (after.get(spotId) ?? 0) + amount);

    const boxes = after.size;
    if (boxes <= 1) return null;

    const required = blackjack.minWager * boxes;
    for (const [id, staked] of after) {
      if (staked >= required) continue;
      const which = id === spotId ? 'this box' : boxLabel(id).toLowerCase();
      return `Playing ${boxes} boxes needs ${required} on each — ${which} is short.`;
    }
    return null;
  },

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

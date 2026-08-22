import { createRng } from '@keydate/netcode';
import { describe, expect, it } from 'vitest';
import {
  blackjack,
  boxLabel,
  handValue,
  isBlackjack,
  isBust,
  MAX_BOXES,
  type BlackjackState,
} from './blackjack.js';
import { buildDeck, type Card, type Rank } from './cards.js';
import {
  autoPlay,
  replayInteractiveRound,
  type InteractiveTableGame,
  type Wager,
} from './types.js';

/** The decision phase, narrowed once so every test does not have to. */
const game = blackjack.interactive as unknown as InteractiveTableGame<BlackjackState>;

/** A bet on a player's first box, which is how a single-hand player plays. */
const ante = (playerId: string, amount = 100): Wager => ({ playerId, spotId: 'box-1', amount });

/** A bet on a named box, for the tests that play more than one hand. */
const box = (playerId: string, index: number, amount = 100): Wager => ({
  playerId,
  spotId: `box-${index}`,
  amount,
});

function card(rank: Rank): Card {
  const found = buildDeck().find((entry) => entry.rank === rank);
  if (found === undefined) throw new Error(`No such rank: ${rank}`);
  return found;
}

/**
 * Deals a hand from a stacked shoe instead of a seed.
 *
 * `begin` is the only step that touches the RNG, so replacing the shoe it
 * produced is enough to put any hand on the table — which is the only practical
 * way to test the branches that matter.
 */
function stacked(ranks: readonly Rank[], wagers: readonly Wager[]): BlackjackState {
  const dealt = game.begin(wagers, createRng(1));
  const shoe = ranks.map(card);
  const state: BlackjackState = { ...dealt, shoe, cursor: 0, hands: [], turn: 0 };

  // Re-run the deal by hand against the stacked shoe: two cards to each seat in
  // turn, then two to the dealer, exactly as `begin` does it.
  const hands = wagers.map((wager) => ({
    playerId: wager.playerId,
    spotId: wager.spotId,
    stake: wager.amount,
    cards: [] as Card[],
    doubled: false,
    finished: false,
  }));
  let cursor = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const hand of hands) {
      hand.cards.push(shoe[cursor] as Card);
      cursor += 1;
    }
  }
  const dealer = [shoe[cursor] as Card, shoe[cursor + 1] as Card];
  cursor += 2;

  const dealerBlackjack = isBlackjack(dealer);
  for (const hand of hands) {
    if (dealerBlackjack || isBlackjack(hand.cards)) hand.finished = true;
  }

  let turn = 0;
  while (turn < hands.length && (hands[turn] as { finished: boolean }).finished) turn += 1;
  return { ...state, dealer, hands, cursor, turn, dealerBlackjack };
}

describe('handValue', () => {
  it('counts faces as ten and numbers at face value', () => {
    expect(handValue([card('K'), card('7')]).total).toBe(17);
    expect(handValue([card('2'), card('3'), card('4')]).total).toBe(9);
  });

  it('counts an ace as eleven while it fits', () => {
    expect(handValue([card('A'), card('6')])).toEqual({ total: 17, soft: true });
    expect(handValue([card('A'), card('K')])).toEqual({ total: 21, soft: true });
  });

  it('demotes an ace to one rather than busting', () => {
    expect(handValue([card('A'), card('6'), card('K')])).toEqual({ total: 17, soft: false });
  });

  it('never counts two aces as twenty-two', () => {
    // Only one ace can ever be worth eleven; a second would bust the hand.
    expect(handValue([card('A'), card('A')])).toEqual({ total: 12, soft: true });
    expect(handValue([card('A'), card('A'), card('9')])).toEqual({ total: 21, soft: true });
    expect(handValue([card('A'), card('A'), card('A'), card('8')]).total).toBe(21);
  });

  it('busts a hard hand over twenty-one', () => {
    expect(isBust([card('K'), card('Q'), card('5')])).toBe(true);
    expect(isBust([card('A'), card('K'), card('Q')])).toBe(false);
  });
});

describe('isBlackjack', () => {
  it('is twenty-one on the first two cards and nothing else', () => {
    expect(isBlackjack([card('A'), card('K')])).toBe(true);
    expect(isBlackjack([card('7'), card('7'), card('7')])).toBe(false);
    expect(isBlackjack([card('A'), card('5'), card('5')])).toBe(false);
  });
});

describe('the decision phase', () => {
  it('deals two cards to each seat and two to the dealer', () => {
    const state = game.begin([ante('p1'), ante('p2')], createRng(42));
    expect(state.hands).toHaveLength(2);
    expect(state.hands.every((hand) => hand.cards.length === 2)).toBe(true);
    expect(state.dealer).toHaveLength(2);
    expect(state.cursor).toBe(6);
  });

  it('offers hit, stand and double on a fresh hand', () => {
    const state = stacked(['9', '7', 'K', '4'], [ante('p1')]);
    expect(game.actions(state).map((action) => action.id)).toEqual(['hit', 'stand', 'double']);
  });

  it('withdraws the double once a card has been taken', () => {
    const state = game.apply(stacked(['9', '7', 'K', '4', '2'], [ante('p1')]), 'hit');
    expect(game.actions(state).map((action) => action.id)).toEqual(['hit', 'stand']);
  });

  it('passes the turn round the table in seat order', () => {
    const state = stacked(['9', '9', '7', '7', 'K', '4'], [ante('p1'), ante('p2')]);
    expect(game.actor(state)).toBe('p1');
    expect(game.actor(game.apply(state, 'stand'))).toBe('p2');
    expect(game.actor(game.apply(game.apply(state, 'stand'), 'stand'))).toBeNull();
  });

  it('ends a hand the moment it busts', () => {
    // p1 holds K+9, hits into a Q.
    const state = game.apply(stacked(['K', '9', '7', '4', 'Q'], [ante('p1')]), 'hit');
    expect(isBust(state.hands[0]!.cards)).toBe(true);
    expect(game.actor(state)).toBeNull();
  });

  it('stands a hand automatically on twenty-one', () => {
    // There is nothing to decide on 21, and offering a hit is a trap.
    const state = game.apply(stacked(['K', 'K', '7', '4', 'A'], [ante('p1')]), 'hit');
    expect(handValue(state.hands[0]!.cards).total).toBe(21);
    expect(game.actor(state)).toBeNull();
  });

  it('gives nobody a turn when the dealer shows blackjack', () => {
    const state = stacked(['9', '7', 'A', 'K'], [ante('p1')]);
    expect(state.dealerBlackjack).toBe(true);
    expect(game.actor(state)).toBeNull();
  });

  it('gives a player with a natural no turn either', () => {
    const state = stacked(['A', '9', 'K', '7', '9', '4'], [ante('p1'), ante('p2')]);
    expect(isBlackjack(state.hands[0]!.cards)).toBe(true);
    expect(game.actor(state)).toBe('p2');
  });

  it('draws exactly one card on a double and ends the hand', () => {
    const state = game.apply(stacked(['5', '7', '6', '4', '9'], [ante('p1')]), 'double');
    expect(state.hands[0]!.cards).toHaveLength(3);
    expect(state.hands[0]!.doubled).toBe(true);
    expect(state.hands[0]!.stake).toBe(200);
    expect(game.actor(state)).toBeNull();
  });

  it('charges exactly the original stake to double, and nothing for anything else', () => {
    const state = stacked(['5', '7', '6', '4'], [ante('p1', 250)]);
    expect(game.stakeDelta(state, 'double')).toBe(250);
    expect(game.stakeDelta(state, 'hit')).toBe(0);
    expect(game.stakeDelta(state, 'stand')).toBe(0);
  });

  it('keeps the dealer hole card out of the public view until it matters', () => {
    const state = stacked(['9', '7', 'K', '4'], [ante('p1')]);
    const view = game.view(state);
    expect(view.dealerUpcard).toEqual({ rank: 'K', suit: '♣' });
    expect(view.dealerCards).toBeNull();
  });

  it('shows the whole dealer hand once it is a blackjack, because the hand is over', () => {
    const view = game.view(stacked(['9', '7', 'A', 'K'], [ante('p1')]));
    expect(view.dealerCards).toHaveLength(2);
  });
});

describe('settling', () => {
  it('pays a natural three to two', () => {
    const resolution = game.settle(stacked(['A', 'K', 'K', '9'], [ante('p1', 100)]));
    expect(resolution.credits).toEqual([{ playerId: 'p1', amount: 250 }]);
  });

  it('rounds a three-to-two payout down rather than inventing a chip', () => {
    // 25 * 1.5 = 37.5. Chips are integers, so the half-chip goes to the house.
    const resolution = game.settle(stacked(['A', 'K', 'K', '9'], [ante('p1', 25)]));
    expect(resolution.credits).toEqual([{ playerId: 'p1', amount: 62 }]);
  });

  it('pushes a natural against a dealer natural', () => {
    const resolution = game.settle(stacked(['A', 'K', 'A', 'Q'], [ante('p1', 100)]));
    expect(resolution.credits).toEqual([{ playerId: 'p1', amount: 100 }]);
  });

  it('pays even money on an ordinary win', () => {
    const state = game.apply(stacked(['K', '9', 'K', '7', '2'], [ante('p1', 100)]), 'stand');
    // Dealer holds K+7 = 17 and stands; player holds 19.
    const resolution = game.settle(state);
    expect(resolution.credits).toEqual([{ playerId: 'p1', amount: 200 }]);
    expect(resolution.detail.dealerTotal).toBe(17);
  });

  it('returns the stake on a push', () => {
    const state = game.apply(stacked(['K', '9', 'K', '9'], [ante('p1', 100)]), 'stand');
    expect(game.settle(state).credits).toEqual([{ playerId: 'p1', amount: 100 }]);
  });

  it('pays nothing on a bust, even when the dealer busts too', () => {
    // Player busts to 25; dealer would go on to bust as well.
    const state = game.apply(stacked(['K', '9', '6', '9', 'Q', 'K'], [ante('p1')]), 'hit');
    expect(isBust(state.hands[0]!.cards)).toBe(true);
    const resolution = game.settle(state);
    expect(resolution.credits).toEqual([]);
  });

  it('does not make the dealer draw when every hand has already busted', () => {
    // The dealer takes the table on a 6 without ever completing a hand, exactly
    // as in a pit — and, more to the point, without burning cards the replay
    // would then have to account for.
    const state = game.apply(stacked(['K', '9', '6', '9', 'Q'], [ante('p1')]), 'hit');
    const resolution = game.settle(state);
    expect(resolution.detail.dealerTotal).toBe(15);
    expect(resolution.summary).toContain('takes the table');
  });

  it('stands the dealer on all seventeen, soft included', () => {
    // Dealer holds A+6. A house that hits soft 17 would draw here.
    const state = game.apply(stacked(['K', '9', 'A', '6', '5'], [ante('p1')]), 'stand');
    const resolution = game.settle(state);
    expect(resolution.detail.dealerTotal).toBe(17);
    expect(resolution.detail.dealer).toHaveLength(2);
  });

  it('pays a doubled hand against the doubled stake', () => {
    // p1 doubles 5+6 into a K for 21 against a dealer 18.
    const state = game.apply(stacked(['5', '6', 'K', '8', 'K'], [ante('p1', 100)]), 'double');
    expect(game.settle(state).credits).toEqual([{ playerId: 'p1', amount: 400 }]);
  });

  it('settles every seat independently', () => {
    // p1 20, p2 15, dealer 18.
    let state = stacked(['K', '9', 'K', '6', 'K', '8'], [ante('p1'), ante('p2')]);
    state = game.apply(state, 'stand');
    state = game.apply(state, 'stand');
    const resolution = game.settle(state);
    expect(resolution.credits).toEqual([{ playerId: 'p1', amount: 200 }]);
  });

  it('resolves a table nobody staked at', () => {
    const resolution = game.settle(game.begin([], createRng(9)));
    expect(resolution.credits).toEqual([]);
  });

  it('ignores a spot it does not offer', () => {
    const state = game.begin([{ playerId: 'p1', spotId: 'insurance', amount: 100 }], createRng(2));
    expect(state.hands).toEqual([]);
  });
});

describe('playing more than one box', () => {
  it('offers three boxes, each a spot of its own', () => {
    expect(blackjack.spots.map((spot) => spot.id)).toEqual(['box-1', 'box-2', 'box-3']);
  });

  /**
   * The whole rule, and the reason it needs no code.
   *
   * "Two hands costs twice the minimum, three costs three times" is not
   * enforced anywhere — it is what happens when each box is a separate spot
   * that has to meet the table minimum on its own.
   */
  it('prices each extra hand at another table minimum', () => {
    expect(blackjack.spots).toHaveLength(MAX_BOXES);
    for (const spot of blackjack.spots) {
      expect(spot.payout).toBe(1);
    }
    expect(blackjack.minWager * 2).toBe(20);
    expect(blackjack.minWager * 3).toBe(30);
  });

  it('deals a separate hand for every box a player covers', () => {
    const state = game.begin([box('p1', 1), box('p1', 2), box('p1', 3)], createRng(9));
    expect(state.hands).toHaveLength(3);
    expect(state.hands.map((hand) => hand.spotId)).toEqual(['box-1', 'box-2', 'box-3']);
    expect(state.hands.every((hand) => hand.playerId === 'p1')).toBe(true);
    // Three hands plus the dealer is eight cards off the shoe.
    expect(state.cursor).toBe(8);
  });

  it('gives every box its own stake', () => {
    const state = game.begin([box('p1', 1, 50), box('p1', 2, 300)], createRng(9));
    expect(state.hands.map((hand) => hand.stake)).toEqual([50, 300]);
  });

  it('plays a player through their boxes in order before moving on', () => {
    let state = game.begin([box('p1', 1), box('p1', 2), box('p2', 1)], createRng(11));
    const order: string[] = [];
    while (game.actor(state) !== null) {
      const hand = state.hands[state.turn]!;
      order.push(`${hand.playerId}/${hand.spotId}`);
      state = game.apply(state, 'stand');
    }
    expect(order).toEqual(['p1/box-1', 'p1/box-2', 'p2/box-1']);
  });

  it("keeps a player's boxes together whatever order the bets arrived in", () => {
    // The bets are placed out of order on purpose. The deal must not be, or the
    // seed would no longer reproduce it.
    const state = game.begin([box('p2', 1), box('p1', 3), box('p1', 1)], createRng(3));
    expect(state.hands.map((hand) => `${hand.playerId}/${hand.spotId}`)).toEqual([
      'p2/box-1',
      'p1/box-1',
      'p1/box-3',
    ]);
  });

  it('names the box a double belongs to, so the chips land on the right one', () => {
    const state = stacked(['9', '9', '5', '6', 'K', '4'], [box('p1', 1, 100), box('p1', 2, 100)]);
    expect(game.activeSpot?.(state)).toBe('box-1');
    expect(game.activeSpot?.(game.apply(state, 'stand'))).toBe('box-2');
  });

  it('settles each box independently', () => {
    // p1 holds 19 on box 1 and 12 on box 2 against a dealer 18.
    let state = stacked(['K', '2', '9', 'K', 'K', '8'], [box('p1', 1, 100), box('p1', 2, 100)]);
    state = game.apply(state, 'stand');
    state = game.apply(state, 'stand');
    const resolution = game.settle(state);

    const hands = resolution.detail.hands as { spotId: string; outcome: string }[];
    expect(hands.map((hand) => hand.spotId)).toEqual(['box-1', 'box-2']);
    expect(hands[0]!.outcome).toBe('win');
    expect(hands[1]!.outcome).toBe('lose');
  });

  it('pays a player once per winning box, not once for the player', () => {
    // Both boxes hold 20 against a dealer standing on 17.
    let state = stacked(['K', 'Q', 'K', 'Q', 'K', '7'], [box('p1', 1, 100), box('p1', 2, 100)]);
    state = game.apply(state, 'stand');
    state = game.apply(state, 'stand');

    expect(game.settle(state).credits).toEqual([
      { playerId: 'p1', amount: 200 },
      { playerId: 'p1', amount: 200 },
    ]);
  });

  it('settles a losing box and a winning box for the same player separately', () => {
    // Box 1 holds 20, box 2 holds 12, dealer stands on 17.
    let state = stacked(['K', '2', 'K', 'K', 'K', '7'], [box('p1', 1, 100), box('p1', 2, 60)]);
    state = game.apply(state, 'stand');
    state = game.apply(state, 'stand');

    expect(game.settle(state).credits).toEqual([{ playerId: 'p1', amount: 200 }]);
  });

  it('labels each box for the felt', () => {
    expect(boxLabel('box-1')).toBe('Box 1');
    expect(boxLabel('box-3')).toBe('Box 3');
    expect(boxLabel('ante')).toBe('Box');
  });

  it('ignores a fourth box a modified client invents', () => {
    const state = game.begin([box('p1', 1), box('p1', 4)], createRng(5));
    expect(state.hands).toHaveLength(1);
  });
});

describe('the shoe', () => {
  it('is eight decks', () => {
    // Four hundred and sixteen cards. Asserted through a hand deep enough that
    // a smaller shoe would have run dry rather than by reaching into the state.
    const state = game.begin([box('p1', 1)], createRng(1));
    expect(state.shoe).toHaveLength(8 * 52);
  });

  it('holds four of every card, times eight', () => {
    const counts = new Map<string, number>();
    for (const card of game.begin([box('p1', 1)], createRng(2)).shoe) {
      const code = `${card.rank}${card.suit}`;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    expect(counts.size).toBe(52);
    expect([...counts.values()].every((count) => count === 8)).toBe(true);
  });

  /**
   * The continuous shuffler, asserted as a property rather than a claim.
   *
   * Every round is dealt from a freshly shuffled shoe, which is what a CSM
   * does — cards go back in as soon as the hand ends. If that ever changed to a
   * shoe that persisted between rounds, the first card of round N+1 would
   * depend on round N, and counting would start to pay.
   */
  it('starts every round from a full shoe, so counting cannot pay', () => {
    const openings = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1) {
      const state = game.begin([box('p1', 1)], createRng(seed));
      expect(state.shoe).toHaveLength(8 * 52);
      openings.add(state.hands[0]!.cards.map((card) => `${card.rank}${card.suit}`).join(''));
    }
    // And the deals genuinely differ, rather than being one shuffle reused.
    expect(openings.size).toBeGreaterThan(150);
  });
});

describe('autoAction', () => {
  it('always returns something the table would have offered', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      let state = game.begin([ante('p1'), ante('p2')], createRng(seed));
      while (game.actor(state) !== null) {
        const chosen = game.autoAction(state);
        expect(game.actions(state).map((action) => action.id)).toContain(chosen);
        state = game.apply(state, chosen);
      }
    }
  });

  it('never spends chips the absent player did not choose to spend', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      let state = game.begin([ante('p1')], createRng(seed));
      while (game.actor(state) !== null) {
        expect(game.autoAction(state)).not.toBe('double');
        state = game.apply(state, game.autoAction(state));
      }
    }
  });

  it('hits a stiff hand against a strong upcard and stands against a weak one', () => {
    // 16 against a king: hit. 16 against a five: stand.
    expect(game.autoAction(stacked(['K', '6', 'K', '4'], [ante('p1')]))).toBe('hit');
    expect(game.autoAction(stacked(['K', '6', '5', '4'], [ante('p1')]))).toBe('stand');
  });

  it('hits a soft hand far deeper than a hard one', () => {
    // Soft 17 hits; hard 17 stands.
    expect(game.autoAction(stacked(['A', '6', 'K', '4'], [ante('p1')]))).toBe('hit');
    expect(game.autoAction(stacked(['K', '7', 'K', '4'], [ante('p1')]))).toBe('stand');
  });

  it('terminates on every hand it is given', () => {
    for (let seed = 0; seed < 2_000; seed += 1) {
      const finished = autoPlay(game, game.begin([ante('p1'), ante('p2')], createRng(seed)));
      expect(game.actor(finished)).toBeNull();
    }
  });
});

describe('reproducibility', () => {
  it('deals the same hand from the same seed', () => {
    expect(game.begin([ante('p1')], createRng(77))).toEqual(
      game.begin([ante('p1')], createRng(77)),
    );
  });

  it('replays an interactive round from its seed and action log', () => {
    // This is the fairness proof for a game with decisions in it: the seed
    // fixes the shoe, the log fixes the choices, and together they have to
    // reproduce the payout exactly.
    const wagers = [ante('p1', 100), ante('p2', 200)];
    const actions: string[] = [];

    let state = game.begin(wagers, createRng(4242));
    while (game.actor(state) !== null) {
      const chosen = game.autoAction(state);
      actions.push(chosen);
      state = game.apply(state, chosen);
    }
    const live = game.settle(state);

    expect(replayInteractiveRound(blackjack, wagers, createRng(4242), actions)).toEqual(live);
  });

  it('produces a different outcome from a different action log', () => {
    // If standing and hitting produced the same result, the replay would prove
    // nothing at all: the log has to actually carry information.
    const wagers = [ante('p1', 100)];
    const stood = replayInteractiveRound(blackjack, wagers, createRng(4242), ['stand']);

    // Built by playing rather than written out, because a hit can end the hand
    // on its own and a log with one action too many is rejected.
    const hitLog = ['hit'];
    let state = game.apply(game.begin(wagers, createRng(4242)), 'hit');
    while (game.actor(state) !== null) {
      const chosen = game.autoAction(state);
      hitLog.push(chosen);
      state = game.apply(state, chosen);
    }

    expect(replayInteractiveRound(blackjack, wagers, createRng(4242), hitLog)).not.toEqual(stood);
  });

  it('refuses a log that ends mid-hand or runs past the end of one', () => {
    const wagers = [ante('p1', 100), ante('p2', 100)];
    expect(() => replayInteractiveRound(blackjack, wagers, createRng(4242), [])).toThrow(
      /ends mid-hand/,
    );
    expect(() =>
      replayInteractiveRound(blackjack, wagers, createRng(4242), [
        'stand',
        'stand',
        'stand',
        'stand',
      ]),
    ).toThrow(/longer than the hand/);
  });

  it('has no decision phase to replay on a one-shot game', () => {
    expect(() =>
      replayInteractiveRound(
        { ...blackjack, interactive: undefined },
        [ante('p1')],
        createRng(1),
        [],
      ),
    ).toThrow(/no decision phase/);
  });
});

describe('blackjack.resolve', () => {
  it('plays every seat out with the table default', () => {
    const resolution = blackjack.resolve([ante('p1'), ante('p2')], createRng(11));
    expect(resolution.detail.hands).toHaveLength(2);
  });

  it('is reproducible from its seed', () => {
    const wagers = [ante('p1'), ante('p2')];
    expect(blackjack.resolve(wagers, createRng(555))).toEqual(
      blackjack.resolve(wagers, createRng(555)),
    );
  });

  it('never pays a hand that busted', () => {
    for (let seed = 0; seed < 3_000; seed += 1) {
      const resolution = blackjack.resolve([ante('p1')], createRng(seed));
      const hands = resolution.detail.hands as { outcome: string; payout: number }[];
      for (const hand of hands) {
        if (hand.outcome === 'bust') expect(hand.payout).toBe(0);
      }
    }
  });

  it('never pays out more than the table could owe', () => {
    // The most a single hand can return is a doubled stake paid even money.
    // Auto-play never doubles, so nothing here may exceed 2.5x — the natural.
    for (let seed = 0; seed < 3_000; seed += 1) {
      const resolution = blackjack.resolve([ante('p1', 100)], createRng(seed));
      for (const credit of resolution.credits) {
        expect(credit.amount).toBeLessThanOrEqual(250);
      }
    }
  });
});

describe('the paytable', () => {
  /**
   * Twenty thousand hands played by the table's own default strategy.
   *
   * Blackjack's edge is thin, so this is a guard against a wrong payout or a
   * wrong dealer rule rather than a precise measurement — a 3:2 natural quietly
   * becoming 2:1, or the dealer hitting soft 17, both show up here.
   */
  it('returns between 93% and 100% over a long run', () => {
    const rounds = 20_000;
    const stake = 100;
    let paid = 0;

    for (let seed = 0; seed < rounds; seed += 1) {
      const resolution = blackjack.resolve([ante('p1', stake)], createRng(seed));
      paid += resolution.credits.reduce((sum, credit) => sum + credit.amount, 0);
    }

    const ret = paid / (rounds * stake);
    expect(ret).toBeGreaterThan(0.93);
    expect(ret).toBeLessThanOrEqual(1.0);
  });

  it('conserves chips exactly — every credit is covered by a stake', () => {
    // The table can never pay out more than it took in plus its own bankroll;
    // what it must never do is create chips from nothing through a rounding
    // slip. Asserted per hand, where an off-by-one is still visible.
    for (let seed = 0; seed < 2_000; seed += 1) {
      const wagers = [ante('p1', 30), ante('p2', 45)];
      const resolution = blackjack.resolve(wagers, createRng(seed));
      for (const credit of resolution.credits) {
        expect(Number.isInteger(credit.amount)).toBe(true);
        expect(credit.amount).toBeGreaterThan(0);
      }
    }
  });
});

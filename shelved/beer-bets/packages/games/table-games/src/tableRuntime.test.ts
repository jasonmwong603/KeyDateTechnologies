import { createRng, verifyCommitment } from '@keydate/netcode';
import { beforeEach, describe, expect, it } from 'vitest';
import { blackjack } from './blackjack.js';
import { highCardDuel } from './highCardDuel.js';
import { TableRuntime, type TableRuntimeHost } from './tableRuntime.js';
import { replayInteractiveRound } from './types.js';
import { wheelOfFortune } from './wheelOfFortune.js';

/**
 * A controllable stand-in for the server: a fake clock so betting windows can
 * be driven instantly, and a chip ledger so debits and credits can be asserted.
 */
class FakeHost implements TableRuntimeHost {
  time = 0;
  balances = new Map<string, number>();
  log: { playerId: string; delta: number; reason: string }[] = [];

  constructor(startingChips = 1000, players: string[] = ['a', 'b', 'c']) {
    for (const player of players) this.balances.set(player, startingChips);
  }

  debit(playerId: string, amount: number, reason: string): boolean {
    const balance = this.balances.get(playerId) ?? 0;
    if (balance < amount) return false;
    this.balances.set(playerId, balance - amount);
    this.log.push({ playerId, delta: -amount, reason });
    return true;
  }

  credit(playerId: string, amount: number, reason: string): void {
    this.balances.set(playerId, (this.balances.get(playerId) ?? 0) + amount);
    this.log.push({ playerId, delta: amount, reason });
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  get totalChips(): number {
    return [...this.balances.values()].reduce((sum, value) => sum + value, 0);
  }
}

let host: FakeHost;
let table: TableRuntime;
let seed: number;

beforeEach(() => {
  host = new FakeHost();
  seed = 1234;
  table = new TableRuntime(1, wheelOfFortune, host, () => seed);
});

/** Seats a player and runs one update so the table opens betting. */
function openBetting(): void {
  table.sit('a');
  table.update();
}

/**
 * Plays a table's hand out with the least committal legal move each turn, and
 * returns the log of what was played.
 *
 * Sending a bare `stand` every turn used to work and does not any more: a
 * dealer ace opens with an insurance question, where `stand` is not on offer
 * and the runtime rightly refuses it — which left these tests spinning on a
 * turn that never moved. Reading what is actually offered is both the fix and
 * the more honest test.
 */
function playOut(runtime: TableRuntime): string[] {
  const log: string[] = [];
  while (runtime.currentActor !== null) {
    const offered = runtime.toPublicState().decision!.actions.map((action) => action.id);
    const choice = ['stand', 'decline'].find((id) => offered.includes(id)) ?? offered[0];
    if (choice === undefined) throw new Error('The table offered nothing at all.');
    runtime.takeAction(runtime.currentActor, choice);
    log.push(choice);
    if (log.length > 128) throw new Error('The hand never ended.');
  }
  return log;
}

describe('TableRuntime seating', () => {
  it('starts idle and opens betting once enough players sit', () => {
    expect(table.currentPhase).toBe('idle');
    table.sit('a');
    table.update();
    expect(table.currentPhase).toBe('betting');
  });

  it('gives each player a distinct seat and is idempotent', () => {
    expect(table.sit('a')).toBe(0);
    expect(table.sit('b')).toBe(1);
    // Sitting again returns the seat already held rather than taking a second.
    expect(table.sit('a')).toBe(0);
    expect(table.seatedCount).toBe(2);
  });

  it('reuses a vacated seat index', () => {
    table.sit('a');
    table.sit('b');
    table.stand('a');
    expect(table.sit('c')).toBe(0);
  });

  it('refuses to seat more than the table allows', () => {
    for (let i = 0; i < wheelOfFortune.maxPlayers; i += 1) {
      expect(table.sit(`p${i}`)).not.toBeNull();
    }
    expect(table.sit('one-too-many')).toBeNull();
  });
});

describe('TableRuntime wagering', () => {
  it('rejects wagers while the table is idle', () => {
    const result = table.placeWager('a', 'x2', 100);
    expect(result).toMatchObject({ ok: false, code: 'table_locked' });
  });

  it('accepts a wager during the betting window and debits the player', () => {
    openBetting();
    const result = table.placeWager('a', 'x2', 100);
    expect(result.ok).toBe(true);
    expect(host.balances.get('a')).toBe(900);
  });

  it('rejects a wager from someone who is not seated', () => {
    openBetting();
    expect(table.placeWager('stranger', 'x2', 100)).toMatchObject({
      ok: false,
      code: 'invalid_action',
    });
  });

  it('rejects an unknown betting spot', () => {
    openBetting();
    expect(table.placeWager('a', 'not-a-spot', 100)).toMatchObject({
      ok: false,
      code: 'invalid_action',
    });
  });

  it('enforces the table minimum', () => {
    openBetting();
    expect(table.placeWager('a', 'x2', 1)).toMatchObject({ ok: false, code: 'invalid_action' });
  });

  it('rejects a wager the player cannot cover, and moves no chips', () => {
    openBetting();
    const before = host.balances.get('a');
    expect(table.placeWager('a', 'x2', 5000)).toMatchObject({
      ok: false,
      code: 'insufficient_chips',
    });
    expect(host.balances.get('a')).toBe(before);
  });

  it('caps total exposure per round, not each individual bet', () => {
    const richHost = new FakeHost(1_000_000, ['a']);
    const richTable = new TableRuntime(1, wheelOfFortune, richHost, () => seed);
    richTable.sit('a');
    richTable.update();

    // Splitting the stake must not get around the table limit.
    expect(richTable.placeWager('a', 'x2', 4_000).ok).toBe(true);
    expect(richTable.placeWager('a', 'x3', 2_000)).toMatchObject({
      ok: false,
      code: 'invalid_action',
    });
  });

  it('merges repeat stakes on the same spot', () => {
    openBetting();
    table.placeWager('a', 'x2', 100);
    table.placeWager('a', 'x2', 50);
    const state = table.toPublicState();
    expect(state.wagers).toHaveLength(1);
    expect(state.wagers[0]!.amount).toBe(150);
  });

  it('returns chips when a player clears their bets', () => {
    openBetting();
    table.placeWager('a', 'x2', 200);
    expect(table.clearWagers('a')).toBe(true);
    expect(host.balances.get('a')).toBe(1000);
    expect(table.toPublicState().wagers).toHaveLength(0);
  });

  it('refunds live wagers when a player stands up mid-round', () => {
    openBetting();
    table.placeWager('a', 'x2', 300);
    table.stand('a');
    expect(host.balances.get('a')).toBe(1000);
  });
});

describe('TableRuntime round lifecycle', () => {
  it('locks betting when the window expires, then resolves', () => {
    openBetting();
    table.placeWager('a', 'x2', 100);

    host.advance(wheelOfFortune.bettingWindowMs + 1);
    table.update();
    expect(table.currentPhase).toBe('resolving');

    host.advance(3_001);
    const resolution = table.update();
    expect(resolution).not.toBeNull();
    expect(table.currentPhase).toBe('payout');
  });

  it('resolves early once every seated player is ready', () => {
    table.sit('a');
    table.sit('b');
    table.update();

    table.placeWager('a', 'x2', 50);
    table.setReady('a', true);
    table.setReady('b', true);
    table.update();

    // No clock advance at all: readiness alone closed the window.
    expect(table.currentPhase).toBe('resolving');
  });

  it('returns to idle after the payout display', () => {
    openBetting();
    table.placeWager('a', 'x2', 100);
    host.advance(wheelOfFortune.bettingWindowMs + 1);
    table.update();
    host.advance(3_001);
    table.update();

    host.advance(6_001);
    table.update();
    expect(table.currentPhase).toBe('idle');
  });

  it('refunds and resets when everyone leaves mid-betting', () => {
    openBetting();
    table.placeWager('a', 'x2', 400);
    // stand() already refunds, so assert the table also resets cleanly.
    table.stand('a');
    table.update();

    expect(table.currentPhase).toBe('idle');
    expect(host.balances.get('a')).toBe(1000);
  });

  it('never drives a balance negative across many full rounds', () => {
    table.sit('a');
    table.sit('b');

    let spun = 0;
    for (let i = 0; i < 600 && spun < 25; i += 1) {
      table.update();
      if (table.currentPhase === 'betting') {
        table.placeWager('a', 'x2', 50);
        table.placeWager('b', 'x9', 20);
      }
      if (table.currentPhase === 'payout') spun += 1;
      host.advance(1_000);

      for (const balance of host.balances.values()) {
        expect(balance).toBeGreaterThanOrEqual(0);
      }
    }

    expect(spun).toBeGreaterThan(0);
  });

  it('moves chips only through named, auditable reasons', () => {
    openBetting();
    table.placeWager('a', 'x2', 100);
    table.clearWagers('a');
    table.placeWager('a', 'x9', 100);
    host.advance(wheelOfFortune.bettingWindowMs + 1);
    table.update();
    host.advance(3_001);
    table.update();

    const reasons = new Set(host.log.map((entry) => entry.reason));
    // An unrecognised reason means some code path is moving chips without
    // going through the wagering flow, which is what the audit log is for.
    for (const reason of reasons) {
      expect([
        'wager',
        'wager-cleared',
        'wager-refunded',
        'wager-won',
        'table-abandoned',
      ]).toContain(reason);
    }
  });

  it('conserves chips exactly at a table with no house edge', () => {
    // The duel pays out every chip staked, so unlike the wheel its table total
    // must come back to precisely where it started after each round.
    const duelHost = new FakeHost(1000, ['a', 'b', 'c']);
    const duel = new TableRuntime(2, highCardDuel, duelHost, () => 99);
    const before = duelHost.totalChips;

    duel.sit('a');
    duel.sit('b');
    duel.sit('c');

    let rounds = 0;
    for (let i = 0; i < 600 && rounds < 20; i += 1) {
      duel.update();
      if (duel.currentPhase === 'betting') {
        duel.placeWager('a', 'box-1', 33);
        duel.placeWager('b', 'box-1', 33);
        duel.placeWager('c', 'box-1', 34);
      }
      if (duel.currentPhase === 'payout') rounds += 1;
      duelHost.advance(1_000);
    }

    expect(rounds).toBeGreaterThan(0);
    expect(duelHost.totalChips).toBe(before);
  });
});

describe('TableRuntime fairness transcript', () => {
  it('publishes a commitment before bets open and withholds the seed', () => {
    openBetting();
    const state = table.toPublicState();

    expect(state.commitment).not.toBeNull();
    expect(state.commitment).not.toHaveProperty('seed');
    expect(state.lastResult).toBeNull();
  });

  it('reveals a seed that verifies against the published commitment', () => {
    openBetting();
    const published = table.toPublicState().commitment!;

    table.placeWager('a', 'x2', 100);
    host.advance(wheelOfFortune.bettingWindowMs + 1);
    table.update();
    host.advance(3_001);
    table.update();

    const reveal = table.toPublicState().lastResult!.reveal;
    expect(verifyCommitment(published.digest, reveal.seed, reveal.nonce)).toBe(true);
  });

  it('changes the commitment every round', () => {
    const digests = new Set<string>();
    table.sit('a');

    for (let round = 0; round < 3; round += 1) {
      seed = 1000 + round;
      table.update();
      const commitment = table.toPublicState().commitment;
      if (commitment !== null) digests.add(commitment.digest);
      host.advance(wheelOfFortune.bettingWindowMs + 1);
      table.update();
      host.advance(3_001);
      table.update();
      host.advance(6_001);
      table.update();
    }

    expect(digests.size).toBe(3);
  });
});

describe('a table with a decision phase', () => {
  let bjHost: FakeHost;
  let bjTable: TableRuntime;

  beforeEach(() => {
    bjHost = new FakeHost(1_000, ['a', 'b']);
    bjTable = new TableRuntime(2, blackjack, bjHost, () => 4242);
  });

  /**
   * Seats everyone, stakes a bet each, calls the deal and runs out the last call.
   *
   * Blackjack does not deal on a clock — it waits to be asked — so a test that
   * only advances time will sit in `betting` forever.
   */
  function dealIn(players: string[] = ['a'], stake = 100): void {
    for (const player of players) bjTable.sit(player);
    bjTable.update();
    for (const player of players) bjTable.placeWager(player, 'box-1', stake);
    bjTable.callDeal(players[0] as string);
    bjHost.advance(blackjack.bettingWindowMs + 1);
    bjTable.update();
  }

  it('enters the decision phase when betting closes rather than resolving', () => {
    dealIn();
    expect(bjTable.currentPhase).toBe('decisions');
    expect(bjTable.currentActor).toBe('a');
  });

  it('publishes the hand, the legal actions and a clock', () => {
    dealIn();
    const decision = bjTable.toPublicState().decision!;

    expect(decision.actor).toBe('a');
    expect(decision.actions.map((action) => action.id)).toContain('hit');
    expect(decision.msRemaining).toBeGreaterThan(0);
    expect(decision.view.dealerUpcard).toBeDefined();
  });

  it('never publishes the dealer hole card while the hand is live', () => {
    dealIn();
    const view = bjTable.toPublicState().decision!.view as { dealerCards: unknown };
    // The hole card is in the shoe the seed committed to, but publishing it
    // mid-hand would hand every player the one thing the game is built on not
    // knowing.
    expect(view.dealerCards).toBeNull();
  });

  it('refuses an action from a player whose turn it is not', () => {
    dealIn(['a', 'b']);
    const result = bjTable.takeAction('b', 'hit');
    expect(result).toEqual({
      ok: false,
      code: 'invalid_action',
      message: 'It is not your turn.',
    });
  });

  it('refuses an action the table did not offer', () => {
    dealIn();
    // A modified client can name any action it likes, including one from
    // another game entirely.
    expect(bjTable.takeAction('a', 'split')).toMatchObject({ code: 'invalid_action' });
    expect(bjTable.takeAction('a', '__proto__')).toMatchObject({ code: 'invalid_action' });
  });

  it('refuses an action from somebody who is not even at the table', () => {
    dealIn();
    expect(bjTable.takeAction('nobody', 'hit')).toMatchObject({ code: 'invalid_action' });
  });

  it('refuses any action outside the decision phase', () => {
    for (const player of ['a']) bjTable.sit(player);
    bjTable.update();
    expect(bjTable.takeAction('a', 'hit')).toMatchObject({ code: 'table_locked' });
  });

  it('debits the extra stake when a player doubles down', () => {
    dealIn(['a'], 100);
    const before = bjHost.balances.get('a')!;
    const actions = bjTable.toPublicState().decision!.actions.map((action) => action.id);

    if (actions.includes('double')) {
      expect(bjTable.takeAction('a', 'double')).toEqual({ ok: true });
      expect(bjHost.balances.get('a')).toBe(before - 100);
      // The felt must agree with the hand: what is shown as staked is what the
      // hand is actually playing for.
      const staked = bjTable
        .toPublicState()
        .wagers.filter((wager) => wager.playerId === 'a')
        .reduce((sum, wager) => sum + wager.amount, 0);
      expect(staked).toBe(200);
    }
  });

  it('refuses a double the player cannot cover, and does not apply it', () => {
    bjTable.sit('a');
    bjTable.update();
    // Stake everything, so there is nothing left to double with.
    bjTable.placeWager('a', 'box-1', 1_000);
    bjTable.callDeal('a');
    bjHost.advance(blackjack.bettingWindowMs + 1);
    bjTable.update();

    const before = bjHost.balances.get('a')!;
    const result = bjTable.takeAction('a', 'double');
    if (result.ok) throw new Error('Expected the double to be refused.');
    expect(result.code).toBe('insufficient_chips');
    expect(bjHost.balances.get('a')).toBe(before);
    // Crucially the hand is untouched: it is still this player's turn.
    expect(bjTable.currentActor).toBe('a');
  });

  /**
   * Deals until a hand comes up that offers `actionId`, leaving `bjTable`
   * parked on it. Returns false if no seed in range produced one.
   *
   * Splits need a pair and surrender needs an unspoilt first decision, neither
   * of which a fixed seed reliably produces. Hunting for one keeps these tests
   * about the runtime's handling of the action rather than about which shoe the
   * seed happened to shuffle.
   */
  function dealUntilOffered(actionId: string, stake = 100): boolean {
    for (let candidate = 1; candidate <= 400; candidate += 1) {
      bjHost = new FakeHost(10_000, ['a']);
      bjTable = new TableRuntime(2, blackjack, bjHost, () => candidate);
      dealIn(['a'], stake);
      if (bjTable.currentPhase !== 'decisions') continue;
      const offered = bjTable.toPublicState().decision!.actions.map((action) => action.id);
      if (offered.includes(actionId)) return true;
    }
    return false;
  }

  it('debits a second stake for a split and puts it on that box', () => {
    expect(dealUntilOffered('split')).toBe(true);

    const before = bjHost.balances.get('a')!;
    expect(bjTable.takeAction('a', 'split')).toEqual({ ok: true });
    expect(bjHost.balances.get('a')).toBe(before - 100);

    // Two hands on one box, and the box holding both of their stakes. A split
    // is not a fourth box — its chips belong on the pile it came from.
    const state = bjTable.toPublicState();
    expect(state.wagers).toHaveLength(1);
    expect(state.wagers[0]).toMatchObject({ spotId: 'box-1', amount: 200 });

    const hands = state.decision?.view.hands as { spotId: string }[] | undefined;
    if (hands !== undefined) {
      expect(hands).toHaveLength(2);
      expect(hands.every((hand) => hand.spotId === 'box-1')).toBe(true);
    }
  });

  it('refuses a split the player cannot cover, and does not apply it', () => {
    // Same guard as the double: the extra stake is taken before the action is
    // applied, so a hand can never be playing for chips that were never debited.
    let found = false;
    for (let candidate = 1; candidate <= 400 && !found; candidate += 1) {
      bjHost = new FakeHost(1_000, ['a']);
      bjTable = new TableRuntime(2, blackjack, bjHost, () => candidate);
      bjTable.sit('a');
      bjTable.update();
      // Everything on the felt, so there is nothing left to split with.
      bjTable.placeWager('a', 'box-1', 1_000);
      bjTable.callDeal('a');
      bjHost.advance(blackjack.bettingWindowMs + 1);
      bjTable.update();
      if (bjTable.currentPhase !== 'decisions') continue;
      found = bjTable.toPublicState().decision!.actions.some((action) => action.id === 'split');
    }
    expect(found).toBe(true);

    const result = bjTable.takeAction('a', 'split');
    if (result.ok) throw new Error('Expected the split to be refused.');
    expect(result.code).toBe('insufficient_chips');
    expect(bjHost.balances.get('a')).toBe(0);
    // The hand is untouched: still one hand, still this player's turn.
    expect(bjTable.currentActor).toBe('a');
    const hands = bjTable.toPublicState().decision?.view.hands as unknown[];
    expect(hands).toHaveLength(1);
  });

  it('costs nothing to surrender, and returns half at the payout', () => {
    expect(dealUntilOffered('surrender')).toBe(true);

    const staked = bjHost.balances.get('a')!;
    expect(bjTable.takeAction('a', 'surrender')).toEqual({ ok: true });
    // Declaring it is free — the stake was already taken when the bet went down.
    expect(bjHost.balances.get('a')).toBe(staked);

    for (let tick = 0; tick < 64 && bjTable.currentPhase !== 'payout'; tick += 1) {
      bjHost.advance(1_000);
      bjTable.update();
    }
    // Half of a 100 stake back, and nothing else: the hand folded.
    expect(bjHost.balances.get('a')).toBe(staked + 50);
  });

  it('keeps every hand backed by chips that were actually taken', () => {
    // The invariant every chip-spending action can quietly break: a hand that
    // appears without its stake being debited is free money, and a debit
    // without a bet to show for it is money taken for nothing.
    //
    // Played greedily — insure, split and double at every opportunity — across
    // many shoes, because that is what exercises all three paths. Insurance is
    // the newest and the odd one out: it is the only bet that lands on a spot
    // the player has nothing on yet, so it is the one that would go missing if
    // the runtime only ever topped up existing wagers.
    for (let candidate = 1; candidate <= 60; candidate += 1) {
      bjHost = new FakeHost(100_000, ['a']);
      bjTable = new TableRuntime(2, blackjack, bjHost, () => candidate);
      const opening = bjHost.balances.get('a')!;
      dealIn(['a'], 100);

      let guard = 0;
      while (bjTable.currentActor === 'a') {
        const offered = bjTable.toPublicState().decision!.actions.map((action) => action.id);
        const choice = ['insure', 'split', 'double', 'stand'].find((id) => offered.includes(id));
        if (choice === undefined) throw new Error(`Nothing playable on offer: ${offered}`);
        bjTable.takeAction('a', choice);
        guard += 1;
        if (guard > 128) throw new Error('The hand never ended.');
      }

      // Read before the payout: nothing has been credited back yet, so this is
      // exactly what the round cost.
      const spent = opening - bjHost.balances.get('a')!;

      // The felt agrees with the ledger — boxes and the insurance spot alike.
      const staked = bjTable.toPublicState().wagers.reduce((sum, wager) => sum + wager.amount, 0);
      expect(staked).toBe(spent);

      for (let tick = 0; tick < 64 && bjTable.currentPhase !== 'payout'; tick += 1) {
        bjHost.advance(1_000);
        bjTable.update();
      }
      expect(bjTable.currentPhase).toBe('payout');

      // And every hand that was settled agrees with it too — four hands off one
      // box must add up to the four stakes that were taken for them, plus
      // whatever went on insurance.
      const hands = bjTable.toPublicState().lastResult!.detail.hands as {
        stake: number;
        insurance: number;
      }[];
      const carried = hands.reduce((sum, hand) => sum + hand.stake + hand.insurance, 0);
      expect(carried).toBe(spent);
    }
  });

  it('decides for a player who runs out of time', () => {
    dealIn(['a', 'b']);
    expect(bjTable.currentActor).toBe('a');

    bjHost.advance(20_000);
    bjTable.update();

    expect(bjTable.currentActor).not.toBe('a');
  });

  it('gives each seat its own clock rather than one shared window', () => {
    dealIn(['a', 'b']);
    // Burn most of a's window, then let a act.
    bjHost.advance(14_000);
    bjTable.update();
    if (bjTable.currentActor === 'a') bjTable.takeAction('a', 'stand');

    if (bjTable.currentActor === 'b') {
      expect(bjTable.toPublicState().decision!.msRemaining).toBeGreaterThan(10_000);
    }
  });

  it('plays out the hand of somebody who walks away mid-deal, without refunding', () => {
    dealIn(['a', 'b']);
    const before = bjHost.balances.get('a')!;

    bjTable.stand('a');

    // Leaving after seeing your cards is not a way to un-bet: the stake stays
    // on the table and the hand is played out.
    expect(bjHost.balances.get('a')).toBe(before);
    expect(bjTable.currentActor).not.toBe('a');
  });

  it('reaches a payout even if every player walks out mid-hand', () => {
    dealIn(['a', 'b']);
    bjTable.stand('a');
    bjTable.stand('b');

    bjHost.advance(3_001);
    const resolution = bjTable.update();
    expect(resolution).not.toBeNull();
    expect(bjTable.currentPhase).toBe('payout');
  });

  it('skips the decision phase entirely when there is nothing to decide', () => {
    // Every seat was dealt a natural, so the round is over before anybody acts.
    // Reached by dealing normally and letting the shoe do it, rather than by
    // betting nothing — an on-demand table cannot be dealt with an empty felt.
    let seed = 0;
    for (; seed < 500; seed += 1) {
      bjHost = new FakeHost(1_000, ['a']);
      bjTable = new TableRuntime(2, blackjack, bjHost, () => seed);
      dealIn(['a']);
      if (bjTable.currentPhase === 'resolving') break;
    }
    expect(bjTable.currentPhase).toBe('resolving');
  });

  it('publishes the action log with the result, so the round can be replayed', () => {
    dealIn(['a']);
    const wagers = bjTable.toPublicState().wagers.map((wager) => ({ ...wager }));

    const played = playOut(bjTable);
    bjHost.advance(3_001);
    const resolution = bjTable.update()!;

    const result = bjTable.toPublicState().lastResult!;
    expect(result.actions).toEqual(played);

    // The whole point: seed plus log reproduces what the table just paid.
    const replayed = replayInteractiveRound(
      blackjack,
      wagers,
      createRng(result.reveal.seed),
      result.actions,
    );
    expect(replayed).toEqual(resolution);
  });

  it('reveals a seed that verifies against the commitment, same as any table', () => {
    dealIn(['a']);
    const published = bjTable.toPublicState().commitment!;

    playOut(bjTable);
    bjHost.advance(3_001);
    bjTable.update();

    const reveal = bjTable.toPublicState().lastResult!.reveal;
    expect(verifyCommitment(published.digest, reveal.seed, reveal.nonce)).toBe(true);
  });

  it('clears the decision state between rounds', () => {
    dealIn(['a']);
    playOut(bjTable);
    bjHost.advance(3_001);
    bjTable.update();
    expect(bjTable.toPublicState().decision).toBeNull();

    // One update to close the payout display, one more to open the next round.
    bjHost.advance(6_001);
    bjTable.update();
    bjTable.update();
    expect(bjTable.toPublicState().lastResult).toBeNull();
    expect(bjTable.currentPhase).toBe('betting');
  });

  it('runs a one-shot table through no decision phase at all', () => {
    // The wheel must be entirely unaffected by any of this.
    openBetting();
    table.placeWager('a', 'x2', 100);
    host.advance(wheelOfFortune.bettingWindowMs + 1);
    table.update();
    expect(table.currentPhase).toBe('resolving');
    expect(table.currentActor).toBeNull();
    expect(table.toPublicState().decision).toBeNull();
  });
});

describe('the public table state', () => {
  it('carries everything the client needs to draw the felt', () => {
    openBetting();
    const state = table.toPublicState();

    // Adding a game must not mean editing a lookup table in the HUD, so the
    // name, the spots and the window all travel with the state.
    expect(state.displayName).toBe('Wheel of Fortune');
    expect(state.spots.map((spot) => spot.id)).toEqual(['x2', 'x3', 'x9', 'x50']);
    expect(state.bettingWindowMs).toBe(wheelOfFortune.bettingWindowMs);
    expect(state.minWager).toBe(wheelOfFortune.minWager);
    expect(state.maxWager).toBe(wheelOfFortune.maxWager);
  });

  it('hands out copies, so nothing a client is sent can mutate the definition', () => {
    openBetting();
    const state = table.toPublicState();
    state.spots[0]!.payout = 9_999;
    expect(wheelOfFortune.spots[0]!.payout).toBe(1);
  });
});

describe('a table that waits to be asked', () => {
  let bjHost: FakeHost;
  let bjTable: TableRuntime;

  beforeEach(() => {
    bjHost = new FakeHost(1_000, ['a', 'b']);
    bjTable = new TableRuntime(3, blackjack, bjHost, () => 4242);
    bjTable.sit('a');
    bjTable.update();
  });

  it('declares itself on-demand so the client knows not to draw a clock', () => {
    const state = bjTable.toPublicState();
    expect(state.dealOnDemand).toBe(true);
    expect(state.dealCalled).toBe(false);
    expect(bjTable.dealsOnDemand).toBe(true);
  });

  it('runs no betting clock at all until the deal is called', () => {
    bjTable.placeWager('a', 'box-1', 100);
    // Ten minutes. A timer table would have dealt, resolved and paid out twenty
    // times over; this one is still waiting, which is the entire point.
    for (let i = 0; i < 60; i += 1) {
      bjHost.advance(10_000);
      bjTable.update();
    }
    expect(bjTable.currentPhase).toBe('betting');
    expect(bjTable.toPublicState().bettingMsRemaining).toBe(0);
  });

  it('reports no countdown before the deal is called, and one after', () => {
    bjTable.placeWager('a', 'box-1', 100);
    expect(bjTable.toPublicState().bettingMsRemaining).toBe(0);

    bjTable.callDeal('a');
    const remaining = bjTable.toPublicState().bettingMsRemaining;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(blackjack.bettingWindowMs);
  });

  it('never leaks an infinite deadline to a client', () => {
    // Infinity does not survive JSON, and a countdown bar cannot be a fraction
    // of it. It must be reported as "no clock", not as a number.
    expect(Number.isFinite(bjTable.toPublicState().bettingMsRemaining)).toBe(true);
  });

  it('deals once the last call runs out', () => {
    bjTable.placeWager('a', 'box-1', 100);
    bjTable.callDeal('a');
    expect(bjTable.currentPhase).toBe('betting');
    expect(bjTable.toPublicState().dealCalled).toBe(true);

    // Still betting one millisecond before the last call is up.
    bjHost.advance(blackjack.bettingWindowMs - 1);
    bjTable.update();
    expect(bjTable.currentPhase).toBe('betting');

    bjHost.advance(2);
    bjTable.update();
    expect(bjTable.currentPhase).not.toBe('betting');
  });

  it('keeps taking bets during the last call', () => {
    // That is what the ten seconds are for: everyone else gets their chips down.
    bjTable.sit('b');
    bjTable.placeWager('a', 'box-1', 100);
    bjTable.callDeal('a');

    bjHost.advance(5_000);
    bjTable.update();
    expect(bjTable.placeWager('b', 'box-1', 50).ok).toBe(true);
  });

  it('refuses the call from a player with nothing on the felt', () => {
    // Otherwise somebody with no stake could stand at a table of six and cut
    // everyone's betting short, over and over, for free.
    expect(bjTable.callDeal('a')).toMatchObject({
      ok: false,
      code: 'invalid_action',
      message: 'Place a bet before calling the deal.',
    });
    expect(bjTable.toPublicState().dealCalled).toBe(false);
  });

  it('refuses the call from somebody who is not seated', () => {
    bjTable.placeWager('a', 'box-1', 100);
    expect(bjTable.callDeal('stranger')).toMatchObject({ ok: false, code: 'invalid_action' });
  });

  it('refuses the call once the cards are already out', () => {
    bjTable.placeWager('a', 'box-1', 100);
    bjTable.callDeal('a');
    bjHost.advance(blackjack.bettingWindowMs + 1);
    bjTable.update();

    expect(bjTable.callDeal('a')).toMatchObject({ ok: false, code: 'table_locked' });
  });

  it('is idempotent, and a second call cannot extend the window', () => {
    bjTable.placeWager('a', 'box-1', 100);
    bjTable.callDeal('a');

    bjHost.advance(9_000);
    // A double-tap, or a retry after a dropped acknowledgement, must not buy
    // another ten seconds.
    expect(bjTable.callDeal('a')).toEqual({ ok: true });

    bjHost.advance(1_001);
    bjTable.update();
    expect(bjTable.currentPhase).not.toBe('betting');
  });

  it('lets a second player call the deal on behalf of the table', () => {
    bjTable.sit('b');
    bjTable.placeWager('b', 'box-1', 100);
    expect(bjTable.callDeal('b')).toEqual({ ok: true });
  });

  it('withdraws the call rather than dealing into an empty felt', () => {
    bjTable.placeWager('a', 'box-1', 100);
    bjTable.callDeal('a');
    // Changed their mind during the last call and pulled the only chips back.
    bjTable.clearWagers('a');

    bjHost.advance(blackjack.bettingWindowMs + 1);
    bjTable.update();

    // Betting reopens rather than burning a round, and the call is cleared so
    // the table is not stuck waiting on a deadline that has already passed.
    expect(bjTable.currentPhase).toBe('betting');
    expect(bjTable.toPublicState().dealCalled).toBe(false);
  });

  it('can be called again after a withdrawn deal', () => {
    bjTable.placeWager('a', 'box-1', 100);
    bjTable.callDeal('a');
    bjTable.clearWagers('a');
    bjHost.advance(blackjack.bettingWindowMs + 1);
    bjTable.update();

    bjTable.placeWager('a', 'box-1', 100);
    expect(bjTable.callDeal('a')).toEqual({ ok: true });
    bjHost.advance(blackjack.bettingWindowMs + 1);
    bjTable.update();
    expect(bjTable.currentPhase).not.toBe('betting');
  });

  it('clears the call when the next round opens', () => {
    bjTable.placeWager('a', 'box-1', 100);
    bjTable.callDeal('a');
    bjHost.advance(blackjack.bettingWindowMs + 1);
    bjTable.update();

    playOut(bjTable);
    bjHost.advance(3_001);
    bjTable.update();
    bjHost.advance(6_001);
    bjTable.update();
    bjTable.update();

    expect(bjTable.currentPhase).toBe('betting');
    expect(bjTable.toPublicState().dealCalled).toBe(false);
    expect(bjTable.toPublicState().bettingMsRemaining).toBe(0);
  });

  it('takes a bet of the whole balance, because there is no table limit', () => {
    // "Ten to whatever you hold" is the rule, so the ledger is the only ceiling.
    expect(bjTable.placeWager('a', 'box-1', 1_000).ok).toBe(true);
    expect(bjHost.balances.get('a')).toBe(0);
  });

  it('still refuses a bet one chip beyond the balance', () => {
    expect(bjTable.placeWager('a', 'box-1', 1_001)).toMatchObject({
      ok: false,
      code: 'insufficient_chips',
    });
  });

  it('still enforces the table minimum', () => {
    expect(bjTable.placeWager('a', 'box-1', 9)).toMatchObject({
      ok: false,
      code: 'invalid_action',
      message: 'Minimum wager is 10.',
    });
  });

  it('adds a double to the box it belongs to, not to the first one', () => {
    // The bug this guards is silent: the chips come out of the balance either
    // way, and the felt just quietly shows them against the wrong hand.
    bjTable.placeWager('a', 'box-1', 100);
    bjTable.placeWager('a', 'box-2', 100);
    bjTable.callDeal('a');
    bjHost.advance(blackjack.bettingWindowMs + 1);
    bjTable.update();

    // Walk to whichever box can double, then double it. Only ever sending a
    // move the table is currently offering: a dealer ace opens with the
    // insurance question, where a bare `stand` is refused and the turn would
    // never move on.
    let doubled: string | null = null;
    let guard = 0;
    while (bjTable.currentActor === 'a' && doubled === null) {
      const decision = bjTable.toPublicState().decision!;
      const offered = decision.actions.map((action) => action.id);
      const hands = decision.view.hands as { spotId: string; finished: boolean }[];
      const active = hands.find((hand) => !hand.finished);
      if (offered.includes('double')) {
        bjTable.takeAction('a', 'double');
        doubled = active?.spotId ?? null;
      } else {
        const choice = ['stand', 'decline'].find((id) => offered.includes(id));
        if (choice === undefined) break;
        bjTable.takeAction('a', choice);
      }
      guard += 1;
      if (guard > 128) throw new Error('The hand never ended.');
    }

    if (doubled !== null) {
      const wagers = bjTable.toPublicState().wagers;
      expect(wagers.find((wager) => wager.spotId === doubled)?.amount).toBe(200);
      for (const wager of wagers) {
        if (wager.spotId !== doubled) expect(wager.amount).toBe(100);
      }
    }
  });

  it('takes one deal call to cover every box a player is holding', () => {
    bjTable.placeWager('a', 'box-1', 50);
    bjTable.placeWager('a', 'box-2', 50);
    bjTable.placeWager('a', 'box-3', 50);
    expect(bjTable.callDeal('a')).toEqual({ ok: true });

    bjHost.advance(blackjack.bettingWindowMs + 1);
    bjTable.update();

    const hands = bjTable.toPublicState().decision?.view.hands as unknown[] | undefined;
    // Either three hands to play, or the round was settled outright by a
    // natural — never one hand for three bets.
    expect(hands === undefined || hands.length === 3).toBe(true);
  });

  it('refuses the deal call at a table that runs on a clock', () => {
    openBetting();
    table.placeWager('a', 'x2', 50);
    expect(table.callDeal('a')).toMatchObject({
      ok: false,
      code: 'invalid_action',
      message: 'This table deals on its own clock.',
    });
  });

  it('leaves the wheel dealing on its clock exactly as before', () => {
    openBetting();
    const state = table.toPublicState();
    expect(state.dealOnDemand).toBe(false);
    expect(state.bettingMsRemaining).toBeGreaterThan(0);
  });
});

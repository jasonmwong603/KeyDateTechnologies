import { verifyCommitment } from '@keydate/netcode';
import { beforeEach, describe, expect, it } from 'vitest';
import { highCardDuel } from './highCardDuel.js';
import { TableRuntime, type TableRuntimeHost } from './tableRuntime.js';
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
        duel.placeWager('a', 'ante', 33);
        duel.placeWager('b', 'ante', 33);
        duel.placeWager('c', 'ante', 34);
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

import { describe, expect, it } from 'vitest';
import { ChipLedger } from './ledger.js';

describe('ChipLedger', () => {
  it('opens an account at the starting stack on first use', () => {
    const ledger = new ChipLedger(2500);
    expect(ledger.has('new-player')).toBe(false);
    expect(ledger.balanceOf('new-player')).toBe(2500);
    expect(ledger.has('new-player')).toBe(true);
  });

  it('debits and credits', () => {
    const ledger = new ChipLedger(1000);
    expect(ledger.debit('a', 300, 'wager')).toBe(true);
    expect(ledger.balanceOf('a')).toBe(700);
    ledger.credit('a', 900, 'wager-won');
    expect(ledger.balanceOf('a')).toBe(1600);
  });

  it('refuses a debit larger than the balance and moves nothing', () => {
    const ledger = new ChipLedger(100);
    expect(ledger.debit('a', 101, 'wager')).toBe(false);
    // A partial debit would leave a wager half-placed, which has no meaning.
    expect(ledger.balanceOf('a')).toBe(100);
  });

  it('allows a debit of the entire balance', () => {
    const ledger = new ChipLedger(100);
    expect(ledger.debit('a', 100, 'all-in')).toBe(true);
    expect(ledger.balanceOf('a')).toBe(0);
  });

  it('ignores non-positive and fractional amounts', () => {
    const ledger = new ChipLedger(100);
    expect(ledger.debit('a', 0, 'x')).toBe(false);
    // A negative debit would otherwise credit the player.
    expect(ledger.debit('a', -50, 'x')).toBe(false);
    expect(ledger.debit('a', 10.5, 'x')).toBe(false);
    ledger.credit('a', -50, 'x');
    ledger.credit('a', 0.5, 'x');
    expect(ledger.balanceOf('a')).toBe(100);
  });

  it('never lets a balance go negative under repeated debits', () => {
    const ledger = new ChipLedger(100);
    for (let i = 0; i < 50; i += 1) ledger.debit('a', 30, 'wager');
    expect(ledger.balanceOf('a')).toBeGreaterThanOrEqual(0);
    expect(ledger.balanceOf('a')).toBe(10);
  });

  it('bails out only a player who is genuinely broke', () => {
    const ledger = new ChipLedger(100);
    expect(ledger.bailout('a', 500)).toBe(0);

    ledger.debit('a', 100, 'wager');
    expect(ledger.bailout('a', 500)).toBe(500);
    expect(ledger.balanceOf('a')).toBe(500);
  });

  it('cannot be farmed by busting down to a single chip', () => {
    const ledger = new ChipLedger(100);
    ledger.debit('a', 99, 'wager');
    // One chip left is not broke, so no grant.
    expect(ledger.bailout('a', 500)).toBe(0);
    expect(ledger.balanceOf('a')).toBe(1);
  });

  it('records an auditable history of every movement', () => {
    const ledger = new ChipLedger(1000);
    ledger.debit('a', 100, 'wager');
    ledger.credit('a', 300, 'wager-won');

    const history = ledger.recentHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ playerId: 'a', delta: -100, balance: 900, reason: 'wager' });
    expect(history[1]).toMatchObject({ playerId: 'a', delta: 300, balance: 1200 });
  });

  it('bounds the history so a long session cannot grow without limit', () => {
    const ledger = new ChipLedger(1_000_000, 10);
    for (let i = 0; i < 100; i += 1) ledger.debit('a', 1, 'wager');
    expect(ledger.recentHistory(1000)).toHaveLength(10);
  });

  it('forgets a departed player', () => {
    const ledger = new ChipLedger(500);
    ledger.debit('a', 200, 'wager');
    ledger.forget('a');
    // A brand-new account, not the 300 they left with.
    expect(ledger.balanceOf('a')).toBe(500);
  });
});

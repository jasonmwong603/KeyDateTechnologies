/**
 * The authoritative chip ledger.
 *
 * Every chip movement in the world goes through here, and nothing else is
 * allowed to write a balance. Keeping it in one small class means the invariant
 * that matters — balances never go negative, and chips are never created except
 * by an explicit, named grant — is enforced in one place instead of being
 * re-checked at every call site.
 */

export interface LedgerEntry {
  playerId: string;
  delta: number;
  balance: number;
  reason: string;
  at: number;
}

export class ChipLedger {
  private balances = new Map<string, number>();
  private history: LedgerEntry[] = [];

  constructor(
    private readonly startingChips: number,
    /** Retained entries. Bounded so a long-running world cannot grow unboundedly. */
    private readonly historyLimit = 500,
  ) {}

  /** Balance for a player, opening an account at the starting stack if new. */
  balanceOf(playerId: string): number {
    const existing = this.balances.get(playerId);
    if (existing !== undefined) return existing;
    this.balances.set(playerId, this.startingChips);
    return this.startingChips;
  }

  has(playerId: string): boolean {
    return this.balances.has(playerId);
  }

  /**
   * Takes chips from a player.
   *
   * Returns false and moves nothing when they cannot cover it — partial debits
   * are never performed, because a half-placed wager has no meaning.
   */
  debit(playerId: string, amount: number, reason: string): boolean {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    const balance = this.balanceOf(playerId);
    if (balance < amount) return false;

    const next = balance - amount;
    this.balances.set(playerId, next);
    this.record(playerId, -amount, next, reason);
    return true;
  }

  /** Gives chips to a player. */
  credit(playerId: string, amount: number, reason: string): void {
    if (!Number.isInteger(amount) || amount <= 0) return;
    const next = this.balanceOf(playerId) + amount;
    this.balances.set(playerId, next);
    this.record(playerId, amount, next, reason);
  }

  /**
   * Tops a broke player back up to the bailout stack.
   *
   * Returns the chips granted, or 0 if they did not need it. Only fires when a
   * player is genuinely at zero, so it cannot be farmed by betting down to one
   * chip repeatedly.
   */
  bailout(playerId: string, bailoutChips: number): number {
    if (this.balanceOf(playerId) > 0) return 0;
    this.credit(playerId, bailoutChips, 'bailout');
    return bailoutChips;
  }

  /** Forgets a player's account. Called once their resume window has lapsed. */
  forget(playerId: string): void {
    this.balances.delete(playerId);
  }

  /** Most recent entries, newest last. Used by the audit endpoint. */
  recentHistory(limit = 50): readonly LedgerEntry[] {
    return this.history.slice(-limit);
  }

  private record(playerId: string, delta: number, balance: number, reason: string): void {
    this.history.push({ playerId, delta, balance, reason, at: Date.now() });
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }
}

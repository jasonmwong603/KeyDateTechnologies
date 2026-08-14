import { hashString } from './rng.js';

/**
 * Commit–reveal fairness for wager outcomes.
 *
 * In a game where friends bet against the house, "the server decided you lost"
 * is not good enough — a player who suspects the server picked the outcome
 * *after* seeing the bets has no way to check. So each round runs as:
 *
 *   1. Before betting opens, the server picks a secret seed and publishes
 *      `commit(seed)` — a digest that reveals nothing about the seed itself.
 *   2. Players bet. The server cannot change the seed now without breaking the
 *      digest it already published.
 *   3. After the round resolves, the server reveals the seed. Anyone can hash
 *      it, check it against the commitment, and replay the outcome.
 *
 * The digest here is a non-cryptographic hash chain — enough to make the flow
 * real and testable, but see the note on `commit` before trusting it against a
 * motivated attacker.
 */

export interface RoundCommitment {
  /** Published before bets open. */
  digest: string;
  /** Withheld until the round resolves. */
  seed: number;
  /** Incrementing round number, folded in so identical seeds differ per round. */
  nonce: number;
}

/**
 * Produces the public digest for a seed.
 *
 * NOTE: this is FNV-1a iterated, not a cryptographic hash. It gives a real
 * commit–reveal *protocol* with a verifiable transcript, but a determined
 * attacker with server access could search for a colliding seed. Before this
 * game handles anything a player would be upset to lose, swap the body for
 * SHA-256 (`node:crypto` on the server, WebCrypto in the browser) — the
 * signature and the surrounding flow do not change.
 */
export function commit(seed: number, nonce: number): string {
  let value = `keydate:${seed >>> 0}:${nonce}`;
  // Iterating slows down brute-force search over the small seed space.
  for (let i = 0; i < 64; i += 1) {
    value = `${hashString(value).toString(16)}:${i}`;
  }
  return hashString(value).toString(16).padStart(8, '0');
}

/** Creates a commitment for a round. The seed must stay secret until reveal. */
export function createCommitment(seed: number, nonce: number): RoundCommitment {
  return { digest: commit(seed, nonce), seed, nonce };
}

/** Client-side check that a revealed seed matches the published digest. */
export function verifyCommitment(digest: string, seed: number, nonce: number): boolean {
  return commit(seed, nonce) === digest;
}

/** What the server publishes before betting opens. */
export function publicPart(commitment: RoundCommitment): { digest: string; nonce: number } {
  return { digest: commitment.digest, nonce: commitment.nonce };
}

/** What the server publishes after the round resolves. */
export function revealPart(commitment: RoundCommitment): { seed: number; nonce: number } {
  return { seed: commitment.seed, nonce: commitment.nonce };
}

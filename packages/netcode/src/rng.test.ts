import { describe, expect, it } from 'vitest';
import { createCommitment, verifyCommitment } from './commitment.js';
import { createRng, hashString } from './rng.js';

describe('createRng', () => {
  it('produces the same stream from the same seed', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const drawA = Array.from({ length: 50 }, () => a.next());
    const drawB = Array.from({ length: 50 }, () => b.next());
    expect(drawA).toEqual(drawB);
  });

  it('produces different streams from different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('stays within [0, 1)', () => {
    const rng = createRng(99);
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('covers the full inclusive range of int()', () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i += 1) seen.add(rng.int(1, 6));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('distributes int() roughly evenly', () => {
    const rng = createRng(2024);
    const counts = new Array(6).fill(0);
    const draws = 60_000;
    for (let i = 0; i < draws; i += 1) counts[rng.int(0, 5)] += 1;

    // A fair die over 60k rolls should not stray far from 10k per face.
    for (const count of counts) {
      expect(count).toBeGreaterThan(draws / 6 - 600);
      expect(count).toBeLessThan(draws / 6 + 600);
    }
  });

  it('rejects an inverted int() range rather than silently misbehaving', () => {
    expect(() => createRng(1).int(5, 2)).toThrow(RangeError);
  });

  it('rejects picking from an empty array', () => {
    expect(() => createRng(1).pick([])).toThrow(RangeError);
  });
});

describe('hashString', () => {
  it('is stable', () => {
    expect(hashString('keydate')).toBe(hashString('keydate'));
  });

  it('separates similar inputs', () => {
    expect(hashString('seed:1')).not.toBe(hashString('seed:2'));
  });
});

describe('commit-reveal', () => {
  it('verifies a seed against its own commitment', () => {
    const commitment = createCommitment(4242, 7);
    expect(verifyCommitment(commitment.digest, 4242, 7)).toBe(true);
  });

  it('rejects a different seed', () => {
    const commitment = createCommitment(4242, 7);
    // This is the attack the scheme exists to catch: the server publishing a
    // digest, then resolving the round with a more convenient seed.
    expect(verifyCommitment(commitment.digest, 4243, 7)).toBe(false);
  });

  it('rejects the right seed replayed under a different round', () => {
    const commitment = createCommitment(4242, 7);
    expect(verifyCommitment(commitment.digest, 4242, 8)).toBe(false);
  });

  it('gives different digests to the same seed in different rounds', () => {
    expect(createCommitment(1, 1).digest).not.toBe(createCommitment(1, 2).digest);
  });
});

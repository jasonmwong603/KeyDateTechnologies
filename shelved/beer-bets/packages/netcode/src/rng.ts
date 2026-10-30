/**
 * Seeded, reproducible randomness.
 *
 * `Math.random()` is banned anywhere a wager outcome is decided: outcomes must
 * be reproducible from a seed so a disputed spin can be replayed and verified
 * after the fact. See `commitment.ts` for how that seed is published.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
}

/**
 * mulberry32 — small, fast, and good enough for game outcomes. Its entire
 * state is one 32-bit integer, which makes a round trivially reproducible:
 * store the seed and you can replay the spin exactly.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(min: number, max: number): number {
      if (max < min) throw new RangeError('rng.int: max must be >= min');
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('rng.pick: empty array');
      const item = items[Math.floor(next() * items.length)];
      // Index is always in range, but noUncheckedIndexedAccess cannot see that.
      return item as T;
    },
  };
}

/** FNV-1a. Used to derive per-round seeds from a string without a crypto dep. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The bar: what it sells, and what drinking does to you.
 *
 * This is the other half of the game's loop. Chips are won at the tables and
 * spent at the bar; drinking is the only thing chips buy, and being drunk makes
 * winning them back harder. There is no way to add chips from outside, so the
 * economy is closed and every beer is paid for by a hand somebody played.
 *
 * Intoxication deliberately does *not* live in `packages/sim`. That package is
 * the deterministic movement simulation, run in lockstep by the server and by
 * every client's prediction; putting a value there that only affects how the
 * screen looks would mean replaying it during reconciliation for no reason.
 * Drunkenness is server-owned state, replicated like chips.
 */

/** Fully drunk. The scale is 0..1 so the client can use it directly. */
export const MAX_INTOXICATION = 1;

/**
 * How much intoxication wears off per second.
 *
 * Tuned so a player who drinks themselves blind sobers up in about two minutes
 * of not drinking. Long enough that a bad decision costs you a few rounds,
 * short enough that it never feels like the game has taken the controls away.
 */
export const SOBER_PER_SECOND = 1 / 120;

export interface Drink {
  id: string;
  name: string;
  /** Chips. Paid out of the same balance used to wager. */
  price: number;
  /**
   * Change in intoxication, 0..1. Negative sobers you up.
   *
   * Price per point of intoxication is deliberately uneven: the cheap round is
   * the efficient one, so getting *very* drunk costs disproportionately more
   * than getting slightly drunk.
   */
  effect: number;
  description: string;
}

export const MENU: Drink[] = [
  {
    id: 'lager',
    name: 'Lager',
    price: 40,
    effect: 0.18,
    description: 'A pint of something forgettable.',
  },
  {
    id: 'stout',
    name: 'Stout',
    price: 75,
    effect: 0.3,
    description: 'Heavier, and it shows.',
  },
  {
    id: 'whiskey',
    name: 'House Whiskey',
    price: 130,
    effect: 0.46,
    description: 'The short road to a blurry evening.',
  },
  {
    id: 'water',
    name: 'Soda Water',
    price: 25,
    effect: -0.35,
    description: 'Buys back some of your eyesight.',
  },
];

export function findDrink(id: string): Drink | undefined {
  return MENU.find((drink) => drink.id === id);
}

/** Clamps a value into the legal intoxication range. */
export function clampIntoxication(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_INTOXICATION, value));
}

/**
 * Applies a drink.
 *
 * Returns the new level. Drinking past the maximum is allowed and simply caps —
 * refusing the sale because a player is already at the ceiling would be a
 * confusing way to spend their money for them.
 */
export function drink(current: number, beverage: Drink): number {
  return clampIntoxication(current + beverage.effect);
}

/** Sobers a player up for `seconds` of elapsed time. */
export function soberUp(current: number, seconds: number): number {
  if (seconds <= 0) return clampIntoxication(current);
  return clampIntoxication(current - SOBER_PER_SECOND * seconds);
}

/**
 * The menu as sent to a client.
 *
 * Prices and effects are public: the whole decision the player is making is
 * "how much eyesight is this worth", and hiding either half of that turns a
 * choice into a guess.
 */
export function publicMenu(): Drink[] {
  return MENU.map((drink) => ({ ...drink }));
}

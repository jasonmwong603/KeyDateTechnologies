import { describe, expect, it } from 'vitest';
import {
  clampIntoxication,
  drink,
  findDrink,
  MAX_INTOXICATION,
  MENU,
  publicMenu,
  soberUp,
  SOBER_PER_SECOND,
} from './bar.js';

describe('the menu', () => {
  it('has unique drink ids', () => {
    expect(new Set(MENU.map((item) => item.id)).size).toBe(MENU.length);
  });

  it('prices everything above zero', () => {
    // A free drink would break the loop: chips could only ever go up.
    for (const item of MENU) expect(item.price).toBeGreaterThan(0);
  });

  it('offers at least one way to sober up', () => {
    expect(MENU.some((item) => item.effect < 0)).toBe(true);
  });

  it('makes getting very drunk cost more per point than getting slightly drunk', () => {
    const alcohol = MENU.filter((item) => item.effect > 0).sort((a, b) => a.effect - b.effect);
    const cheapest = alcohol[0]!;
    const strongest = alcohol[alcohol.length - 1]!;
    expect(strongest.price / strongest.effect).toBeGreaterThan(cheapest.price / cheapest.effect);
  });

  it('hands out copies, so a client payload cannot mutate the menu', () => {
    const menu = publicMenu();
    menu[0]!.price = 0;
    expect(MENU[0]!.price).toBeGreaterThan(0);
  });

  it('resolves known ids and rejects unknown ones', () => {
    expect(findDrink('lager')?.name).toBe('Lager');
    expect(findDrink('nope')).toBeUndefined();
  });
});

describe('clampIntoxication', () => {
  it('keeps values inside 0..1', () => {
    expect(clampIntoxication(-5)).toBe(0);
    expect(clampIntoxication(5)).toBe(MAX_INTOXICATION);
    expect(clampIntoxication(0.4)).toBe(0.4);
  });

  it('treats any non-finite value as sober rather than propagating it', () => {
    // This value is computed server-side and never supplied by a client, so a
    // non-finite one means a bug upstream. Falling back to sober fails safe:
    // the alternative is a NaN that poisons the replicated field and blurs
    // somebody's screen permanently, with nothing in the logs to explain it.
    expect(clampIntoxication(Number.NaN)).toBe(0);
    expect(clampIntoxication(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampIntoxication(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('drink', () => {
  it('raises intoxication by the drink strength', () => {
    const lager = findDrink('lager')!;
    expect(drink(0, lager)).toBeCloseTo(lager.effect, 6);
  });

  it('caps at fully drunk rather than refusing the sale', () => {
    const whiskey = findDrink('whiskey')!;
    let level = 0;
    for (let i = 0; i < 10; i += 1) level = drink(level, whiskey);
    expect(level).toBe(MAX_INTOXICATION);
  });

  it('sobers you up on a negative effect, without going below zero', () => {
    const water = findDrink('water')!;
    expect(drink(0.5, water)).toBeCloseTo(0.5 + water.effect, 6);
    expect(drink(0.05, water)).toBe(0);
  });
});

describe('soberUp', () => {
  it('wears off at the declared rate', () => {
    expect(soberUp(1, 10)).toBeCloseTo(1 - SOBER_PER_SECOND * 10, 6);
  });

  it('never goes below sober', () => {
    expect(soberUp(0.1, 10_000)).toBe(0);
  });

  it('ignores zero and negative elapsed time', () => {
    // A clock that jumps backwards must not make anyone drunker.
    expect(soberUp(0.5, 0)).toBe(0.5);
    expect(soberUp(0.5, -10)).toBe(0.5);
  });

  it('takes roughly two minutes to sober up from fully drunk', () => {
    // The design target. If this drifts, the risk/reward of a big round has
    // quietly changed and the balance needs revisiting.
    let level = MAX_INTOXICATION;
    let seconds = 0;
    while (level > 0 && seconds < 600) {
      level = soberUp(level, 1);
      seconds += 1;
    }
    expect(seconds).toBeGreaterThan(90);
    expect(seconds).toBeLessThan(150);
  });
});

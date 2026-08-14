# Adding a table game

A table game is a rules module: a pure function from (wagers, seeded RNG) to an outcome
and a payout list. It never touches sockets, clocks or chip balances — `TableRuntime`
owns all of those.

That purity is not stylistic. It is what makes a round replayable from its published
seed, which is the entire basis of the fairness guarantee.

## 1. Write the module

Create `packages/games/table-games/src/yourGame.ts`:

```ts
import type { Rng } from '@keydate/netcode';
import type { TableGameDefinition, TableResolution, Wager } from './types.js';

export const coinToss: TableGameDefinition = {
  id: 'coin-toss',
  displayName: 'Coin Toss',
  minPlayers: 1,
  maxPlayers: 6,
  minWager: 5,
  maxWager: 1_000,
  bettingWindowMs: 15_000,

  spots: [
    { id: 'heads', label: 'Heads', payout: 1, description: 'Pays even money.' },
    { id: 'tails', label: 'Tails', payout: 1, description: 'Pays even money.' },
  ],

  resolve(wagers: readonly Wager[], rng: Rng): TableResolution {
    const outcome = rng.next() < 0.5 ? 'heads' : 'tails';

    return {
      summary: `The coin came up ${outcome}.`,
      detail: { outcome },
      credits: wagers
        .filter((wager) => wager.spotId === outcome)
        // `payout` is odds-to-one, so a winning stake returns amount * (payout + 1).
        .map((wager) => ({ playerId: wager.playerId, amount: wager.amount * 2 })),
    };
  },
};
```

### Rules

- **Use only the supplied `rng`.** No `Math.random()`, no `Date.now()`. If `resolve`
  is not a pure function of its arguments, the published seed will not reproduce the
  outcome and the fairness proof is a lie.
- **`credits` is gross.** It is what the player receives, stake included — not their
  profit. A player absent from the list won nothing; the stake was already debited when
  the wager was accepted.
- **Handle degenerate tables.** What happens with one player at a game that needs two?
  `highCardDuel` returns the ante rather than swallowing it.
- **Ignore spots you do not offer.** `resolve` receives whatever was staked; filter to
  the spots your game defines.
- **Watch the rounding.** If your game splits a pot, distribute the remainder
  deterministically. Chips must never be created or destroyed — see `splitPot` in
  `highCardDuel.ts`.

## 2. Register it

In `packages/games/table-games/src/registry.ts`:

```ts
const DEFINITIONS: TableGameDefinition[] = [wheelOfFortune, highCardDuel, coinToss];
```

Export it from `index.ts` too.

## 3. Put a table in the world

In `packages/sim/src/world.ts`, add to `tablePositions`:

```ts
{ x: 0, z: -14, label: 'Coin Toss', gameId: 'coin-toss' },
```

`gameId` must match the definition's `id`. A world referencing an unregistered game
throws at construction — that is a build error, not something to limp through at
runtime.

## 4. Give the client its spots

In `apps/client/src/hud.js`, add to `spotsByGame`:

```js
'coin-toss': [
  { id: 'heads', label: 'Heads', hint: 'Even money' },
  { id: 'tails', label: 'Tails', hint: 'Even money' },
],
```

This duplication is deliberate for now — the client's hints are UI copy, not rules — but
if a third game arrives it is worth serving the spot list from the definition instead.

## 5. Test it

Every game needs at least:

```ts
it('is reproducible from its seed', () => {
  const wagers = [{ playerId: 'a', spotId: 'heads', amount: 100 }];
  expect(coinToss.resolve(wagers, createRng(7))).toEqual(coinToss.resolve(wagers, createRng(7)));
});
```

Then the money tests. For a house game, assert the actual return over a long run against
the designed return:

```ts
it('holds the advertised house edge over a long run', () => {
  // 200k rounds, so a future paytable edit cannot quietly make a bet profitable.
});
```

For a player-versus-player game, assert exact chip conservation across many seeds,
including pot sizes that do not divide evenly.

`wheelOfFortune.test.ts` and `highCardDuel.test.ts` are the two worked examples.

## Designing a paytable

Expected return per spot is `probability × multiplier`. Aim for 0.93–1.00.

Real casino wheels run an 11–24% house edge. That is fine when players are buying chips
and the building has rent to pay; it is miserable in a game between friends where a
session that bleeds everyone out in twenty minutes just ends the evening early. The
wheel keeps its edge in the 4–7% band and prices one spot at exactly true odds, so
there is a bet that rewards a player who has done the arithmetic.

A spot with expected return **above 1.0** is a money printer and will be found. The
200,000-spin test exists specifically to catch that before it ships.

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

## 4. The client needs nothing

There used to be a fourth file to edit — a `spotsByGame` map in `apps/client/src/hud.js`
that repeated every spot's label and hint. It drifted from the definitions the first time
somebody edited one and not the other, so the table's public state now carries its own
`displayName`, `spots`, `minWager`, `maxWager` and `bettingWindowMs`, and the HUD builds
the felt from those.

Write the definition, register it, put a table on the floor. The panel labels itself.

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

`wheelOfFortune.test.ts` and `highCardDuel.test.ts` are the two worked examples;
`roulette.test.ts` shows a paytable proven arithmetically rather than sampled, which is
better whenever the outcome space is small enough to enumerate.

## Betting windows, and table limits

Two fields on the definition decide how a round starts, and both default to the fairground
behaviour that suits a wheel.

`bettingClose` is `'timer'` unless you say otherwise: a clock runs for `bettingWindowMs`
and the wheel spins when it runs out. Set it to `'on-demand'` and the table instead waits
— no clock at all — until a player with chips on the felt calls the deal, at which point
`bettingWindowMs` becomes the _last call_ before the cards come out. Blackjack uses it.
The difference is whether the round happens _to_ the players or is run _by_ them, and card
games are the second kind.

`maxWager` caps one player's total exposure per round. Set it to `NO_TABLE_LIMIT` and the
only ceiling is what the player is actually holding — the runtime refuses anything the
ledger cannot cover regardless, and a real pit only posts a maximum because it is managing
a bankroll that has to stay solvent, which nothing here is.

## Games where the player actually plays

Everything above assumes the round is decided the moment bets close. Blackjack is not
like that: what you are paid depends on whether you hit, and the table has to stop and
wait for you. That needs a phase between "bets locked" and "paid".

A game that needs one implements `InteractiveTableGame` alongside `resolve` and hangs it
off the definition as `interactive`. `blackjack.ts` is the worked example. The runtime
then enters a `decisions` phase after betting, offers `actions()` to whoever `actor()`
names, and applies `apply()` when they choose — or when their clock runs out, in which
case it plays `autoAction()` for them.

Three rules matter more than the rest:

- **Only `begin` may touch the RNG.** Shuffle the shoe there and read cards off it
  afterwards. If `apply` or `settle` draws on randomness the seed did not fix, the round
  stops being replayable.
- **`apply` must be pure in (state, actionId).** Return a new state; never mutate the one
  you were handed. Blackjack shares one immutable shoe array across every state in a hand
  and moves only a cursor, which makes this cheap.
- **`resolve` still has to work.** Implement it as `begin` plus `autoAction` until the
  hand ends plus `settle` — one line in practice. It is what a table of players who all
  timed out would produce, and it gives the paytable test a pure function to measure.

### What the fairness proof becomes

A one-shot round is reproducible from its seed. An interactive one is reproducible from
**(seed, action log)** — the seed fixes the shoe before a single card is seen, and the
log fixes what was done with it. The runtime publishes both in `lastResult`, and
`replayInteractiveRound(definition, wagers, rng, actions)` recomputes the outcome from
them. Assert it against a live round; `blackjack.test.ts` does, and so does
`tableRuntime.test.ts`.

Anything a player must not see mid-hand — the dealer's hole card — is in the state but
must stay out of `view()`. The runtime only ever publishes `view()`, never the state.

### What to leave out

Blackjack has no splitting, and that is a scope decision rather than an oversight. A
split turns one seat into several simultaneous hands, and the turn order, the action
panel and the wire state are all built around one hand per player. Adding it is a real
change. If you are extending a game, check whether the shape you want fits the phase
machine before assuming it does.

## Designing a paytable

Expected return per spot is `probability × multiplier`. Aim for 0.93–1.00.

Real casino wheels run an 11–24% house edge. That is fine when players are buying chips
and the building has rent to pay; it is miserable in a game between friends where a
session that bleeds everyone out in twenty minutes just ends the evening early. The
wheel keeps its edge in the 4–7% band and prices one spot at exactly true odds, so
there is a bet that rewards a player who has done the arithmetic.

Where the real game is already reasonable, it is kept as it is — roulette's 2.70% and
baccarat's player and banker bets are untouched. Where it is not, it is softened and the
departure is written down: baccarat's tie pays 9 to 1 here rather than 8, because at 8 it
returns 85.6% and is a bad bet dressed as an exciting one.

Every spot on a felt should be worth taking. A spot that is quietly much worse than the
one beside it is a trap for whoever has not done the arithmetic, which is most people.

A spot with expected return **above 1.0** is a money printer and will be found. The
200,000-spin test exists specifically to catch that before it ships.

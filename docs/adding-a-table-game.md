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

Write the definition, register it, put a table on the floor. The bar labels itself.

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

`minWager` is a floor per bet, and the runtime enforces it without asking the game. For
anything that depends on the _rest_ of a player's bets, implement the optional
`checkWager({ existing, spotId, amount })` hook: return a string and the bet is refused
with that string as the reason, `null` to allow it. It runs before a single chip moves, so
a refusal costs the player nothing.

Blackjack uses `checkWager` for the one rule that cannot be expressed spot by spot — a
second box needs twice the minimum on _each_ box, a third needs three times — because
whether a bet on box 2 is legal depends entirely on what is sitting on box 1. Keep the
returned message worth reading; it is shown to the player verbatim.

A spot marked `derived: true` is one the _game_ puts chips on and a player never bets on
directly. Blackjack's insurance is the case: it is a real bet with its own odds and its
own pile on the felt, but it is offered mid-hand against the dealer's upcard, so buying it
during the betting window would be betting on a card nobody has seen. The runtime refuses
a wager on one and the client leaves it out of the betting buttons — but it stays in
`spots`, because it is a spot, and the chips that land on it have to have somewhere to be.

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

### Actions that change how many hands there are

A split is the awkward case, because it makes the list of hands grow _during_ the
decision phase. Three things follow from that, and all three are worth copying if you add
a game that does something similar.

**Give every hand a stable id.** Once two hands share a betting spot, neither the player
nor the spot identifies one. `BlackjackState` carries a `nextHandId` counter and hands out
`handId`s from it; the panel rows and the cards on the felt key off that. The counter is
part of the state rather than a module-level variable on purpose — a replay has to assign
the same ids, and anything outside the state is not covered by the seed.

**Charge through `stakeDelta` and `activeSpot`, never directly.** The runtime debits the
extra stake _before_ applying, and refuses the action if the player cannot cover it, so a
hand can never end up playing for chips that were never taken. `activeSpot` is what puts
those chips on the right pile: a split belongs to the box it came from, and without it the
chips land on whichever box the player bet on first. Name a spot the player has nothing on
yet and the runtime opens a wager there — which is how insurance reaches the felt at all.

**Keep anything secret secret for exactly as long as it has to be.** Blackjack's dealer
peek used to happen at the deal. Insurance is a bet on that very card, so the peek now
waits until every seat has answered, and `view()` gates both the dealer's cards and the
`dealerBlackjack` flag on the stage rather than on the value — a field only ever sent when
true announces itself by its absence. If a game of yours has a moment where knowing one
fact early is worth money, that is the moment to write a test against.

**Do not let `autoAction` choose it.** Anything that costs chips, or gives them away, is
the player's decision. The table plays for somebody who has walked away, and it must not
spend their money doing it. This also keeps the paytable honest — `resolve` plays every
hand through `autoAction`, so the measured expected return is the return of a table where
nobody is helping.

**A stage is cheaper than a phase.** Insurance is a whole extra round of questions asked
before the hand is played, and it needed no change to `TablePhase` at all: the game keeps
a `stage` in its own state, `actions` returns a different pair while it runs, and running
off the end of the hand list is what moves it on. The runtime only ever asks "who acts
next, and what may they do" — everything else is the game's business, which is the reason
`decisions` has stayed one phase rather than growing one per game.

One consequence worth knowing about: a player's turns are no longer contiguous. Somebody
who leaves during the insurance round still has a turn waiting in the play round, so the
runtime now plays for whoever is on the clock whenever that seat is empty, rather than
only draining the turns of the player who just stood up.

If you are extending a game, check whether the shape you want fits the phase machine
before assuming it does. Blackjack's turn order is an index into an array of hands, which
made splitting a `splice`; a game that needed several hands live _at once_ would not fit
so easily.

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

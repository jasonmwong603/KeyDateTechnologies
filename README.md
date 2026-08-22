# KeyDate Technologies — Game Development

This repository holds KeyDate Technologies' game development work, and nothing else.

The current title is **Beer Bets**: a cross-platform, real-time multiplayer game where
every player has their own independent camera — first or third person, MMO-style — and
walks a shared casino floor.

**The loop:** chips come from exactly one place, the tables. They buy exactly one thing,
drinks at the bar in the corner. And the more you drink, the blurrier the room gets —
so every round you buy makes the next one harder to win.

Chips are virtual, cannot be purchased, and have no cash value. See
[docs/responsible-play.md](docs/responsible-play.md) for what that means for the design.

---

## Play it

```bash
npm install
npm start
```

Open <http://localhost:8080/beer-bets/>. That is the whole setup — the client is a web page, so
**nothing installs on any device**: Windows, macOS, Linux, Android and iOS all just open
a browser.

On boot the server prints every address it can be reached on:

```
  Beer Bets — world server running at 30Hz

  On this computer:   http://localhost:8080/beer-bets/

  On your phone or another device (same Wi-Fi):
    http://192.168.1.24:8080/beer-bets/
```

**To play on your phone**, type that second address into its browser — both devices need
to be on the same Wi-Fi. **To play with people who are not**, deploy it: there is a
`render.yaml` and a `Dockerfile`, and it needs nothing but a port.

- **[docs/playing.md](docs/playing.md)** — full walkthrough, controls, firewall
  troubleshooting, home-screen install, and what to change first
- **[docs/deploying.md](docs/deploying.md)** — Render, Fly.io, Docker, plain VPS
- **[docs/distribution.md](docs/distribution.md)** — shipping it as an installable app
  with no URL for players to type

### Controls

|                | Computer                       | Phone or tablet    |
| -------------- | ------------------------------ | ------------------ |
| Move           | `W` `A` `S` `D`                | Drag on left half  |
| Look           | Mouse (click to capture)       | Drag on right half |
| Sprint / Jump  | `Shift` / `Space`              | Jump button        |
| Sit at a table | `E`                            | Use button         |
| Chat           | `Enter`                        | Tap the chat box   |
| Swap camera    | Third person button, top right | Same               |

### Commands

| Command                 | What it does                                             |
| ----------------------- | -------------------------------------------------------- |
| `npm start`             | Build, then run the world server on port 8080            |
| `npm run serve`         | Run without rebuilding (for deployment)                  |
| `npm run build`         | Compiles every package via TypeScript project references |
| `npm run bundle:client` | Self-contained client payload for packaging as an app    |
| `npm test`              | Unit suite, against TypeScript source                    |
| `npm run test:client`   | Drives a real browser — desktop and emulated phone       |
| `npm run coverage`      | Test suite with a coverage report                        |
| `npm run format`        | Formats with Prettier                                    |

---

## Architecture

The server is authoritative. Clients send **inputs and intents**, never state —
anything a client asserts about its position, its chip balance or a wager outcome is
discarded.

```
                  ┌──────────────────────────────────────────┐
                  │            apps/server                    │
   input frames   │  ┌────────────┐    ┌──────────────────┐  │
  ──────────────▶ │  │  Gateway   │───▶│  WorldInstance   │  │
                  │  │ parse,     │    │  30Hz tick loop  │  │
                  │  │ rate-limit │    │  ChipLedger      │  │
   snapshots      │  └────────────┘    │  TableRuntime ×4 │  │
  ◀────────────── │                    └──────────────────┘  │
                  └──────────────────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
             packages/sim    packages/netcode  packages/games/*
            movement, world   prediction,       wagering rules
            collision         interpolation,    modules
                    ▲         commit-reveal
                    │
                    └──── the same compiled code runs in the browser ────┐
                                                                          │
                  ┌───────────────────────────────────────────────────────┴──┐
                  │            apps/client (no bundler, plain ESM)            │
                  │  predicts locally with packages/sim, reconciles against   │
                  │  server snapshots, interpolates everyone else             │
                  └──────────────────────────────────────────────────────────┘
```

### Why it is a monorepo

`packages/sim` contains the movement simulation, and **both sides run it**. The server
runs it to decide where a player actually is; the client runs the identical code to
predict its own movement without waiting a network round trip, then replays
unacknowledged inputs when a correction arrives.

If those two ever diverge — a stray `Math.random()`, a dependency on framerate, or two
copies of the code drifting apart — the symptom is rubber-banding. That is why the
client ships as plain ES modules with **no bundler**: the browser loads the exact same
compiled `dist/` output the server imports, resolved through an import map in
`apps/client/index.html`. There is physically one copy.

### Packages

| Package                      | Responsibility                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/protocol`          | Wire messages, session codes, and validation of untrusted client input                             |
| `packages/netcode`           | Fixed timestep, client prediction, entity interpolation, seeded RNG, commit–reveal, delta encoding |
| `packages/sim`               | Deterministic world: vector math, AABB collision, movement, the casino floor                       |
| `packages/games/table-games` | Wagering rules modules and the table phase machine                                                 |
| `apps/server`                | Authoritative server: tick loop, replication, chip ledger, WebSocket gateway                       |
| `apps/client`                | 3D client: Three.js renderer, both camera modes, prediction, HUD                                   |

Everything a rules module needs is pure: given the wagers on the table and a seeded
RNG, it returns the outcome and who gets paid. It never touches sockets, clocks or
balances — which is exactly what makes a round replayable from its seed.

Further reading:

- [docs/architecture.md](docs/architecture.md) — the tick loop, replication, and why each piece sits where it does
- [docs/netcode.md](docs/netcode.md) — prediction, reconciliation and interpolation in detail
- [docs/protocol.md](docs/protocol.md) — every message on the wire
- [docs/adding-a-table-game.md](docs/adding-a-table-game.md) — how to add a new wagering game
- [docs/responsible-play.md](docs/responsible-play.md) — the virtual-chip design rules

---

## Provable fairness

A player who suspects the server picked a losing outcome _after_ seeing the bets has no
way to check — so every round runs as a commit–reveal:

1. **Before betting opens**, the server picks a secret seed and publishes a digest of
   it. The digest reveals nothing about the seed.
2. **Players bet.** The server can no longer change the seed without breaking the
   digest it already published.
3. **After the round resolves**, the server reveals the seed. The client hashes it,
   checks it against the commitment, and replays the outcome.

The client verifies this automatically and shows the result under the table panel. A
mismatch is reported in red.

> **Before this handles anything a player would be upset to lose**, replace the digest
> in `packages/netcode/src/commitment.ts` with SHA-256. It is currently an iterated
> FNV-1a — a real protocol with a verifiable transcript, but not collision-resistant
> against a motivated attacker. The function signature does not change.

---

## The games

Five games across six tables. Every spot on every felt returns between 93% and 100% of
what is staked on it, and a test fails if one ever climbs above 100% or drops below 93% —
a spot with a positive expected return is a money printer and will be found.

**Blackjack** — two tables, and the only game where you actually play rather than bet.
Eight-deck shoe on a continuous shuffler, dealer stands on all 17, blackjack pays 3 to 2,
double down on any first two cards, and up to three boxes each.
Bet any whole number from 10 up to your entire stack;
there is no table maximum, because the house here is not a bankroll anybody has to keep
solvent. And there is no betting clock — the table waits until a player with chips down
calls the deal, then gives everyone ten seconds of last call.

Playing more than one hand needs no rule of its own. Each box is a separate betting spot
that has to meet the table minimum on its own, so two hands cost at least twice the
minimum and three at least three times — the rule falls out of the spots rather than
being enforced on top of them. It is not splitting: a split reacts to a pair already
dealt, where boxes are chosen and paid for before a card comes out.

The shoe is a **continuous shuffling machine**. Every round is dealt from a freshly
shuffled eight-deck shoe, exactly as a CSM behaves — cards go back in the moment the hand
is over. That kills card counting outright, which matters more here than in a real pit,
since the seed for every round is published afterwards anyway.

Cards are dealt onto the felt itself, not just into the HUD: they come out of the shoe
one at a time, turn face up as they cross the table, and settle in front of whoever they
belong to. The dealer's hole card stays face down, on the table, until the hand ends.
Bets sit beside them as chip stacks — red 5, green 25, black 100, purple 500, gold 1000,
and a white 1 for the change, because a bet is any whole number and a stack that does not
add up to it would be worse than no stack. No splitting, no insurance, no surrender: a split
turns one seat into several simultaneous hands, which the turn order and the wire state
are not built for, and half-implementing it is worse than leaving it out.

It is also the reason the table phase machine grew a `decisions` phase — see
[Fairness with a decision in it](#fairness-with-a-decision-in-it) below.

**Roulette** — European single zero. One green pocket, not two: the American double-zero
wheel doubles the house edge to 5.26% for no extra gameplay. Every spot is priced at
exactly 36/37 — red/black, odd/even, halves, dozens, and the zero straight up at 35 to 1
all return 0.973. There is no trap bet and no secretly-better bet; the choice is variance,
not value.

**Baccarat** — punto banco, eight decks, with the full third-card drawing table (the part
everyone gets wrong from memory, so it is asserted cell by cell in the tests). Banker pays
0.95 to 1 after commission; a tie pays 9 to 1 and pushes the player and banker bets.

That 9 is the one deliberate departure from a real pit. At the usual 8 to 1 the tie
returns 85.6% and is a bad bet dressed up as an exciting one; at 9 to 1 it returns 95.2%
and sits alongside everything else on the felt.

**Wheel of Fortune** — the house game. A 54-segment wheel; stake on a multiplier and
you are paid it if the wheel stops there. The paytable is far kinder than a real Big
Six wheel (which runs an 11–24% house edge): edges here are ~4–7%, and the 9x spot is
priced at exactly true odds, so there is one bet that rewards knowing the maths.

| Spot | Segments | Pays | Expected return |
| ---- | -------- | ---- | --------------- |
| 2x   | 26 / 54  | 1:1  | 0.963           |
| 3x   | 17 / 54  | 2:1  | 0.944           |
| 9x   | 6 / 54   | 8:1  | **1.000**       |
| 50x  | 1 / 54   | 49:1 | 0.926           |
| BUST | 4 / 54   | —    | pays nobody     |

**High Card Duel** — the social game. Everyone antes into one pot and gets one card;
highest takes it, ties split it. There is no house: every chip staked is paid back out.
The wheel is where chips slowly drain, the duel is where they change hands.

### Fairness with a decision in it

Every other game here is decided the instant bets close, so the round is reproducible
from one number: the seed the server committed to before a single chip was placed.

Blackjack breaks that, because what you are paid depends on whether you hit. So the proof
grows by exactly one term rather than being abandoned. The seed fixes the **shoe** — dealt
and committed to before anybody sees a card — and the published **action log** fixes what
was done with it. `replayInteractiveRound(definition, wagers, rng, actions)` recomputes
the outcome from the two, and the client runs it.

Only `begin` may touch the RNG. Every step after it reads cards off a shoe that was
already shuffled and already committed to, so no later step can introduce randomness the
seed does not account for. The dealer's hole card is in that state the whole time and
never leaves the server until the hand is over.

---

## Testing

```bash
npm test
```

The unit suite runs against TypeScript source rather than compiled output, so it needs
no build step and can never pass against stale `dist/`.

```bash
npm run test:client
```

drives a real Chromium against a real server, on a desktop viewport and an emulated
phone: it joins, walks with the keyboard, walks by dragging a touch screen, opens a
table, places a bet, and asserts no page errors accumulated while playing. It writes
screenshots to `.smoke/`.

The suite concentrates on the things that are expensive to get wrong:

- **Determinism** — identical inputs from identical state produce bit-for-bit identical
  output, because client prediction and server authority must never disagree at all.
- **Adversarial input** — every validation test is written from the attacker's side.
  A modified client can send any JSON; anything that slips past `parseClientMessage`
  is a live exploit.
- **Chip conservation** — the zero-house-edge game must return every chip staked,
  exactly, with rounding never creating or destroying one.
- **Paytable drift** — a 200,000-spin simulation asserts each spot's actual return
  against its designed value, so a future edit cannot quietly make a bet a money
  printer.
- **The client actually working** — headless logic tests cannot see a camera pointed at
  a wall, a HUD panel swallowing every touch, or a render loop throwing each frame. All
  three were real bugs here, and all three are what the browser test now covers.

---

## Deployment

The server serves the client and the WebSocket endpoint on one port, so there is one
service to deploy, no CORS, and no separate origin to configure.

| Variable                  | Default   | Meaning                                               |
| ------------------------- | --------- | ----------------------------------------------------- |
| `PORT`                    | `8080`    | HTTP + WebSocket port                                 |
| `HOST`                    | `0.0.0.0` | Bind address                                          |
| `MAX_PLAYERS_PER_WORLD`   | `32`      | Players per world instance                            |
| `STARTING_CHIPS`          | `2500`    | Opening stack                                         |
| `BAILOUT_CHIPS`           | `500`     | Granted to a player at exactly zero chips             |
| `RESUME_GRACE_MS`         | `90000`   | How long a dropped player's avatar and chips are held |
| `SOCKET_TIMEOUT_MS`       | `30000`   | Idle socket cull                                      |
| `MAX_MESSAGES_PER_SECOND` | `120`     | Per-socket rate limit                                 |

`GET /healthz` reports world and player counts.

---

## Status

Working today: authoritative 30Hz simulation, client prediction and reconciliation,
entity interpolation, delta-compressed snapshots, both camera modes, desktop and touch
input, six tables across five games including blackjack with real hit/stand/double
decisions, commit–reveal fairness, chip ledger with bailouts,
resume-after-disconnect, local and table chat.

Installs to a phone home screen as a full-screen app.

Not built yet: persistence (a world's chips live in memory and reset when it empties),
interest management (everyone replicates everyone, which is fine for 32 players and not
for 500), binary protocol encoding, voice, and any second room to walk to.

See [docs/roadmap.md](docs/roadmap.md).

## Licence

MIT — see [LICENSE](LICENSE).

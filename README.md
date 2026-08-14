# KeyDate Technologies — Game Development

This repository holds KeyDate Technologies' game development work, and nothing else.

The current title is **The Keydate Floor**: a cross-platform, real-time multiplayer
social casino world. Every player gets their own independent camera — first or third
person, MMO-style — walks around a shared floor, sits down at wagering tables, and
plays against the house or against their friends.

Chips are virtual, cannot be purchased, and have no cash value. See
[docs/responsible-play.md](docs/responsible-play.md) for what that means for the design.

---

## Quick start

```bash
npm install
npm run build
npm start
```

Then open <http://localhost:8080>. Open it again in a second tab, window, or on your
phone on the same network to play with someone else — every screen is an independent
client with its own camera.

| Command            | What it does                                             |
| ------------------ | -------------------------------------------------------- |
| `npm run build`    | Compiles every package via TypeScript project references |
| `npm start`        | Runs the world server on port 8080 (build first)         |
| `npm run dev`      | Build, then run                                          |
| `npm test`         | Runs the full test suite against TypeScript source       |
| `npm run coverage` | Test suite with a coverage report                        |
| `npm run format`   | Formats with Prettier                                    |

### Controls

|                | Desktop                        | Touch                |
| -------------- | ------------------------------ | -------------------- |
| Move           | `W` `A` `S` `D`                | Left half of screen  |
| Look           | Mouse (click to capture)       | Right half of screen |
| Sprint / Jump  | `Shift` / `Space`              | Jump button          |
| Sit at a table | `E`                            | Use button           |
| Chat           | `Enter`                        | Tap the chat box     |
| Swap camera    | Third person button, top right | Same                 |

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

---

## Testing

```bash
npm test
```

153 tests run against TypeScript source rather than compiled output, so the suite needs
no build step and can never pass against stale `dist/`.

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
input, four tables across two games, commit–reveal fairness, chip ledger with bailouts,
resume-after-disconnect, local and table chat.

Not built yet: persistence (a world's chips live in memory and reset when it empties),
interest management (everyone replicates everyone, which is fine for 32 players and not
for 500), binary protocol encoding, voice, and any second room to walk to.

See [docs/roadmap.md](docs/roadmap.md).

## Licence

MIT — see [LICENSE](LICENSE).

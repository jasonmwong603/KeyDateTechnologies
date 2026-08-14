# Repository guide

This repository holds KeyDate Technologies' game development work, and nothing else.
Current title: **The Keydate Floor** — a cross-platform, real-time multiplayer social
casino world where every player has their own independent camera (first or third
person), walks a shared floor, and wagers virtual chips at tables.

## Commands

```bash
npm install
npm run build          # tsc project references across all packages
npm test               # vitest, runs against TS source (no build needed)
npm run test:client    # drives real Chromium: desktop + emulated phone
npm start              # build, then server on :8080 (client + WebSocket)
npm run serve          # run without rebuilding (deployment)
npm run format:check   # prettier
```

## Layout

| Path                         | What                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `packages/protocol`          | Wire messages, session codes, validation of untrusted input                  |
| `packages/netcode`           | Fixed timestep, prediction, interpolation, seeded RNG, commit–reveal, deltas |
| `packages/sim`               | Deterministic movement, collision, world definition                          |
| `packages/games/table-games` | Wagering rules modules + table phase machine                                 |
| `apps/server`                | Authoritative server: gateway, world instance, chip ledger                   |
| `apps/client`                | Three.js client, plain ESM, no bundler                                       |

## Invariants — do not break these

1. **The server is authoritative.** Clients send inputs and intents, never state.
2. **`packages/sim` must stay deterministic.** Both the server and every client's
   prediction run it. No `Math.random()`, no `Date.now()`, no framerate dependence.
   Divergence shows up as rubber-banding.
3. **The client has no bundler on purpose.** It loads the same compiled `dist/` output
   the server imports, via the import map in `apps/client/index.html`. Adding a bundler
   risks a second, drifting copy of the simulation.
4. **`ChipLedger` is the only writer of balances.** `TableRuntime` asks its host to
   debit and reports credits back.
5. **Game `resolve()` must be pure** in (wagers, rng). Otherwise the published seed no
   longer reproduces the outcome and the fairness proof breaks.
6. **Validate every new message type** in `parseClientMessage`, with adversarial tests.
7. **No real money.** See `docs/responsible-play.md` — these are hard lines.

## Docs

`docs/playing.md` (how to run it, phones, controls) · `docs/deploying.md` ·
`docs/architecture.md` (tick loop, replication) · `docs/netcode.md` (prediction,
interpolation) · `docs/protocol.md` (every message) · `docs/adding-a-table-game.md` ·
`docs/responsible-play.md` · `docs/roadmap.md` (including known limitations).

## Testing notes

Tests alias `@keydate/*` to TypeScript source via `vitest.config.ts`, so the suite never
passes against stale `dist/`. The suite concentrates on determinism, adversarial client
input, exact chip conservation, and paytable drift (a 200k-spin expected-return test).

`apps/client` is covered by `npm run test:client`, which drives a real browser against a
real server on both a desktop viewport and an emulated phone. Whole-client breakage that
headless tests cannot see — a mirrored camera, a render loop throwing every frame, a HUD
overlay swallowing touches — has to be caught there. It asserts no page errors at the
_end_ of play, not just after load; checking only at startup is how a camera that threw
on every frame once passed as healthy.

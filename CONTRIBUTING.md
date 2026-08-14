# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

Node 20.10+ (`.nvmrc` pins 22).

## Before you push

```bash
npm run build         # type-checks every package
npm test              # 153 tests, no build needed
npm run format:check
```

CI runs exactly these.

## The rules that matter

**Never break simulation determinism.** `packages/sim` is run by both the server and
every client's prediction. Anything non-deterministic in there — `Math.random()`,
`Date.now()`, a dependency on framerate or iteration order over a `Set` — presents to
players as rubber-banding, and it will not be obvious that your change caused it.

If you touch movement, run the determinism test and mean it:

```ts
it('is deterministic: identical inputs from identical state give identical output');
```

Bit-for-bit equality, not `toBeCloseTo`.

**Never trust the client.** Anything arriving on a socket is hostile until
`parseClientMessage` says otherwise. If you add a message type, add its validation and
its adversarial tests in the same commit. Range, ownership and affordability checks
belong in `WorldInstance`/`TableRuntime`, where world state is available.

**Never move chips outside the ledger.** `ChipLedger` is the only writer. `TableRuntime`
asks its host to debit and reports credits back; keep it that way, or "balances never go
negative" stops being enforceable in one place.

**Keep rules modules pure.** A game's `resolve` must be a pure function of (wagers, rng).
Reach for a clock or a socket in there and the published seed stops reproducing the
outcome, which silently invalidates the fairness proof.

**Shared constants stay shared.** Movement tuning in `packages/sim/src/constants.ts` is
part of the network contract, not just feel. Changing one value without redeploying both
sides causes desync.

## Style

Prettier decides formatting; do not argue with it. Beyond that:

- Comments explain **why**, not what. The code already says what.
- Prefer a named constant with a comment over a magic number. If you cannot explain why
  it is 0.75, it should not be 0.75.
- Small, pure functions where the domain allows. Most of this codebase is testable
  because most of it does not do I/O.

## Tests

Tests run against TypeScript source via aliases in `vitest.config.ts`, so there is no
build step and the suite can never pass against stale `dist/`.

Write tests that would catch a real regression:

- Validation tests from the attacker's side — what does a modified client send?
- Money tests that assert exact conservation where there is no house edge, and measured
  return over a long run where there is.
- Netcode tests that cover the awkward cases: packet loss, reordering, a buffer running
  dry, a client reconnecting with a stale baseline.

## Commits and PRs

Present tense, explain the why in the body if it is not obvious. One logical change per
PR. If you found a bug while building something else, fix it in its own commit so it can
be reverted independently.

If you change the paytable, say what the new expected return is and let the 200k-spin
test confirm it.

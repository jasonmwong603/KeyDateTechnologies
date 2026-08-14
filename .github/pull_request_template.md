## What this changes

<!-- One or two sentences. The diff shows what; explain why. -->

## Why

<!-- What problem does this solve? Link an issue if there is one. -->

## Checklist

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] `npm run format:check` passes

## Risk areas

Tick anything this touches, and say how you checked it:

- [ ] **Simulation determinism** (`packages/sim`) — server and client prediction must
      agree bit-for-bit
- [ ] **Client input validation** (`packages/protocol`) — new message types need
      adversarial tests
- [ ] **Chip movement** (`ChipLedger`, `TableRuntime`) — balances must not go negative,
      chips must not be created
- [ ] **Paytable or game rules** — state the new expected return per spot
- [ ] **Shared constants** — these are a network contract, not just feel
- [ ] None of the above

## How this was tested

<!-- Beyond the suite: did you actually play it? With how many clients? -->

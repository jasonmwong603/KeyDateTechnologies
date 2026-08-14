# Security

## Reporting

Open a private security advisory on the repository, or contact the maintainers
directly. Please do not open a public issue for anything exploitable.

## What counts as a vulnerability here

This is a game with an in-world economy, so the interesting attacks are economic and
positional rather than the usual web ones:

- **Chip creation.** Any path that increases a player's balance without a corresponding
  debit or a legitimate payout.
- **Outcome manipulation.** Anything that lets a player learn or influence a round's
  result before betting closes, or that breaks the commit–reveal transcript.
- **Movement exploits.** Speed hacks, wall clipping, interacting from out of range —
  anything where the client's claim overrides the server's simulation.
- **Impersonation.** Rendering as another player, in chat or on a nameplate.
- **Denial of service.** Crashing or stalling a world instance, or making one client's
  traffic degrade everyone else's.

## Known limitation

The commit–reveal digest in `packages/netcode/src/commitment.ts` is an iterated FNV-1a,
not a cryptographic hash. It provides a real protocol with a verifiable transcript, but
it is **not collision-resistant**: an attacker with server access could search for a
colliding seed.

This is documented rather than hidden because the UI presents rounds as verified. It
must be replaced with SHA-256 before this is played by anyone outside a trusted group.

## Design notes

- The server is authoritative for all state. Clients send inputs and intents only.
- `parseClientMessage` validates every inbound frame before it reaches the simulation.
- Sockets are rate limited per second and payload-capped at 16KB.
- Static file mounts reject path traversal, including percent-encoded attempts.
- `ChipLedger` is the sole writer of balances and refuses partial debits.

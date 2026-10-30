# Beer Bets — shelved

A cross-platform, real-time multiplayer game where every player has their own
independent camera — first or third person — and walks a shared casino floor. Chips come
only from the tables; they buy only drinks at the corner bar; and drinking blurs your
vision, so every round you buy makes the next harder to win.

It was complete and passing its tests when it was put down, including blackjack with
splits, surrender and insurance, dealt-card animation, and a browser-driven client suite.
Nothing is wrong with it. The repository simply turned to magic apps.

## It does not build from here

Its TypeScript project references, npm workspaces and deploy files moved into this
folder with it, and the paths inside them still assume the repository root. Nothing was
edited to make the move look tidy, because rewriting a few hundred paths in code nobody
is changing is how you introduce a bug into something that currently works.

## Bringing it back

```bash
git checkout beer-bets-shelved -- .
```

That restores the whole repository to the commit where the game was its subject — the
layout, the root `package.json` with its workspaces, the TypeScript build, the CI, all of
it. The tag is annotated; `git show beer-bets-shelved` says when and why.

To take only part of it, the files here are the files as they were, just one directory
deeper.

## What was true of it

The original guide is in `../../CLAUDE.md` as of the tag, and its invariants were real:
the server is authoritative, `packages/sim` stays deterministic, `ChipLedger` is the only
writer of balances, game `resolve()` is pure in (wagers, rng), every message type is
validated in `parseClientMessage`, and there is no real money — chips cannot be
purchased, cashed out or traded, which is a hard line and documented in
`docs/responsible-play.md`.

Those rules apply to this folder and to nothing else in the repository.

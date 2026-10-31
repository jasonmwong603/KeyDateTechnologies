# Repository guide

This repository holds KeyDate Technologies' **magic apps**: props that run on a phone,
on stage, in front of people. One app per trick.

The game that used to live here, **Beer Bets**, is shelved — see the bottom of this file.
Do not develop it, and do not let it set the conventions for anything here.

## What a magic app is, and what follows from it

A prop is not a web app that happens to be used on stage. The differences drive almost
every decision in here:

- **It has to work with no signal.** Rooms have no bars. Every app installs a service
  worker so it runs from the phone, and is tested that way.
- **It has to survive being picked up.** Clockwork is a working calculator first. If an
  ordinary `12 + 3 × 4` behaves oddly, the prop is blown before it is used.
- **Nothing may say what it is.** The URL is dull on purpose, the health check does not
  name the apps, and only `public/` is served — a README that explains the method must
  never be reachable over HTTP.
- **Failures must be loud in testing and impossible on stage.** A wrong number that
  looks right is the worst outcome here, because the first person to notice is in the
  audience.

## Commands

```bash
npm install
npm start              # serves every app on :8080 under its own slug
npm test               # host tests, then each app's arithmetic
npm run check          # the arithmetic alone
npm run test:browser   # drives real Chromium against an app, phone-sized
npm run format:check
```

## Layout

| Path                    | What                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `apps/<trick>/public`   | **Everything the world can see.** Served at that app's slug. |
| `apps/<trick>`          | Its README (the method), checks, tooling. Never served.      |
| `apps/<trick>/app.json` | Name and slug. The whole registration.                       |
| `host/`                 | Static host: discovers apps, serves `public/`, nothing else. |
| `shelved/beer-bets/`    | The shelved game. Leave it alone.                            |

## Branches

**One branch per trick**, named `claude/<trick>-<topic>` — `claude/clockwork-landscape`,
`claude/newtrick-scaffold`. A new trick starts a new branch. Never push to `main`
without being asked.

## Invariants — do not break these

1. **Only `public/` is published.** The boundary is a directory, not a list of
   exclusions, so it cannot rot as files are added. `host/apps.mjs` owns it and a test
   pins it. A README in an app folder is the complete method of a trick.
2. **Nothing advertises what is hosted.** No index page, no directory listing, no app
   names in `/healthz`. The bare domain is a flat 404.
3. **A trick's arithmetic must be exact, and proved.** Each app ships a `check.mjs` that
   verifies its claim across the whole input space. If it reports less than 100%, the
   room's calculators disagree with the phone and the trick is dead. It is the one test
   that cannot be allowed to fail.
4. **The audience's choices must be real.** Nothing is forced, nobody is steered. The
   correction hides in what the performer controls, never in the spectators' freedom.
5. **Test in a real browser, on a phone viewport.** Whole-app breakage — a dead keypad,
   an overlay that never lifts, digits clipped off the side — is invisible to headless
   checks. Assert at the _end_ of a routine, not just after load.
6. **Every app works offline, and updates anyway.** Cache-first for assets; the page
   itself is fetched fresh when the network answers quickly. A cache that cannot be got
   out of the way means a fixed bug stays on a phone for days.
7. **Mounts are relative, slugs are not hard-coded.** Every URL inside an app is `./`,
   so it works at any slug. The bare mount redirects to its trailing slash — without
   that, relative URLs resolve against the domain root and the app silently loses its
   service worker and manifest.
8. **A stray touch must never change a committed number.** The audience cannot see the
   screen. Anything they can do while holding the phone has to be harmless.

## Adding a trick

Make `apps/<name>/` with an `app.json` and a `public/`. That is the registration — the
host finds it, and no shared code changes. Give it a `check.mjs` proving its arithmetic
and a `smoke.mjs` driving a browser. Branch first.

### Folders are codenames

**The performer supplies the folder name, and it is a codename, not a description.**
`apps/heron/`, not `apps/mindreader/`. Ask for one rather than inventing a descriptive
name, and if you must propose one, propose something that says nothing: a bird, a
street, a month.

The address then defaults to the folder name with nothing configured — `apps/heron/` is
served at `play.keydate.ca/heron` — and a codename is already dull enough to be the
address, so most apps need no `slug` at all. Set one only when the codename happens to
read as something (or, as with `clockwork` → `calc`, when the address should look like a
category of ordinary app rather than a word).

What a trick actually _is_ belongs in that folder's own README and nowhere above it. The
root README lists codenames and addresses; it does not describe effects. One file that
maps every codename to what it does would undo the point of having codenames.

Addresses must be lower-case letters, digits and hyphens. Duplicates, reserved routes
and anything needing URL-escaping refuse to start — an app that is silently unreachable
would be found out on stage.

### What a codename does and does not buy

It protects against the glance: the address is on screen the whole time you install the
app, and again whenever you hand someone the phone. `/mindreader` announces what is
coming; `/heron` does not.

It protects against nothing else. Every app README, every commit message and every line
of this file are readable by anyone who can read the repository, and no naming scheme
changes that. **Repository visibility is therefore the control that matters**, and
codenames are what you do on top of it, not instead of it.

Check it before assuming either way — it is one setting and it can change without
anything in here being updated:

```bash
gh repo view --json visibility -q .visibility   # or look at the badge on GitHub
```

Private changes nothing about how the apps run. They are self-contained static files
with no dependency on the repository being readable, and the served site stays public
regardless — a private repository is not a private app.

## The shelved game

`shelved/beer-bets/` is a real-time multiplayer casino game, complete and passing its
tests when it was put down. It is kept for when it is picked back up; it does not build
from where it sits, because its TypeScript config, workspaces and deploy files moved
with it.

To bring it back: `git checkout claude/gaming-repo-setup-mf80i9 -- .` restores the
repository as it was — that branch's tip, `f8164e6`, is the last commit where the game
was the subject. See `shelved/beer-bets/README.md`. Its design rules — authoritative server,
deterministic sim, the chip ledger, no real money — apply to it and to nothing else
here.
